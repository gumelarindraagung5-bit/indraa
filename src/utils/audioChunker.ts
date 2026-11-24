export interface AudioChunkSpec {
  chunkIndex: number; // 0-based
  startOffset: number; // seconds
  endOffset: number; // seconds
  duration: number; // seconds
}

export interface UncoveredRange {
  chunkIndex: number;
  start: number;
  end: number;
  reason: string;
}

export interface CoverageReport {
  totalDuration: number;
  coveredSeconds: number;
  percent: number;
  isComplete: boolean;
  uncoveredRanges: UncoveredRange[];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Pure silence-aware audio splitter:
 * Splits audio into ~60s chunks by searching for the lowest-RMS (quietest) 80ms frame
 * within +/- `searchWindowSec` of each 60s target mark so words are never cut mid-speech.
 */
export function findSilenceSplitPoints(
  monoSamples: Float32Array,
  sampleRate: number,
  targetChunkSec = 60,
  searchWindowSec = 8
): AudioChunkSpec[] {
  const totalDuration = round2(monoSamples.length / Math.max(1, sampleRate));
  if (totalDuration <= 0) {
    return [];
  }

  // If audio is short enough to fit comfortably in one ~60s chunk, don't split
  if (totalDuration <= targetChunkSec + searchWindowSec) {
    return [
      {
        chunkIndex: 0,
        startOffset: 0,
        endOffset: totalDuration,
        duration: totalDuration,
      },
    ];
  }

  const splitTimes: number[] = [0];
  let cursor = 0;
  const minRemainingSec = 18; // avoid tiny trailing stub chunk
  const frameSamples = Math.max(1, Math.floor(sampleRate * 0.08)); // 80ms RMS window
  const stepSamples = Math.max(1, Math.floor(sampleRate * 0.02)); // 20ms hop

  while (totalDuration - cursor > targetChunkSec + searchWindowSec) {
    const idealCut = cursor + targetChunkSec;
    const minSearchSec = Math.max(cursor + 20, idealCut - searchWindowSec);
    const maxSearchSec = Math.min(totalDuration - minRemainingSec, idealCut + searchWindowSec);

    if (maxSearchSec <= minSearchSec) {
      break;
    }

    const startIdx = Math.floor(minSearchSec * sampleRate);
    const endIdx = Math.min(monoSamples.length - frameSamples, Math.floor(maxSearchSec * sampleRate));

    let bestSampleIdx = Math.floor(idealCut * sampleRate);
    let minRms = Number.POSITIVE_INFINITY;

    for (let i = startIdx; i <= endIdx; i += stepSamples) {
      let sumSq = 0;
      const limit = Math.min(monoSamples.length, i + frameSamples);
      const count = limit - i;
      // Subsample inside frame for speed if high sample rate
      const stride = count > 256 ? 4 : 1;
      let sampled = 0;
      for (let j = i; j < limit; j += stride) {
        const v = monoSamples[j];
        sumSq += v * v;
        sampled++;
      }
      const rms = Math.sqrt(sumSq / Math.max(1, sampled));
      // Tie-break slightly in favor of silence closer to idealCut
      const distPenalty = Math.abs(i / sampleRate - idealCut) * 0.0002;
      const score = rms + distPenalty;
      if (score < minRms) {
        minRms = score;
        bestSampleIdx = i + Math.floor(frameSamples / 2);
      }
    }

    const cutSec = round2(
      Math.max(minSearchSec, Math.min(maxSearchSec, bestSampleIdx / sampleRate))
    );
    splitTimes.push(cutSec);
    cursor = cutSec;
  }

  splitTimes.push(totalDuration);

  const chunks: AudioChunkSpec[] = [];
  for (let i = 0; i < splitTimes.length - 1; i++) {
    const startOffset = splitTimes[i];
    const endOffset = splitTimes[i + 1];
    chunks.push({
      chunkIndex: i,
      startOffset,
      endOffset,
      duration: round2(endOffset - startOffset),
    });
  }

  return chunks;
}

/**
 * Mixes multi-channel AudioBuffer into a single mono Float32Array.
 */
export function extractMonoChannel(audioBuffer: AudioBuffer): Float32Array {
  const length = audioBuffer.length;
  const numChannels = audioBuffer.numberOfChannels;
  if (numChannels === 1) {
    return audioBuffer.getChannelData(0);
  }
  const mono = new Float32Array(length);
  for (let ch = 0; ch < numChannels; ch++) {
    const data = audioBuffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      mono[i] += data[i] / numChannels;
    }
  }
  return mono;
}

