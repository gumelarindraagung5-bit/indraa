import type { SceneItem } from '../types/project';

export interface AudioWaveformData {
  monoSamples: Float32Array;
  sampleRate: number;
}

export interface AcousticPause {
  startSec: number;
  endSec: number;
  cutSec: number; // optimal cut point inside the pause (past word tail so speech never cuts off early)
  durationSec: number;
  depthScore: number; // higher = longer, deeper silence pause
}

export interface ScriptAlignOptions {
  minSec?: number;
  maxSec?: number;
  audioWaveform?: AudioWaveformData | null;
}

const CLAUSE_STARTERS = new Set([
  'tapi',
  'tetapi',
  'namun',
  'karena',
  'sebab',
  'sehingga',
  'akibatnya',
  'lalu',
  'kemudian',
  'ketika',
  'saat',
  'bayangkan',
  'padahal',
  'sementara',
  'ternyata',
  'bahkan',
  'justru',
  'misalnya',
  'contohnya',
  'akhirnya',
  'maka',
  'kalau',
  'jika',
  'apabila',
  'atau',
  'meskipun',
  'walaupun',
  'sedangkan',
  'melainkan',
  'dibanding',
  'dibandingkan',
  'agar',
  'supaya',
  'nah',
  'jadi',
  'coba',
]);

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Counts approximate spoken Indonesian syllables in a word or sentence.
 * In Bahasa Indonesia, vowel clusters ([aiueoAIUEO]+) map very accurately to spoken syllables,
 * while digits take ~2 syllables per digit when spoken aloud.
 */
export function countIndonesianSyllables(text: string): number {
  if (!text || !text.trim()) return 0;
  const words = text.trim().split(/\s+/);
  let total = 0;
  for (const raw of words) {
    const clean = raw.replace(/[^a-zA-Z0-9\u00C0-\u024F]/g, '');
    if (!clean) continue;
    const vowelGroups = clean.match(/[aiueoAIUEO]+/g);
    const digitCount = (clean.match(/[0-9]/g) || []).length;
    const wordSyllables =
      (vowelGroups ? vowelGroups.length : Math.max(1, Math.ceil(clean.length / 3))) +
      digitCount * 2;
    total += Math.max(1, wordSyllables);
  }
  return total;
}

/**
 * Computes spoken duration weight for a single Indonesian word, including:
 * - Syllable count (primary determinant of spoken duration in Bahasa Indonesia)
 * - Word articulation boundary overhead
 * - Natural breath pause after commas/clauses and sentence-ending punctuation (.!?)
 */