/**
 * Encodes a time slice [startSec, endSec] of mono PCM samples into a compact
 * 16kHz mono 16-bit PCM WAV Blob (~1.9 MB per 60s — fast upload & high speech clarity).
 */
export function encodeMonoSliceToWavBlob(
  monoSamples: Float32Array,
  sourceSampleRate: number,
  startSec: number,
  endSec: number,
  targetSampleRate = 16000
): Blob {
  const startSample = Math.max(0, Math.floor(startSec * sourceSampleRate));
  const endSample = Math.min(monoSamples.length, Math.ceil(endSec * sourceSampleRate));
  const srcLen = Math.max(1, endSample - startSample);

  const outRate = Math.min(sourceSampleRate, targetSampleRate);
  const ratio = sourceSampleRate / outRate;
  const outLen = Math.max(1, Math.floor(srcLen / ratio));

  const buffer = new ArrayBuffer(44 + outLen * 2);
  const view = new DataView(buffer);

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) {
      view.setUint8(offset + i, s.charCodeAt(i));
    }
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + outLen * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, outRate, true);
  view.setUint32(28, outRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, outLen * 2, true);

  let offset = 44;
  for (let i = 0; i < outLen; i++) {
    const srcPos = startSample + i * ratio;
    const idx0 = Math.floor(srcPos);
    const idx1 = Math.min(endSample - 1, idx0 + 1);
    const frac = srcPos - idx0;
    const sample = monoSamples[idx0] * (1 - frac) + monoSamples[idx1] * frac;
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

/**
 * Fast direct WAV PCM parser for 16-bit/8-bit uncompressed WAV files.
 */
function tryDecodeWavPcmBuffer(
  arrayBuffer: ArrayBuffer
): { duration: number; sampleRate: number; monoSamples: Float32Array } | null {
  try {
    if (arrayBuffer.byteLength < 44) return null;
    const view = new DataView(arrayBuffer);
    const riff =
      String.fromCharCode(view.getUint8(0)) +
      String.fromCharCode(view.getUint8(1)) +
      String.fromCharCode(view.getUint8(2)) +
      String.fromCharCode(view.getUint8(3));
    const wave =
      String.fromCharCode(view.getUint8(8)) +
      String.fromCharCode(view.getUint8(9)) +
      String.fromCharCode(view.getUint8(10)) +
      String.fromCharCode(view.getUint8(11));
    if (riff !== 'RIFF' || wave !== 'WAVE') return null;

    const audioFormat = view.getUint16(20, true);
    const numChannels = Math.max(1, view.getUint16(22, true));
    const sampleRate = Math.max(8000, view.getUint32(24, true));
    const bitsPerSample = view.getUint16(34, true);
    if (audioFormat !== 1 || (bitsPerSample !== 16 && bitsPerSample !== 8)) return null;

    let offset = 12;
    while (offset + 8 <= arrayBuffer.byteLength) {
      const id =
        String.fromCharCode(view.getUint8(offset)) +
        String.fromCharCode(view.getUint8(offset + 1)) +
        String.fromCharCode(view.getUint8(offset + 2)) +
        String.fromCharCode(view.getUint8(offset + 3));
      const size = view.getUint32(offset + 4, true);
      if (id === 'data') {
        const dataStart = offset + 8;
        const bytesPerFrame = numChannels * (bitsPerSample / 8);
        const availBytes = Math.min(size, arrayBuffer.byteLength - dataStart);
        const totalFrames = Math.floor(availBytes / bytesPerFrame);
        const mono = new Float32Array(totalFrames);

        if (bitsPerSample === 16) {
          for (let i = 0; i < totalFrames; i++) {
            mono[i] = view.getInt16(dataStart + i * bytesPerFrame, true) / 32768;
          }
        } else {
          for (let i = 0; i < totalFrames; i++) {
            mono[i] = (view.getUint8(dataStart + i * bytesPerFrame) - 128) / 128;
          }
        }
        return {
          duration: round2(totalFrames / sampleRate),
          sampleRate,
          monoSamples: mono,
        };
      }
      offset += 8 + size;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Decodes an audio Blob via fast WAV PCM parser or OfflineAudioContext and prepares silence-aligned chunks.
 */
export async function decodeAndChunkAudioBlob(
  audioBlob: Blob,
  targetChunkSec = 45,
  searchWindowSec = 6
): Promise<{
  duration: number;
  sampleRate: number;
  monoSamples: Float32Array;
  chunks: AudioChunkSpec[];
}> {
  const arrayBuffer = await audioBlob.arrayBuffer();

  const wavDirect = tryDecodeWavPcmBuffer(arrayBuffer);
  if (wavDirect && wavDirect.duration > 0) {
    const chunks = findSilenceSplitPoints(
      wavDirect.monoSamples,
      wavDirect.sampleRate,
      targetChunkSec,
      searchWindowSec
    );
    return {
      duration: wavDirect.duration,
      sampleRate: wavDirect.sampleRate,
      monoSamples: wavDirect.monoSamples,
      chunks,
    };
  }

  const OfflineCtx =
    window.OfflineAudioContext ||
    (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext })
      .webkitOfflineAudioContext;
  const offlineCtx = new OfflineCtx(1, 1, 44100);
  const decoded = await offlineCtx.decodeAudioData(arrayBuffer.slice(0));
  const monoSamples = extractMonoChannel(decoded);
  const chunks = findSilenceSplitPoints(
    monoSamples,
    decoded.sampleRate,
    targetChunkSec,
    searchWindowSec
  );
  return {
    duration: round2(decoded.duration),
    sampleRate: decoded.sampleRate,
    monoSamples,
    chunks,
  };
}

/**
 * Checks whether a single chunk's raw AI scenes cover the chunk duration,
 * allowing natural trailing silence (up to 3.5s or 6% of chunk duration) so pauses at
 * chunk boundaries never trigger false failures, while still rejecting early-stopped chunks.
 */
export function isChunkCoverageComplete(
  rawChunkScenes: Array<{ start: number; end: number; text: string }>,
  chunkDuration: number
): boolean {
  if (!Array.isArray(rawChunkScenes) || rawChunkScenes.length === 0) {
    return false;
  }
  const maxEnd = rawChunkScenes.reduce((acc, s) => Math.max(acc, Number(s.end) || 0), 0);
  const trailingSilenceTolerance = Math.min(3.5, Math.max(1.5, chunkDuration * 0.06));
  const threshold = Math.max(0.5, chunkDuration - trailingSilenceTolerance);
  return maxEnd >= threshold;
}

/**
 * Evaluates overall audio coverage based on scenes and any failed/incomplete chunks.
 */
export function evaluateAudioCoverage(
  scenes: Array<{ start: number; end: number }>,
  totalDuration: number,
  failedRanges: UncoveredRange[] = []
): CoverageReport {
  const safeTotal = Math.max(0, round2(totalDuration));
  if (safeTotal <= 0) {
    return {
      totalDuration: 0,
      coveredSeconds: 0,
      percent: 0,
      isComplete: false,
      uncoveredRanges: failedRanges,
    };
  }

  const uncovered = failedRanges.slice();
  if (scenes.length === 0) {
    return {
      totalDuration: safeTotal,
      coveredSeconds: 0,
      percent: 0,
      isComplete: false,
      uncoveredRanges:
        uncovered.length > 0
          ? uncovered
          : [{ chunkIndex: 0, start: 0, end: safeTotal, reason: 'Belum ada adegan yang dihasilkan.' }],
    };
  }

  // Merge covered intervals from scenes to compute accurate covered duration
  const intervals = scenes
    .map((s) => [Math.max(0, s.start), Math.min(safeTotal, s.end)] as [number, number])
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0]);

  const merged: Array<[number, number]> = [];
  for (const [s, e] of intervals) {
    if (merged.length === 0 || s > merged[merged.length - 1][1] + 0.05) {
      merged.push([s, e]);
    } else {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
    }
  }

  const coveredSeconds = round2(merged.reduce((sum, [s, e]) => sum + (e - s), 0));
  const lastEnd = merged.length > 0 ? merged[merged.length - 1][1] : 0;

  // Detect tail shortfall > 1 second if not already listed in failedRanges
  if (lastEnd < safeTotal - 1.0) {
    const alreadyCoveredInFailed = uncovered.some(
      (r) => r.end >= safeTotal - 1.0 && r.start <= lastEnd + 1.0
    );
    if (!alreadyCoveredInFailed) {
      uncovered.push({
        chunkIndex: -1,
        start: round2(lastEnd),
        end: safeTotal,
        reason: 'Timestamp berhenti sebelum akhir audio.',
      });
    }
  }

  const hasFailures = uncovered.length > 0;
  const rawPct = Math.min(100, Math.round((coveredSeconds / safeTotal) * 100));
  const isComplete = !hasFailures && lastEnd >= safeTotal - 1.0 && coveredSeconds >= safeTotal - 1.0;

  return {
    totalDuration: safeTotal,
    coveredSeconds: isComplete ? safeTotal : coveredSeconds,
    percent: isComplete ? 100 : Math.min(99, rawPct),
    isComplete,
    uncoveredRanges: uncovered,
  };
}