function spokenWordWeight(word: string): number {
  const clean = word.replace(/[^a-zA-Z0-9\u00C0-\u024F]/g, '');
  const vowelGroups = clean.match(/[aiueoAIUEO]+/g);
  const syllables = vowelGroups ? vowelGroups.length : Math.max(1, Math.ceil(clean.length / 3));
  const digitCount = (clean.match(/[0-9]/g) || []).length;

  // Each syllable ~2.0 units + word transition ~0.75 units + character length nuance
  let w = syllables * 2.0 + digitCount * 2.5 + Math.min(3.0, clean.length * 0.18) + 0.75;

  // Narrators naturally pause at punctuation; include this so the cut happens AFTER the sentence finishes
  if (/[.!?]["'”’)]*$/.test(word)) {
    w += 4.2;
  } else if (/[,;:—–]["'”’)]*$/.test(word)) {
    w += 2.2;
  }
  return w;
}

/**
 * Computes total spoken duration weight for a full sentence or segment text.
 */
export function estimateTextSpeechWeight(text: string): number {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (words.length === 0) return 1;
  let sum = 0;
  for (const w of words) {
    sum += spokenWordWeight(w);
  }
  return Math.max(1, sum);
}

function stripPunctLower(word: string): string {
  return word.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
}

interface AcousticAnalysis {
  frameSec: number;
  rmsEnvelope: Float32Array;
  totalDuration: number;
  speechStartSec: number;
  speechEndSec: number;
  silenceThreshold: number;
  pauses: AcousticPause[];
}

/**
 * Analyzes an audio waveform to detect true low-energy breath/silence pauses
 * and leading/trailing dead air without misclassifying soft speech as silence.
 */
export function analyzeAudioWaveform(
  monoSamples: Float32Array,
  sampleRate: number
): AcousticAnalysis | null {
  if (!monoSamples || monoSamples.length === 0 || sampleRate <= 0) {
    return null;
  }

  const totalDuration = monoSamples.length / sampleRate;
  const frameSec = 0.02; // 20ms frame
  const frameSamples = Math.max(1, Math.floor(sampleRate * frameSec));
  const numFrames = Math.max(1, Math.ceil(monoSamples.length / frameSamples));
  const rmsEnvelope = new Float32Array(numFrames);

  for (let f = 0; f < numFrames; f++) {
    const start = f * frameSamples;
    const end = Math.min(monoSamples.length, start + frameSamples);
    const len = end - start;
    const stride = len > 160 ? 2 : 1;
    let sumSq = 0;
    let count = 0;
    for (let i = start; i < end; i += stride) {
      const v = monoSamples[i];
      sumSq += v * v;
      count++;
    }
    rmsEnvelope[f] = Math.sqrt(sumSq / Math.max(1, count));
  }

  // Smooth RMS with a 3-frame moving average
  const smoothed = new Float32Array(numFrames);
  for (let f = 0; f < numFrames; f++) {
    const prev = rmsEnvelope[Math.max(0, f - 1)];
    const curr = rmsEnvelope[f];
    const next = rmsEnvelope[Math.min(numFrames - 1, f + 1)];
    smoothed[f] = prev * 0.25 + curr * 0.5 + next * 0.25;
  }

  // Use minRms (true noise floor) and p50/p85 (active voice) so soft speech is NEVER mistaken for silence
  // even when silence pauses represent <5% of the total audio clip.
  const sortedRms = Array.from(smoothed).sort((a, b) => a - b);
  const minRms = sortedRms[0] ?? 0;
  const p50 = sortedRms[Math.floor(sortedRms.length * 0.5)] ?? 0.05;
  const p85 = sortedRms[Math.floor(sortedRms.length * 0.85)] ?? 0.1;

  // A frame is only silent if it is near the true noise floor AND well below median speech energy
  const silenceThreshold = Math.min(p50 * 0.3, minRms + Math.max(0.002, (p85 - minRms) * 0.12));

  // Detect leading speech start (ignore dead air at start up to 4s)
  let firstVoicedFrame = 0;
  const maxLeadFrames = Math.min(
    numFrames - 1,
    Math.floor(Math.min(4.0, totalDuration * 0.12) / frameSec)
  );
  for (let f = 0; f <= maxLeadFrames; f++) {
    if (
      smoothed[f] > silenceThreshold &&
      smoothed[Math.min(numFrames - 1, f + 1)] > silenceThreshold
    ) {
      firstVoicedFrame = Math.max(0, f - 1);
      break;
    }
  }

  // Detect trailing speech end (ignore dead air at end up to 5s)
  let lastVoicedFrame = numFrames - 1;
  const minTrailFrame = Math.max(
    firstVoicedFrame + 1,
    numFrames - 1 - Math.floor(Math.min(5.0, totalDuration * 0.15) / frameSec)
  );
  for (let f = numFrames - 1; f >= minTrailFrame; f--) {
    if (smoothed[f] > silenceThreshold && smoothed[Math.max(0, f - 1)] > silenceThreshold) {
      lastVoicedFrame = Math.min(numFrames - 1, f + 2);
      break;
    }
  }

  const speechStartSec = round2(firstVoicedFrame * frameSec);
  const speechEndSec = round2(Math.min(totalDuration, (lastVoicedFrame + 1) * frameSec));

  // Detect true breath pause valleys (>= 140ms below pauseThreshold)
  // If the audio has no real silence valleys (minRms > p50 * 0.35), pauseThreshold stays -1 so no fake pauses are created.
  const hasRealDynamicPauses = minRms <= p50 * 0.35;
  const pauseThreshold = hasRealDynamicPauses
    ? Math.min(p50 * 0.32, minRms + (p85 - minRms) * 0.14)
    : -1;

  const pauses: AcousticPause[] = [];
  if (hasRealDynamicPauses) {
    let inPause = false;
    let pauseStartFrame = 0;
    let pauseMinRms = Number.POSITIVE_INFINITY;
    let pauseMinFrame = 0;

    for (let f = firstVoicedFrame; f <= lastVoicedFrame; f++) {
      const val = smoothed[f];
      if (val <= pauseThreshold) {
        if (!inPause) {
          inPause = true;
          pauseStartFrame = f;
          pauseMinRms = val;
          pauseMinFrame = f;
        } else if (val < pauseMinRms) {
          pauseMinRms = val;
          pauseMinFrame = f;
        }
      } else if (inPause) {
        const pauseFrames = f - pauseStartFrame;
        const durationSec = round2(pauseFrames * frameSec);
        if (durationSec >= 0.14) {
          const startSec = round2(pauseStartFrame * frameSec);
          const endSec = round2(f * frameSec);
          const minSec = pauseMinFrame * frameSec;
          // Place cut slightly past the midpoint of the pause so the preceding word finishes 100%
          const cutSec = round2(startSec * 0.2 + minSec * 0.45 + endSec * 0.35);
          const quietRatio = Math.max(
            0.05,
            1 - pauseMinRms / Math.max(0.0001, pauseThreshold)
          );
          pauses.push({
            startSec,
            endSec,
            cutSec,
            durationSec,
            depthScore: round2(durationSec * (1 + quietRatio)),
          });
        }
        inPause = false;
      }
    }
  }

  return {
    frameSec,
    rmsEnvelope: smoothed,
    totalDuration: round2(totalDuration),
    speechStartSec,
    speechEndSec,
    silenceThreshold,
    pauses,
  };
}

/**
 * Extracts detected acoustic pause cut points (in seconds) inside a time slice [sliceStartSec, sliceEndSec],
 * returned as relative seconds from `sliceStartSec`. Useful for guiding AI audio chunk transcription.
 */
export function extractChunkPauseHints(
  monoSamples: Float32Array,
  sampleRate: number,
  sliceStartSec: number,
  sliceEndSec: number
): number[] {
  const startSample = Math.max(0, Math.floor(sliceStartSec * sampleRate));
  const endSample = Math.min(monoSamples.length, Math.ceil(sliceEndSec * sampleRate));
  if (endSample <= startSample) return [];

  const slice = monoSamples.subarray(startSample, endSample);
  const analysis = analyzeAudioWaveform(slice, sampleRate);
  if (!analysis) return [];

  return analysis.pauses
    .filter(
      (p) =>
        p.durationSec >= 0.14 &&
        p.cutSec >= 0.5 &&
        p.cutSec <= analysis.totalDuration - 0.5
    )
    .map((p) => round2(p.cutSec));
}

/**
 * Snaps a candidate cut timestamp to a verified acoustic breath pause within [minAllowedSec, maxAllowedSec].
 * Uses an asymmetric search windowaround `targetSec` (limiting early shifts to prevent cutting off a sentence
 * before the narrator finishes speaking the last words).
 */
export function snapTimeToAcousticPause(
  targetSec: number,
  minAllowedSec: number,
  maxAllowedSec: number,
  waveform: AudioWaveformData,
  analysis?: AcousticAnalysis | null,
  boundaryStrength: 'sentence' | 'clause' | 'phrase' = 'sentence'
): number {
  const { monoSamples, sampleRate } = waveform;
  if (!monoSamples || monoSamples.length === 0 || sampleRate <= 0) {
    return round2(targetSec);
  }

  // Asymmetric window: cautious about cutting early (so the speaker never gets cut off mid-sentence),
  // generous enough to catch a genuine breath pause right at the end of the sentence.
  const maxEarlySec =
    boundaryStrength === 'sentence' ? 0.65 : boundaryStrength === 'clause' ? 0.45 : 0.3;
  const maxLateSec =
    boundaryStrength === 'sentence' ? 0.75 : boundaryStrength === 'clause' ? 0.55 : 0.35;

  const searchStart = Math.max(minAllowedSec, targetSec - maxEarlySec);
  const searchEnd = Math.min(maxAllowedSec, targetSec + maxLateSec);

  if (searchEnd <= searchStart + 0.04) {
    return round2(Math.max(minAllowedSec, Math.min(maxAllowedSec, targetSec)));
  }

  const resolvedAnalysis = analysis ?? analyzeAudioWaveform(monoSamples, sampleRate);

  // 1. Check verified discrete silence/breath pause valleys in [searchStart, searchEnd]
  if (resolvedAnalysis && resolvedAnalysis.pauses.length > 0) {
    let bestPause: AcousticPause | null = null;
    let bestPauseScore = Number.NEGATIVE_INFINITY;

    for (const p of resolvedAnalysis.pauses) {
      if (p.cutSec < searchStart || p.cutSec > searchEnd) continue;
      const delta = p.cutSec - targetSec;
      // Penalize early cuts more than late cuts so we never cut before the last word is spoken
      const distPenalty = delta < 0 ? Math.abs(delta) * 0.85 : delta * 0.55;
      const score = p.depthScore * 2.2 - distPenalty;
      if (score > bestPauseScore) {
        bestPauseScore = score;
        bestPause = p;
      }
    }

    if (bestPause) {
      return round2(Math.max(minAllowedSec, Math.min(maxAllowedSec, bestPause.cutSec)));
    }
  }

  // 2. Fallback: fine-grained 50ms RMS minimum search within a tight [-0.25s, +0.35s] window
  const tightStart = Math.max(minAllowedSec, targetSec - 0.25);
  const tightEnd = Math.min(maxAllowedSec, targetSec + 0.35);
  if (tightEnd <= tightStart + 0.03) {
    return round2(Math.max(minAllowedSec, Math.min(maxAllowedSec, targetSec)));
  }

  const frameSamples = Math.max(1, Math.floor(sampleRate * 0.05));
  const hopSamples = Math.max(1, Math.floor(sampleRate * 0.015));
  const startIdx = Math.max(0, Math.floor(tightStart * sampleRate));
  const endIdx = Math.min(
    monoSamples.length - frameSamples,
    Math.floor(tightEnd * sampleRate)
  );

  if (endIdx <= startIdx) {
    return round2(Math.max(minAllowedSec, Math.min(maxAllowedSec, targetSec)));
  }

  let bestSec = targetSec;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let i = startIdx; i <= endIdx; i += hopSamples) {
    let sumSq = 0;
    const limit = Math.min(monoSamples.length, i + frameSamples);
    const stride = limit - i > 200 ? 4 : 1;
    let count = 0;
    for (let j = i; j < limit; j += stride) {
      const v = monoSamples[j];
      sumSq += v * v;
      count++;
    }
    const rms = Math.sqrt(sumSq / Math.max(1, count));
    const centerSec = (i + frameSamples * 0.5) / sampleRate;
    const delta = centerSec - targetSec;
    const distPenalty = (delta < 0 ? Math.abs(delta) * 0.04 : delta * 0.025);
    const score = rms + distPenalty;
    if (score < bestScore) {
      bestScore = score;
      bestSec = centerSec;
    }
  }

  return round2(Math.max(minAllowedSec, Math.min(maxAllowedSec, bestSec)));
}

/**
 * Checks whether an existing list of scenes has distorted/imbalanced timestamps relative to
 * the actual spoken syllable lengths of each row's text (e.g., a 15-word sentence given 2.7s
 * while a neighboring 15-word sentence has 6.4s).
 */
export function hasImbalancedSpeechTimestamps(
  scenes: SceneItem[],
  totalAudioDuration?: number
): boolean {
  if (scenes.length < 2) return false;
  const lastEnd = scenes[scenes.length - 1].end;
  const exactTotal = round2(totalAudioDuration && totalAudioDuration > 0 ? totalAudioDuration : lastEnd);
  if (exactTotal <= 0) return false;

  if (Math.abs(lastEnd - exactTotal) > 0.35) {
    return true;
  }

  const weights = scenes.map((s) => estimateTextSpeechWeight(s.text));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  if (totalWeight <= 0) return false;

  for (let i = 0; i < scenes.length; i++) {
    const actualDur = scenes[i].end - scenes[i].start;
    const expectedDur = (weights[i] / totalWeight) * exactTotal;
    if (expectedDur >= 2.0) {
      const ratio = actualDur / expectedDur;
      // If any row is compressed below 80% or stretched above 125% of its spoken syllable time, it's out of sync
      if (ratio < 0.8 || ratio > 1.25) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Rebalances an existing list of scenes so every row's duration [start, end] matches the
 * exact spoken syllable + punctuation pause weight of its text, optionally fine-snapping
 * to verified breath pauses in the audio waveform while preserving all IDs, prompts, and images.
 */
export function rebalanceSceneTimestampsToSpeechDuration(
  scenes: SceneItem[],
  totalAudioDuration?: number,
  audioWaveform?: AudioWaveformData | null
): SceneItem[] {
  if (scenes.length === 0) return scenes;
  const analysis = audioWaveform
    ? analyzeAudioWaveform(audioWaveform.monoSamples, audioWaveform.sampleRate)
    : null;
  const exactTotal = round2(
    (totalAudioDuration && totalAudioDuration > 0 ? totalAudioDuration : 0) ||
      analysis?.totalDuration ||
      scenes[scenes.length - 1].end
  );

  if (scenes.length === 1) {
    return [{ ...scenes[0], start: 0, end: exactTotal }];
  }

  const weights = scenes.map((s) => estimateTextSpeechWeight(s.text));
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  // Account for leading/trailing silence if waveform analysis is available
  const speechStart = analysis ? Math.min(1.2, analysis.speechStartSec) : 0;
  const speechEnd = analysis
    ? Math.max(exactTotal - 1.5, Math.min(exactTotal, analysis.speechEndSec))
    : exactTotal;
  const activeSpan = Math.max(1.0, speechEnd - speechStart);

  const idealCuts: number[] = [0];
  let accWeight = 0;
  for (let i = 0; i < scenes.length - 1; i++) {
    accWeight += weights[i];
    const frac = accWeight / Math.max(1, totalWeight);
    idealCuts.push(round2(speechStart + frac * activeSpan));
  }
  idealCuts.push(exactTotal);

  const finalCuts = idealCuts.slice();

  if (audioWaveform && analysis) {
    for (let i = 1; i < finalCuts.length - 1; i++) {
      const prevIdealDur = idealCuts[i] - idealCuts[i - 1];
      const nextIdealDur = idealCuts[i + 1] - idealCuts[i];
      // Guarantee every scene retains at least 82% of its syllable-proportional speaking duration
      const minAllowed = round2(
        Math.max(finalCuts[i - 1] + Math.max(1.4, prevIdealDur * 0.82), idealCuts[i] - 0.65)
      );
      const maxAllowed = round2(
        Math.min(idealCuts[i + 1] - Math.max(1.4, nextIdealDur * 0.82), idealCuts[i] + 0.75)
      );

      if (maxAllowed > minAllowed) {
        const text = scenes[i - 1].text.trim();
        const strength: 'sentence' | 'clause' | 'phrase' = /[.!?]["'”’)]*$/.test(text)
          ? 'sentence'
          : /[,;:—–]["'”’)]*$/.test(text)
            ? 'clause'
            : 'phrase';
        finalCuts[i] = round1(
          snapTimeToAcousticPause(
            idealCuts[i],
            minAllowed,
            maxAllowed,
            audioWaveform,
            analysis,
            strength
          )
        );
      } else {
        finalCuts[i] = round1(idealCuts[i]);
      }
    }
  } else {
    for (let i = 1; i < finalCuts.length - 1; i++) {
      finalCuts[i] = round1(idealCuts[i]);
    }
  }

  return scenes.map((s, idx) => ({
    ...s,
    start: idx === 0 ? 0 : finalCuts[idx],
    end:
      idx === scenes.length - 1
        ? exactTotal
        : Math.max(round1(finalCuts[idx] + 0.5), finalCuts[idx + 1]),
  }));
}

/**
 * Snaps an existing list of scenes' internal cut boundaries to the nearest real acoustic
 * silence pauses in the audio waveform while preventing any row from shrinking below
 * the physical speaking time required for its Indonesian syllables.
 */
export function snapExistingScenesToAudioPauses(
  scenes: SceneItem[],
  durationOrWaveform: number | AudioWaveformData,
  waveformOrDuration?: AudioWaveformData | number
): SceneItem[] {
  if (scenes.length === 0) return scenes;
  const waveform: AudioWaveformData =
    typeof durationOrWaveform === 'number'
      ? (waveformOrDuration as AudioWaveformData)
      : durationOrWaveform;
  const totalAudioDuration: number | undefined =
    typeof durationOrWaveform === 'number'
      ? durationOrWaveform
      : typeof waveformOrDuration === 'number'
        ? waveformOrDuration
        : undefined;

  if (!waveform || !waveform.monoSamples) return scenes;
  return rebalanceSceneTimestampsToSpeechDuration(scenes, totalAudioDuration, waveform);
}

/**
 * Splits a single scene into two consecutive visual focus beats at its natural mid-sentence
 * clause break (comma or conjunction), dividing the scene's timestamp duration strictly
 * proportionally to the spoken syllable weights of the two halves.
 */
export function splitSceneIntoTwoVisualBeats(
  scenes: SceneItem[],
  sceneId: number
): SceneItem[] {
  const idx = scenes.findIndex((s) => s.id === sceneId);
  if (idx < 0) return scenes;
  const target = scenes[idx];
  const words = target.text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const dur = round2(target.end - target.start);
  if (words.length < 4 || dur < 2.2) return scenes;

  const mid = Math.round(words.length / 2);
  let bestSplit = mid;
  let bestScore = Number.NEGATIVE_INFINITY;
  const minSplit = Math.max(2, Math.floor(words.length * 0.3));
  const maxSplit = Math.min(words.length - 2, Math.ceil(words.length * 0.7));

  for (let i = minSplit; i <= maxSplit; i++) {
    const leftLast = words[i - 1];
    const rightFirst = words[i];
    let bonus = 0;
    if (/[,;:—–]["'”’)]*$/.test(leftLast)) bonus = 40;
    else if (/[.!?]["'”’)]*$/.test(leftLast)) bonus = 50;
    else if (CLAUSE_STARTERS.has(stripPunctLower(rightFirst))) bonus = 30;
    const distPenalty = Math.abs(i - mid) * 4;
    const score = bonus - distPenalty;
    if (score > bestScore) {
      bestScore = score;
      bestSplit = i;
    }
  }

  const textA = words.slice(0, bestSplit).join(' ');
  const textB = words.slice(bestSplit).join(' ');
  const wA = estimateTextSpeechWeight(textA);
  const wB = estimateTextSpeechWeight(textB);
  const splitTime = round1(
    Math.max(target.start + 0.8, Math.min(target.end - 0.8, target.start + dur * (wA / (wA + wB))))
  );

  const firstHalf: SceneItem = {
    ...target,
    end: splitTime,
    text: textA,
  };
  const secondHalf: SceneItem = {
    id: target.id + 1,
    start: splitTime,
    end: target.end,
    text: textB,
    imageId: null,
  };

  const next = [
    ...scenes.slice(0, idx),
    firstHalf,
    secondHalf,
    ...scenes.slice(idx + 1),
  ];
  return next.map((s, i) => ({ ...s, id: i + 1 }));
}

/**
 * Deterministically groups a narration script into varied, non-rigid visual-focus beats
 * (~3.5–5.8s, aligned to sentence/clause boundaries) and calculates each beat's timestamp
 * strictly from its Indonesian syllable + punctuation pause weight, with safe acoustic pause locking.
 */
export function alignScriptToVisualTimestamps(
  scriptText: string,
  audioDuration: number,
  options: ScriptAlignOptions = {}
): SceneItem[] {
  const safeDuration = Math.max(0.5, round2(audioDuration));
  const minSec = Math.max(1.5, options.minSec ?? 3.5);
  const maxSec = Math.max(minSec + 0.8, options.maxSec ?? 5.8);
  const cleanText = scriptText.replace(/\s+/g, ' ').trim();

  if (!cleanText) {
    return [];
  }

  const words = cleanText.split(' ').filter(Boolean);
  if (words.length === 0) {
    return [];
  }

  if (safeDuration <= maxSec + 0.6 || words.length <= 5) {
    return [
      {
        id: 1,
        start: 0,
        end: safeDuration,
        text: cleanText,
      },
    ];
  }

  const analysis = options.audioWaveform
    ? analyzeAudioWaveform(options.audioWaveform.monoSamples, options.audioWaveform.sampleRate)
    : null;

  // Always include punctuation pause weight so sentence-end breaths are accounted for in every beat
  const weights = words.map((w) => spokenWordWeight(w));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const secPerWeight = safeDuration / Math.max(1, totalWeight);

  // Also compute natural human Indonesian speech duration per weight unit (~145 words/min = ~0.41s/word)
  // so that even if a user has a fast audio or dense script, we don't pack >16 words into a single visual beat
  // when a natural clause split exists.
  const naturalTotalSec = words.length * 0.39;
  const naturalSecPerWeight = naturalTotalSec / Math.max(1, totalWeight);
  const effectiveGroupingSecPerWeight = Math.max(secPerWeight, naturalSecPerWeight * 0.82);

  const prefix: number[] = new Array(words.length + 1).fill(0);
  for (let i = 0; i < words.length; i++) {
    prefix[i + 1] = prefix[i] + weights[i];
  }

  const segments: Array<{
    startIdx: number;
    endIdx: number;
    weight: number;
    boundaryStrength: 'sentence' | 'clause' | 'phrase';
  }> = [];
  let cursor = 0;
  let segCounter = 0;

  const rhythmMultipliers = [0.96, 1.08, 0.88, 1.05, 0.92, 1.12, 0.9];

  while (cursor < words.length) {
    const remainingWeight = prefix[words.length] - prefix[cursor];
    const remainingSec = remainingWeight * effectiveGroupingSecPerWeight;

    if (remainingSec <= maxSec + 0.85) {
      segments.push({
        startIdx: cursor,
        endIdx: words.length,
        weight: remainingWeight,
        boundaryStrength: 'sentence',
      });
      break;
    }

    const rhythm = rhythmMultipliers[segCounter % rhythmMultipliers.length];
    const baseTargetSec = Math.max(
      minSec,
      Math.min(maxSec, ((minSec + maxSec) / 2) * rhythm)
    );
    const targetSec =
      remainingSec <= maxSec * 1.9 ? Math.max(2.3, remainingSec / 2) : baseTargetSec;

    const softMinSec = Math.max(2.1, Math.min(targetSec * 0.78, minSec * 0.78));
    const softMaxSec = maxSec + 0.95;

    let bestEnd = Math.min(words.length, cursor + 1);
    let bestScore = Number.NEGATIVE_INFINITY;
    let bestStrength: 'sentence' | 'clause' | 'phrase' = 'phrase';

    for (let end = cursor + 1; end <= words.length; end++) {
      const segWeight = prefix[end] - prefix[cursor];
      const segSec = segWeight * effectiveGroupingSecPerWeight;
      const tailSec = (prefix[words.length] - prefix[end]) * effectiveGroupingSecPerWeight;
      const wordCount = end - cursor;

      if (segSec < softMinSec && end < words.length) {
        continue;
      }

      if (tailSec > 0 && tailSec < Math.min(2.1, remainingSec * 0.34)) {
        if (segSec > softMaxSec + 1.0) break;
        continue;
      }

      const lastWord = words[end - 1];
      const nextWord = end < words.length ? words[end] : '';

      let boundaryBonus = 0;
      let strength: 'sentence' | 'clause' | 'phrase' = 'phrase';
      if (/[.!?]["'”’)]*$/.test(lastWord)) {
        boundaryBonus = 125;
        strength = 'sentence';
      } else if (/[,;:—–]["'”’)]*$/.test(lastWord)) {
        boundaryBonus = 82;
        strength = 'clause';
      } else if (nextWord && CLAUSE_STARTERS.has(stripPunctLower(nextWord))) {
        boundaryBonus = 56;
        strength = 'clause';
      }

      const distPenalty = Math.abs(segSec - targetSec) * 14;
      const overMaxPenalty = segSec > maxSec ? (segSec - maxSec) * 42 : 0;
      const underMinPenalty = segSec < minSec ? (minSec - segSec) * 24 : 0;
      // Avoid cramming >16 words into a single visual focus beat if a clause break is available earlier
      const overWordPenalty = wordCount > 16 ? (wordCount - 16) * 18 : 0;

      const score =
        boundaryBonus - distPenalty - overMaxPenalty - underMinPenalty - overWordPenalty;
      if (score > bestScore) {
        bestScore = score;
        bestEnd = end;
        bestStrength = strength;
      }

      if (segSec > softMaxSec && bestScore > Number.NEGATIVE_INFINITY) {
        break;
      }
    }

    if (bestEnd <= cursor) {
      bestEnd = Math.min(
        words.length,
        cursor + Math.max(1, Math.round((words.length - cursor) / 2))
      );
    }

    segments.push({
      startIdx: cursor,
      endIdx: bestEnd,
      weight: prefix[bestEnd] - prefix[cursor],
      boundaryStrength: bestStrength,
    });
    cursor = bestEnd;
    segCounter++;
  }

  // Build initial scenes and run rebalanceSceneTimestampsToSpeechDuration so every segment gets
  // its exact syllable-proportional speaking time + safe non-cascading acoustic pause locking.
  const rawScenes: SceneItem[] = segments.map((seg, idx) => ({
    id: idx + 1,
    start: 0,
    end: 0,
    text: words.slice(seg.startIdx, seg.endIdx).join(' '),
  }));

  return rebalanceSceneTimestampsToSpeechDuration(
    rawScenes,
    safeDuration,
    options.audioWaveform
  );
}
