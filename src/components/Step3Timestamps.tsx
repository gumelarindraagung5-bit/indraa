import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Play,
  Square,
  RefreshCw,
  Sparkles,
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  Zap,
  Film,
  AudioLines,
  Sliders,
  Scissors,
} from 'lucide-react';
import type { SceneItem, StudioProject } from '../types/project';
import { fetchWithRetry } from '../utils/apiClient';
import {
  decodeAndChunkAudioBlob,
  encodeMonoSliceToWavBlob,
  evaluateAudioCoverage,
  isChunkCoverageComplete,
  type AudioChunkSpec,
  type UncoveredRange,
} from '../utils/audioChunker';
import { getAudioBlob } from '../utils/mediaDb';
import {
  getSceneSummaryStats,
  validateAndNormalizeScenes,
  type RawSceneInput,
} from '../utils/sceneValidator';
import {
  alignScriptToVisualTimestamps,
  countIndonesianSyllables,
  extractChunkPauseHints,
  hasImbalancedSpeechTimestamps,
  rebalanceSceneTimestampsToSpeechDuration,
  snapExistingScenesToAudioPauses,
  splitSceneIntoTwoVisualBeats,
} from '../utils/scriptTimestampAligner';
import { formatTimePrecise } from '../utils/timelineMath';

interface Step3Props {
  project: StudioProject;
  onUpdate: (patch: Partial<StudioProject>) => void;
  onPrev: () => void;
  onNext: () => void;
}

const PAGE_SIZE = 12;
const AI_CHUNK_SEC = 45;
const AI_CONCURRENCY = 3;
const MAX_CHUNK_RETRIES = 2;
const CHUNK_RETRY_DELAYS_MS = [1200, 2500];

interface DecodedAudioCache {
  duration: number;
  sampleRate: number;
  monoSamples: Float32Array;
  chunks: AudioChunkSpec[];
}

export const Step3Timestamps: React.FC<Step3Props> = ({
  project,
  onUpdate,
  onPrev,
  onNext,
}) => {
  const [loading, setLoading] = useState(false);
  const [loadingMode, setLoadingMode] = useState<'fast' | 'ai' | 'snap' | null>(null);
  const [retryingRangeKey, setRetryingRangeKey] = useState<string | null>(null);
  const [progressInfo, setProgressInfo] = useState({
    completedParts: 0,
    totalParts: 0,
    message: '',
  });
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [failedRanges, setFailedRanges] = useState<UncoveredRange[]>([]);
  const [lastMethodNote, setLastMethodNote] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [playingSceneId, setPlayingSceneId] = useState<number | null>(null);
  const [playingTimeSec, setPlayingTimeSec] = useState<number | null>(null);
  // Only send script hint to AI audio transcription if user explicitly provided referenceScript in Kotak 2 or toggled it on
  const [useScriptHintForAI, setUseScriptHintForAI] = useState<boolean>(
    Boolean(project.referenceScript && project.referenceScript.trim().length > 0)
  );

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const stopAtRef = useRef<number | null>(null);

  // Cache decoded audio & per-chunk raw scenes so retries and instant sync stay fast
  const decodedCacheRef = useRef<DecodedAudioCache | null>(null);
  const chunkResultsRef = useRef<Map<number, RawSceneInput[]>>(new Map());

  // Prepare single shared <audio> element for per-scene preview playback
  useEffect(() => {
    let cancelled = false;
    decodedCacheRef.current = null;
    chunkResultsRef.current.clear();
    setFailedRanges([]);

    getAudioBlob()
      .then((rec) => {
        if (cancelled || !rec?.blob) return;
        const url = URL.createObjectURL(rec.blob);
        audioUrlRef.current = url;
        if (audioRef.current) {
          audioRef.current.src = url;
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      if (audioRef.current) {
        audioRef.current.pause();
      }
      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current);
        audioUrlRef.current = null;
      }
    };
  }, [project.audioMeta?.fileName, project.audioMeta?.fileSize]);

  const refScript = (project.referenceScript || project.script || '').trim();
  const hasScript = refScript.length > 0;
  const audioDuration = project.audioMeta?.duration || 0;

  // Auto-heal any previously saved imbalanced timestamps (e.g., 15-word sentence assigned only 2.7s while another gets 6.4s)
  useEffect(() => {
    if (project.scenes.length > 1 && hasImbalancedSpeechTimestamps(project.scenes, audioDuration)) {
      const rebalanced = rebalanceSceneTimestampsToSpeechDuration(project.scenes, audioDuration);
      onUpdate({ scenes: rebalanced });
      setLastMethodNote(
        `Durasi ${rebalanced.length} timestamp otomatis disesuaikan secara proporsional dengan jumlah suku kata & jeda kalimat agar suara selesai 100% sebelum ganti fokus visual.`
      );
    }
  }, [project.scenes, audioDuration, onUpdate]);

  const totalPages = Math.max(1, Math.ceil(project.scenes.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);

  const pagedScenes = useMemo(() => {
    const startIdx = (safePage - 1) * PAGE_SIZE;
    return project.scenes.slice(startIdx, startIdx + PAGE_SIZE);
  }, [project.scenes, safePage]);

  const summary = useMemo(() => getSceneSummaryStats(project.scenes), [project.scenes]);

  const coverage = useMemo(
    () => evaluateAudioCoverage(project.scenes, audioDuration, failedRanges),
    [project.scenes, audioDuration, failedRanges]
  );

  const ensureDecodedChunks = async (): Promise<DecodedAudioCache> => {
    if (decodedCacheRef.current) {
      return decodedCacheRef.current;
    }
    const audioRec = await getAudioBlob();
    if (!audioRec?.blob || !project.audioMeta) {
      throw new Error('Belum ada file audio. Upload audio narasi di Kotak 2 terlebih dahulu.');
    }
    const decoded = await decodeAndChunkAudioBlob(audioRec.blob, AI_CHUNK_SEC, 6);
    decodedCacheRef.current = decoded;
    return decoded;
  };

  /**
   * INSTANT VAD + SYLLABLE SPEECH ALIGNMENT (< 1 second, zero AI timeout/503 errors):
   * Guarantees every sentence's timestamp duration is proportional to its exact spoken syllable count
   * and punctuation breath pauses so the narrator finishes 100% of the sentence before the visual switches.
   */
  const handleFastScriptAudioSync = async () => {
    if (!project.audioMeta) {
      setErrorMsg('Belum ada file audio. Upload audio narasi di Kotak 2 terlebih dahulu.');
      return;
    }
    if (!hasScript) {
      setErrorMsg(
        'Belum ada naskah di Kotak 1 atau Kotak 2. Gunakan tombol "Transkripsi Suara Audio (AI)" untuk membuat timestamp langsung dari suara audio.'
      );
      return;
    }

    setErrorMsg(null);
    setFailedRanges([]);
    setLoading(true);
    setLoadingMode('fast');
    setProgressInfo({
      completedParts: 1,
      totalParts: 2,
      message: 'Menghitung bobot suku kata tiap kalimat & mendeteksi jeda napas audio...',
    });

    try {
      let waveform: { monoSamples: Float32Array; sampleRate: number } | null = null;
      let exactDuration = project.audioMeta.duration;

      try {
        const audioRec = await getAudioBlob();
        if (audioRec?.blob) {
          const decoded = await ensureDecodedChunks();
          waveform = {
            monoSamples: decoded.monoSamples,
            sampleRate: decoded.sampleRate,
          };
          if (!exactDuration && decoded.duration > 0) {
            exactDuration = decoded.duration;
          }
        }
      } catch {
        // Gracefully continue with proportional timing if blob is unavailable
      }

      const aligned = alignScriptToVisualTimestamps(refScript, exactDuration, {
        minSec: project.minSceneSec,
        maxSec: project.maxSceneSec,
        audioWaveform: waveform,
      });

      if (aligned.length === 0) {
        throw new Error('Naskah tidak dapat dipecah menjadi timestamp. Periksa isi naskah Anda.');
      }

      // Preserve any existing scenePrompt/imageId by ID or matching text
      const prevById = new Map(project.scenes.map((s) => [s.id, s]));
      const prevByText = new Map(project.scenes.map((s) => [s.text.trim(), s]));
      const merged: SceneItem[] = aligned.map((scene) => {
        const prev = prevByText.get(scene.text.trim()) || prevById.get(scene.id);
        return {
          ...scene,
          scenePrompt: prev?.text === scene.text ? prev.scenePrompt : prev?.scenePrompt,
          shotType: prev?.text === scene.text ? prev.shotType : prev?.shotType,
          imageId: prev?.imageId ?? null,
        };
      });

      onUpdate({ scenes: merged });
      setLastMethodNote(
        `Durasi ${merged.length} timestamp diselaraskan proporsional dengan jumlah suku kata & jeda napas kalimat (100% kalimat selesai diucapkan sebelum pergantian fokus visual).`
      );
      setPage(1);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Gagal menyinkronkan timestamp naskah.');
    } finally {
      setLoading(false);
      setLoadingMode(null);
      setProgressInfo({ completedParts: 0, totalParts: 0, message: '' });
    }
  };

  /**
   * Rebalances existing scene timestamps to their exact spoken syllable + punctuation pause weight
   * and gently snaps to true silence pauses without cutting any sentence off early.
   */
  const handleSnapToVoicePauses = async () => {
    if (!project.audioMeta || project.scenes.length === 0) return;
    setErrorMsg(null);
    setLoading(true);
    setLoadingMode('snap');
    try {
      let waveform: { monoSamples: Float32Array; sampleRate: number } | null = null;
      let exactDuration = project.audioMeta.duration;
      try {
        const decoded = await ensureDecodedChunks();
        waveform = {
          monoSamples: decoded.monoSamples,
          sampleRate: decoded.sampleRate,
        };
        exactDuration = exactDuration || decoded.duration;
      } catch {
        // Fallback to pure syllable rebalancing if audio waveform isn't loaded
      }
      const snapped = waveform
        ? snapExistingScenesToAudioPauses(project.scenes, exactDuration, waveform)
        : rebalanceSceneTimestampsToSpeechDuration(project.scenes, exactDuration);
      onUpdate({ scenes: snapped });
      setLastMethodNote(
        `Durasi ${snapped.length} adegan berhasil diseimbangkan sesuai jumlah suku kata & dikunci ke jeda napas akhir kalimat.`
      );
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'Gagal menyelaraskan durasi bicara pada gelombang audio.'
      );
    } finally {
      setLoading(false);
      setLoadingMode(null);
    }
  };

  /**
   * Sends ONE ~45s audio chunk to Gemini (gemini-3.1-flash-lite primary -> gemini-4-hydrogen -> gemini-3.5-transcribe)
   * along with detected acoustic pause timestamps (pauseHints) so timestamps lock onto real spoken words.
   */
  const processSingleChunkWithAutoRetry = async (
    decoded: DecodedAudioCache,
    chunk: AudioChunkSpec,
    totalChunks: number,
    scriptHint: string
  ): Promise<{ ok: boolean; scenes: RawSceneInput[]; reason?: string }> => {
    const wavBlob = encodeMonoSliceToWavBlob(
      decoded.monoSamples,
      decoded.sampleRate,
      chunk.startOffset,
      chunk.endOffset,
      16000
    );

    const pauseHintsList = extractChunkPauseHints(
      decoded.monoSamples,
      decoded.sampleRate,
      chunk.startOffset,
      chunk.endOffset
    );
    const pauseHintsStr = pauseHintsList.map((p) => `${p.toFixed(2)}s`).join(', ');

    const startSample = Math.max(0, Math.floor(chunk.startOffset * decoded.sampleRate));
    const endSample = Math.min(
      decoded.monoSamples.length,
      Math.ceil(chunk.endOffset * decoded.sampleRate)
    );
    const chunkSlice = decoded.monoSamples.subarray(startSample, endSample);

    let lastReason = 'Gagal memproses potongan audio.';
    let bestPartial: RawSceneInput[] = [];

    for (let attempt = 0; attempt <= MAX_CHUNK_RETRIES; attempt++) {
      if (attempt > 0) {
        const delayMs = CHUNK_RETRY_DELAYS_MS[attempt - 1] ?? 2500;
        await new Promise((r) => setTimeout(r, delayMs));
      }

      try {
        const formData = new FormData();
        formData.append('audio', wavBlob, `chunk_${chunk.chunkIndex + 1}.wav`);
        formData.append('chunkDuration', String(chunk.duration));
        formData.append('chunkIndex', String(chunk.chunkIndex));
        formData.append('totalChunks', String(totalChunks));
        formData.append('minSec', String(project.minSceneSec));
        formData.append('maxSec', String(project.maxSceneSec));
        if (pauseHintsStr) {
          formData.append('pauseHints', pauseHintsStr);
        }
        if (scriptHint) {
          formData.append('referenceScript', scriptHint);
        }

        const data = await fetchWithRetry<{
          scenes?: Array<{ start: number; end: number; text: string }>;
          transcript?: string;
        }>(
          '/api/ai/timestamps',
          {
            method: 'POST',
            body: formData,
          },
          { maxRetries: 1 }
        );

        let rawList = Array.isArray(data.scenes) ? data.scenes : [];

        // If server returned a clean transcript from gemini-3.5-transcribe fallback, align it to this chunk's real VAD waveform
        if (rawList.length === 0 && data.transcript && data.transcript.trim()) {
          const alignedChunk = alignScriptToVisualTimestamps(data.transcript, chunk.duration, {
            minSec: project.minSceneSec,
            maxSec: project.maxSceneSec,
            audioWaveform: {
              monoSamples: chunkSlice,
              sampleRate: decoded.sampleRate,
            },
          });
          rawList = alignedChunk.map((s) => ({ start: s.start, end: s.end, text: s.text }));
        }

        if (rawList.length > bestPartial.length) {
          bestPartial = rawList;
        }

        if (isChunkCoverageComplete(rawList, chunk.duration)) {
          // Normalize & snap this chunk's relative timestamps to its own acoustic silence pauses first
          const chunkNormalized = validateAndNormalizeScenes(
            rawList,
            chunk.duration,
            project.minSceneSec,
            project.maxSceneSec,
            {
              flexible: true,
              audioWaveform: {
                monoSamples: chunkSlice,
                sampleRate: decoded.sampleRate,
              },
            }
          );

          const shifted: RawSceneInput[] = chunkNormalized.map((s) => ({
            start: Math.round((chunk.startOffset + s.start) * 100) / 100,
            end: Math.round((chunk.startOffset + s.end) * 100) / 100,
            text: (s.text || '').trim(),
          }));
          return { ok: true, scenes: shifted };
        }

        const maxEnd = rawList.reduce((acc, s) => Math.max(acc, Number(s.end) || 0), 0);
        lastReason = `timestamp berhenti di ${maxEnd.toFixed(1)}s dari ${chunk.duration.toFixed(1)}s`;
      } catch (err) {
        lastReason = err instanceof Error ? err.message : 'kesalahan jaringan/AI';
      }
    }

    const fallbackShifted = bestPartial.map((s) => {
      const relStart = Math.max(0, Math.min(chunk.duration, Number(s.start) || 0));
      const relEnd = Math.max(relStart, Math.min(chunk.duration, Number(s.end) || relStart));
      return {
        start: Math.round((chunk.startOffset + relStart) * 100) / 100,
        end: Math.round((chunk.startOffset + relEnd) * 100) / 100,
        text: (s.text || '').trim(),
      };
    });

    return { ok: false, scenes: fallbackShifted, reason: lastReason };
  };

  /**
   * Rebuilds global scene list from chunkResultsRef and snaps cuts to the global audio waveform.
   */
  const commitMergedChunkResults = (
    decoded: DecodedAudioCache,
    uncovered: UncoveredRange[]
  ) => {
    const exactDuration = project.audioMeta?.duration || decoded.duration;
    const allRaw: RawSceneInput[] = [];
    for (const chunk of decoded.chunks) {
      const list = chunkResultsRef.current.get(chunk.chunkIndex);
      if (list && list.length > 0) {
        allRaw.push(...list);
      }
    }

    const prevById = new Map(project.scenes.map((s) => [s.id, s]));

    if (uncovered.length === 0 && allRaw.length > 0) {
      const validated = validateAndNormalizeScenes(
        allRaw,
        exactDuration,
        project.minSceneSec,
        project.maxSceneSec,
        {
          flexible: true,
          audioWaveform: {
            monoSamples: decoded.monoSamples,
            sampleRate: decoded.sampleRate,
          },
        }
      ).map((scene) => {
        const prev = prevById.get(scene.id);
        return {
          ...scene,
          imageId: prev?.imageId ?? null,
          scenePrompt: prev?.text === scene.text ? prev.scenePrompt : undefined,
        };
      });
      setFailedRanges([]);
      onUpdate({ scenes: validated });
      setLastMethodNote(
        `Transkripsi Suara Audio AI selesai & dikunci ke jeda napas asli (${validated.length} adegan, 100% durasi audio).`
      );
    } else {
      const partialScenes: SceneItem[] = [];
      let runningId = 1;
      for (const chunk of decoded.chunks) {
        const isFailed = uncovered.some((u) => u.chunkIndex === chunk.chunkIndex);
        if (isFailed) continue;
        const list = chunkResultsRef.current.get(chunk.chunkIndex);
        if (!list || list.length === 0) continue;

        const relativeList = list.map((s) => ({
          start: Math.max(0, s.start - chunk.startOffset),
          end: Math.max(0, s.end - chunk.startOffset),
          text: s.text,
        }));
        const normChunk = validateAndNormalizeScenes(
          relativeList,
          chunk.duration,
          project.minSceneSec,
          project.maxSceneSec,
          { flexible: true }
        );
        for (const s of normChunk) {
          const id = runningId++;
          const prev = prevById.get(id);
          partialScenes.push({
            id,
            start: Math.round((chunk.startOffset + s.start) * 100) / 100,
            end: Math.round((chunk.startOffset + s.end) * 100) / 100,
            text: s.text,
            imageId: prev?.imageId ?? null,
          });
        }
      }
      setFailedRanges(uncovered);
      onUpdate({ scenes: partialScenes });
    }
  };

  /**
   * PARALLEL AI AUDIO TRANSCRIPTION (~45s chunks + acoustic pause hints + waveform pause snapping)
   */
  const handleAnalyzeAudioWithAI = async () => {
    setErrorMsg(null);
    setFailedRanges([]);
    setLoading(true);
    setLoadingMode('ai');
    setProgressInfo({
      completedParts: 0,
      totalParts: 0,
      message: 'Memotong audio per ±45 detik pada titik keheningan & mendeteksi jeda suara...',
    });

    try {
      const decoded = await ensureDecodedChunks();
      const totalParts = decoded.chunks.length;
      chunkResultsRef.current.clear();

      let completed = 0;
      const uncovered: UncoveredRange[] = [];
      const activeScriptHint = useScriptHintForAI ? refScript : '';

      setProgressInfo({
        completedParts: 0,
        totalParts,
        message: `Mentranskripsi suara asli dari ${totalParts} bagian audio secara paralel (${Math.min(AI_CONCURRENCY, totalParts)} sekaligus)...`,
      });

      for (let start = 0; start < totalParts; start += AI_CONCURRENCY) {
        const wave = decoded.chunks.slice(start, start + AI_CONCURRENCY);
        const waveResults = await Promise.all(
          wave.map(async (chunk) => {
            const res = await processSingleChunkWithAutoRetry(
              decoded,
              chunk,
              totalParts,
              activeScriptHint
            );
            completed++;
            setProgressInfo({
              completedParts: completed,
              totalParts,
              message: `Selesai bagian ${completed} dari ${totalParts} (${formatTimePrecise(chunk.startOffset)} – ${formatTimePrecise(chunk.endOffset)})`,
            });
            return { chunk, res };
          })
        );

        for (const { chunk, res } of waveResults) {
          if (res.ok) {
            chunkResultsRef.current.set(chunk.chunkIndex, res.scenes);
          } else {
            uncovered.push({
              chunkIndex: chunk.chunkIndex,
              start: chunk.startOffset,
              end: chunk.endOffset,
              reason: res.reason || 'Bagian gagal diproses oleh AI.',
            });
          }
        }
      }

      uncovered.sort((a, b) => a.start - b.start);
      commitMergedChunkResults(decoded, uncovered);
      setPage(1);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Gagal membuat timestamp adegan dari audio.');
    } finally {
      setLoading(false);
      setLoadingMode(null);
      setProgressInfo({ completedParts: 0, totalParts: 0, message: '' });
    }
  };

  const handleRetrySpecificRange = async (range: UncoveredRange) => {
    setErrorMsg(null);
    const rangeKey = `${range.chunkIndex}-${range.start}-${range.end}`;
    setRetryingRangeKey(rangeKey);
    setLoading(true);
    setLoadingMode('ai');

    try {
      const decoded = await ensureDecodedChunks();

      const targetChunk: AudioChunkSpec =
        decoded.chunks.find((c) => c.chunkIndex === range.chunkIndex) || {
          chunkIndex: decoded.chunks.length,
          startOffset: range.start,
          endOffset: range.end,
          duration: Math.round((range.end - range.start) * 100) / 100,
        };

      const totalParts = decoded.chunks.length;
      const labelNum =
        targetChunk.chunkIndex < totalParts ? targetChunk.chunkIndex + 1 : totalParts;
      setProgressInfo({
        completedParts: 0,
        totalParts: 1,
        message: `Mengulangi bagian ${labelNum} (${formatTimePrecise(targetChunk.startOffset)} – ${formatTimePrecise(targetChunk.endOffset)})...`,
      });

      if (chunkResultsRef.current.size === 0 && project.scenes.length > 0) {
        for (const ch of decoded.chunks) {
          if (ch.chunkIndex === targetChunk.chunkIndex) continue;
          const matching = project.scenes.filter(
            (s) => s.start >= ch.startOffset - 0.1 && s.end <= ch.endOffset + 0.1
          );
          if (matching.length > 0) {
            chunkResultsRef.current.set(ch.chunkIndex, matching);
          }
        }
      }

      const activeScriptHint = useScriptHintForAI ? refScript : '';
      const res = await processSingleChunkWithAutoRetry(
        decoded,
        targetChunk,
        totalParts,
        activeScriptHint
      );

      if (res.ok) {
        if (range.chunkIndex === -1) {
          const combined = [...project.scenes, ...res.scenes];
          const remaining = failedRanges.filter((r) => r !== range);
          if (remaining.length === 0) {
            const exactDuration = project.audioMeta?.duration || decoded.duration;
            const validated = validateAndNormalizeScenes(
              combined,
              exactDuration,
              project.minSceneSec,
              project.maxSceneSec,
              {
                flexible: true,
                audioWaveform: {
                  monoSamples: decoded.monoSamples,
                  sampleRate: decoded.sampleRate,
                },
              }
            );
            setFailedRanges([]);
            onUpdate({ scenes: validated });
          } else {
            setFailedRanges(remaining);
            onUpdate({
              scenes: combined.map((s, idx) => ({
                id: idx + 1,
                start: s.start,
                end: s.end,
                text: s.text,
              })),
            });
          }
        } else {
          chunkResultsRef.current.set(targetChunk.chunkIndex, res.scenes);
          const remaining = failedRanges.filter((r) => r.chunkIndex !== targetChunk.chunkIndex);
          commitMergedChunkResults(decoded, remaining);
        }
      } else {
        setErrorMsg(
          `Bagian ${formatTimePrecise(targetChunk.startOffset)} – ${formatTimePrecise(targetChunk.endOffset)} masih belum tercakup penuh (${res.reason || 'coba lagi'}).`
        );
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Gagal mencoba ulang bagian audio ini.');
    } finally {
      setLoading(false);
      setLoadingMode(null);
      setRetryingRangeKey(null);
      setProgressInfo({ completedParts: 0, totalParts: 0, message: '' });
    }
  };

  const handleTogglePlayScene = (scene: SceneItem) => {
    const el = audioRef.current;
    if (!el || !el.src) return;

    if (playingSceneId === scene.id) {
      el.pause();
      stopAtRef.current = null;
      setPlayingSceneId(null);
      setPlayingTimeSec(null);
      return;
    }

    el.currentTime = scene.start;
    stopAtRef.current = scene.end;
    setPlayingSceneId(scene.id);
    setPlayingTimeSec(scene.start);
    el.play().catch(() => {
      setPlayingSceneId(null);
      setPlayingTimeSec(null);
    });
  };

  const handleAudioTimeUpdate = () => {
    const el = audioRef.current;
    if (!el || stopAtRef.current === null) return;
    setPlayingTimeSec(el.currentTime);
    if (el.currentTime >= stopAtRef.current) {
      el.pause();
      stopAtRef.current = null;
      setPlayingSceneId(null);
      setPlayingTimeSec(null);
    }
  };

  const handleSceneFieldChange = (
    sceneId: number,
    field: 'start' | 'end' | 'text',
    value: string | number
  ) => {
    const idx = project.scenes.findIndex((s) => s.id === sceneId);
    if (idx === -1) return;

    const nextScenes = project.scenes.map((s) => ({ ...s }));
    if (field === 'text') {
      nextScenes[idx].text = String(value);
      onUpdate({ scenes: nextScenes });
      return;
    }

    const num = Math.round(Math.max(0, Number(value) || 0) * 100) / 100;
    if (field === 'start') {
      nextScenes[idx].start = num;
      if (idx > 0) {
        nextScenes[idx - 1].end = num;
      }
    } else if (field === 'end') {
      nextScenes[idx].end = num;
      if (idx < nextScenes.length - 1) {
        nextScenes[idx + 1].start = num;
      }
    }
    onUpdate({ scenes: nextScenes });
  };

  const handleSplitSceneIntoTwoVisualBeats = (sceneId: number) => {
    const splitList = splitSceneIntoTwoVisualBeats(project.scenes, sceneId);
    if (splitList.length === project.scenes.length) return;
    onUpdate({ scenes: splitList });
    setLastMethodNote(
      `Kalimat #${sceneId} berhasil dipecah menjadi 2 pergantian fokus visual pada jeda klausa alami (total ${splitList.length} adegan).`
    );
  };

  const handleNormalizeManualEdits = async () => {
    if (!project.audioMeta || project.scenes.length === 0) return;
    let waveform: { monoSamples: Float32Array; sampleRate: number } | null = null;
    try {
      const decoded = await ensureDecodedChunks();
      waveform = {
        monoSamples: decoded.monoSamples,
        sampleRate: decoded.sampleRate,
      };
    } catch {
      // ignore if audio blob isn't loaded
    }
    const rebalanced = rebalanceSceneTimestampsToSpeechDuration(
      project.scenes,
      project.audioMeta.duration,
      waveform
    );
    setFailedRanges([]);
    onUpdate({ scenes: rebalanced });
    setLastMethodNote(
      `Durasi ${rebalanced.length} timestamp berhasil diseimbangkan sesuai jumlah suku kata & jeda napas akhir kalimat.`
    );
  };

  const progressPercent =
    progressInfo.totalParts > 0
      ? Math.round((progressInfo.completedParts / progressInfo.totalParts) * 100)
      : 18;

  const canProceedToStep4 = project.scenes.length > 0 && coverage.isComplete;

  return (
    <section className="mx-auto max-w-[1200px] space-y-6" aria-labelledby="step3-heading">
      <audio
        ref={audioRef}
        onTimeUpdate={handleAudioTimeUpdate}
        onEnded={() => {
          setPlayingSceneId(null);
          setPlayingTimeSec(null);
        }}
        className="hidden"
      />

      {/* Header */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between border-b border-[#1D2230] pb-5">
        <div>
          <p className="text-xs font-medium text-[#5B9BD5]">Kotak 3 dari 6</p>
          <h1 id="step3-heading" className="mt-1 text-2xl font-bold tracking-tight text-white">
            Timestamp Fokus Visual &amp; Sinkronisasi Suara Narasi
          </h1>
          <p className="mt-1 text-sm text-[#8F9BB3]">
            Titik potong timestamp dikunci ke kurva suara aktif (VAD) dan jeda napas audio asli (±{project.minSceneSec}–{project.maxSceneSec} detik, fleksibel) agar pergantian foto di Kotak 5 sinkron 100% dengan suara.
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={onPrev}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[#2A3142] bg-[#141824] px-3.5 py-2 text-xs font-medium text-[#D2D8E6] hover:text-white whitespace-nowrap shrink-0"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Kotak 2</span>
          </button>
          <button
            type="button"
            onClick={onNext}
            disabled={!canProceedToStep4}
            title={
              canProceedToStep4
                ? 'Teruskan timestamp ke Kotak 4'
                : 'Cakupan timestamp harus 100% dari durasi audio sebelum lanjut ke Kotak 4'
            }
            className="inline-flex items-center gap-1.5 rounded-lg bg-[#5B9BD5] px-4 py-2 text-xs font-semibold text-[#0B0D12] hover:bg-[#73ACE0] disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap shrink-0"
          >
            <span>Lanjut ke Kotak 4</span>
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Controls: Target Sliders + Instant VAD Sync & AI Audio Transcription */}
      <div className="rounded-xl border border-[#1E2433] bg-[#12151E] p-5 space-y-4">
        <div className="grid grid-cols-1 gap-5 md:grid-cols-12 md:items-end">
          <div className="md:col-span-3 space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <label htmlFor="min-scene-slider" className="font-medium text-[#D2D8E6]">
                Ideal Minimal (fleksibel)
              </label>
              <span className="font-mono font-semibold text-[#5B9BD5] tabular-nums">
                ±{project.minSceneSec} dtk
              </span>
            </div>
            <input
              id="min-scene-slider"
              type="range"
              min={2}
              max={7}
              step={0.5}
              value={project.minSceneSec}
              onChange={(e) => {
                const v = Number(e.target.value);
                onUpdate({
                  minSceneSec: v,
                  maxSceneSec: Math.max(project.maxSceneSec, v + 1),
                });
              }}
              className="w-full accent-[#5B9BD5]"
            />
          </div>

          <div className="md:col-span-3 space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <label htmlFor="max-scene-slider" className="font-medium text-[#D2D8E6]">
                Ideal Maksimal (fleksibel)
              </label>
              <span className="font-mono font-semibold text-[#5B9BD5] tabular-nums">
                ±{project.maxSceneSec} dtk
              </span>
            </div>
            <input
              id="max-scene-slider"
              type="range"
              min={3.5}
              max={12}
              step={0.5}
              value={project.maxSceneSec}
              onChange={(e) => {
                const v = Number(e.target.value);
                onUpdate({
                  maxSceneSec: v,
                  minSceneSec: Math.min(project.minSceneSec, v - 1),
                });
              }}
              className="w-full accent-[#5B9BD5]"
            />
          </div>

          <div className="md:col-span-6 flex flex-wrap items-center justify-end gap-2">
            {project.scenes.length > 0 && project.audioMeta && (
              <button
                type="button"
                disabled={loading}
                onClick={handleSnapToVoicePauses}
                title="Kunci seluruh titik potong timestamp yang ada ke jeda napas/keheningan suara asli di gelombang audio"
                className="inline-flex items-center gap-1.5 rounded-lg border border-[#2C3A52] bg-[#161F30] px-3 py-2.5 text-xs font-medium text-[#9CC7F5] hover:border-[#5B9BD5] hover:text-white disabled:opacity-40 whitespace-nowrap shrink-0"
              >
                <Sliders className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Kunci ke Jeda Suara Asli</span>
              </button>
            )}

            {hasScript && (
              <button
                type="button"
                onClick={handleFastScriptAudioSync}
                disabled={loading || !project.audioMeta}
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#5B9BD5] px-4 py-2.5 text-xs font-semibold text-[#0B0D12] transition-colors hover:bg-[#73ACE0] disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                {loading && loadingMode === 'fast' ? (
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Zap className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                <span>
                  {project.scenes.length > 0
                    ? 'Sinkronkan Naskah + Jeda Audio (Instan)'
                    : 'Buat Timestamp dari Naskah + Audio (Instan)'}
                </span>
              </button>
            )}

            <button
              type="button"
              onClick={handleAnalyzeAudioWithAI}
              disabled={loading || !project.audioMeta}
              title="Dengarkan & transkripsikan kata-kata yang diucapkan langsung dari rekaman suara pakai Gemini AI"
              className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-xs font-semibold transition-colors disabled:opacity-50 whitespace-nowrap shrink-0 ${
                hasScript
                  ? 'border border-[#33415C] bg-[#161D2C] text-[#D2D8E6] hover:border-[#5B9BD5] hover:text-white'
                  : 'bg-[#5B9BD5] text-[#0B0D12] hover:bg-[#73ACE0]'
              }`}
            >
              {loading && loadingMode === 'ai' ? (
                <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : hasScript ? (
                <AudioLines className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              <span>
                {loading && loadingMode === 'ai'
                  ? progressInfo.totalParts > 0
                    ? `Transkripsi Suara AI (${progressInfo.completedParts}/${progressInfo.totalParts})`
                    : 'Menyiapkan Audio...'
                  : 'Transkripsi Suara Audio (AI)'}
              </span>
            </button>
          </div>
        </div>

        {/* Script Hint Toggle for AI Transcription & Helpful Mode Explanation */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#1C2130] pt-3 text-xs text-[#8F9BB3]">
          <p className="max-w-3xl">
            {hasScript
              ? '• Gunakan "Sinkronkan Naskah + Jeda Audio (Instan)" jika suara di Kotak 2 membaca naskah Kotak 1/2 (akurasi tinggi dengan deteksi suara aktif VAD). Gunakan "Transkripsi Suara Audio (AI)" jika rekaman suara di Kotak 2 berbeda dari naskah.'
              : '• Belum ada naskah di Kotak 1/2 — klik "Transkripsi Suara Audio (AI)" untuk mendengarkan rekaman suara per ±45 detik dan mengunci kalimat ke jeda napas audio.'}
          </p>

          {hasScript && (
            <label className="inline-flex items-center gap-2 rounded-lg border border-[#242D42] bg-[#0D111A] px-3 py-1.5 text-[11px] text-[#C5D2E8] cursor-pointer shrink-0">
              <input
                type="checkbox"
                checked={useScriptHintForAI}
                onChange={(e) => setUseScriptHintForAI(e.target.checked)}
                className="h-3.5 w-3.5 accent-[#5B9BD5]"
              />
              <span>Gunakan naskah sebagai panduan ejaan saat Transkripsi AI</span>
            </label>
          )}
        </div>

        {/* Progress Bar */}
        {loading && (
          <div className="space-y-1.5 pt-1">
            <div className="flex items-center justify-between text-xs text-[#B9CBE6] tabular-nums">
              <span>
                {progressInfo.message ||
                  (loadingMode === 'fast'
                    ? 'Menyelaraskan timestamp ke kurva suara aktif (VAD)...'
                    : loadingMode === 'snap'
                      ? 'Mengunci titik potong ke jeda keheningan suara...'
                      : `Memproses bagian ${progressInfo.completedParts} dari ${progressInfo.totalParts}`)}
              </span>
              <span>{progressPercent}%</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-[#1C2233]">
              <div
                className="h-full rounded-full bg-[#5B9BD5] transition-all duration-300"
                style={{ width: `${Math.max(10, progressPercent)}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {/* General Error */}
      {errorMsg && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#7F1D1D] bg-[#251317] px-4 py-3.5 text-sm text-[#FCA5A5]"
        >
          <div className="flex items-start gap-2.5">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{errorMsg}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {hasScript && project.audioMeta && (
              <button
                type="button"
                onClick={handleFastScriptAudioSync}
                disabled={loading}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[#5B9BD5] px-3 py-1.5 text-xs font-semibold text-[#0B0D12] hover:bg-[#73ACE0] disabled:opacity-40 whitespace-nowrap"
              >
                <Zap className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Pakai Sinkronisasi VAD Instan (Naskah + Audio)</span>
              </button>
            )}
            <button
              type="button"
              onClick={handleAnalyzeAudioWithAI}
              disabled={loading || !project.audioMeta}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#991B1B] bg-[#3B181F] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#4C1E27] disabled:opacity-40 whitespace-nowrap"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Coba lagi AI</span>
            </button>
          </div>
        </div>
      )}

      {/* Red Uncovered Ranges Alert with Per-Chunk Retry + Fast Sync Fallback */}
      {!loading && coverage.uncoveredRanges.length > 0 && project.audioMeta && (
        <div
          role="alert"
          className="space-y-3 rounded-xl border border-[#991B1B] bg-[#261216] p-4 text-sm text-[#FCA5A5]"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-2.5">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[#F87171]" aria-hidden="true" />
              <div>
                <p className="font-semibold text-[#FECACA]">
                  Ada bagian audio yang belum tercakup penuh ({coverage.percent}%)
                </p>
                <p className="mt-0.5 text-xs text-[#FCA5A5]">
                  Tombol &ldquo;Lanjut ke Kotak 4&rdquo; baru aktif setelah cakupan 100%. Ulangi bagian berikut atau pakai Sinkronisasi Naskah + Audio:
                </p>
              </div>
            </div>
            {hasScript && (
              <button
                type="button"
                disabled={loading}
                onClick={handleFastScriptAudioSync}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[#5B9BD5] px-3.5 py-2 text-xs font-semibold text-[#0B0D12] hover:bg-[#73ACE0] disabled:opacity-40 whitespace-nowrap shrink-0"
              >
                <Zap className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Selesaikan Instan (Naskah + Audio)</span>
              </button>
            )}
          </div>

          <div className="space-y-2">
            {coverage.uncoveredRanges.map((range, idx) => {
              const key = `${range.chunkIndex}-${range.start}-${range.end}`;
              const isRetryingThis = retryingRangeKey === key;
              return (
                <div
                  key={`${key}-${idx}`}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[#7F1D1D] bg-[#1C0D10] px-3.5 py-2.5 text-xs"
                >
                  <div className="space-y-0.5">
                    <p className="font-mono font-semibold text-white tabular-nums">
                      Rentang belum tercakup: {formatTimePrecise(range.start)} –{' '}
                      {formatTimePrecise(range.end)} ({range.start.toFixed(1)}s – {range.end.toFixed(1)}s)
                      {range.chunkIndex >= 0 ? ` · Bagian ${range.chunkIndex + 1}` : ''}
                    </p>
                    <p className="text-[#FCA5A5]">{range.reason}</p>
                  </div>
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => handleRetrySpecificRange(range)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-[#B91C1C] bg-[#7F1D1D] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#991B1B] disabled:opacity-40 whitespace-nowrap shrink-0"
                  >
                    <RefreshCw
                      className={`h-3.5 w-3.5 ${isRetryingThis ? 'animate-spin' : ''}`}
                      aria-hidden="true"
                    />
                    <span>Coba lagi bagian ini</span>
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Visual Focus Summary Card + Table */}
      {project.scenes.length > 0 ? (
        <>
          <div className="flex flex-col gap-4 rounded-xl border border-[#26354D] bg-[#131C2B] px-5 py-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-4">
              <div className="flex h-12 min-w-[56px] items-center justify-center rounded-xl bg-[#1D314F] px-3 font-mono text-lg font-extrabold text-[#7FB9EE] tabular-nums shrink-0">
                #{summary.count}
              </div>
              <div className="space-y-1">
                <p className="text-lg font-bold tracking-tight text-white tabular-nums sm:text-xl">
                  Total {summary.count} Titik Fokus Visual &amp; Timestamp
                </p>
                <div className="flex flex-wrap items-center gap-2 text-xs tabular-nums">
                  <span className="text-[#C5D2E8]">
                    Total Audio: {coverage.totalDuration.toFixed(1)} dtk
                  </span>
                  <span aria-hidden="true" className="text-[#4B556B]">
                    ·
                  </span>
                  <span className="text-[#C5D2E8]">
                    Rata-rata ~{summary.averageDuration} dtk/beat (Bervariasi Alami)
                  </span>
                  <span aria-hidden="true" className="text-[#4B556B]">
                    ·
                  </span>
                  <span
                    className={`inline-flex items-center gap-1.5 font-semibold ${
                      coverage.isComplete ? 'text-[#68D391]' : 'text-[#FCA5A5]'
                    }`}
                  >
                    {coverage.isComplete ? (
                      <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                    ) : (
                      <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                    Tercakup: {coverage.coveredSeconds.toFixed(1)} dari {coverage.totalDuration.toFixed(1)} dtk ({coverage.percent}%)
                  </span>
                </div>
                {lastMethodNote && (
                  <p className="text-[11px] text-[#8FA8CC]">{lastMethodNote}</p>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 self-start sm:self-auto shrink-0">
              <button
                type="button"
                onClick={handleNormalizeManualEdits}
                disabled={loading || !project.audioMeta}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[#2A3952] bg-[#162033] px-3 py-2 text-xs font-medium text-[#C5D8F5] hover:border-[#5B9BD5] hover:text-white disabled:opacity-40 whitespace-nowrap"
              >
                <span>Rapikan &amp; Kunci Jeda</span>
              </button>
              <button
                type="button"
                onClick={hasScript ? handleFastScriptAudioSync : handleAnalyzeAudioWithAI}
                disabled={loading || !project.audioMeta}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[#364A6B] bg-[#1A263A] px-3.5 py-2 text-xs font-medium text-[#E6EAF2] hover:border-[#5B9BD5] hover:text-white disabled:opacity-40 whitespace-nowrap"
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Hitung ulang</span>
              </button>
            </div>
          </div>

          {/* Paginated Visual Focus Table (12 items/page) */}
          <div className="overflow-hidden rounded-xl border border-[#1E2433] bg-[#12151E]">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1E2433] bg-[#0F121A] px-4 py-3">
              <h2 className="text-xs font-bold tracking-wide text-white uppercase tabular-nums">
                Tabel Timestamp Fokus Visual (1 s/d {project.scenes.length})
              </h2>
              <span className="text-xs text-[#8F9BB3]">
                Klik tombol ▶ Tes di kanan tiap baris untuk memverifikasi kecocokan suara &amp; kalimat
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-[#1E2433] bg-[#0D1018] text-[11px] font-semibold tracking-wider text-[#8F9BB3] uppercase">
                    <th className="w-20 px-4 py-3">Nomor</th>
                    <th className="w-56 px-4 py-3">Rentang Waktu</th>
                    <th className="px-4 py-3">Kalimat Percakapan &amp; Fokus Visual</th>
                    <th className="w-24 px-4 py-3 text-center">Tes Suara</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1A202E]">
                  {pagedScenes.map((scene) => {
                    const dur = Math.max(0, scene.end - scene.start);
                    const isPlaying = playingSceneId === scene.id;
                    const words = scene.text
                      .trim()
                      .split(/\s+/)
                      .filter(Boolean);
                    const wordCount = words.length;
                    const syllableCount = countIndonesianSyllables(scene.text);
                    const playProgress =
                      isPlaying && playingTimeSec !== null && dur > 0
                        ? Math.max(0, Math.min(1, (playingTimeSec - scene.start) / dur))
                        : 0;
                    const activeWordIdx =
                      isPlaying && wordCount > 0
                        ? Math.min(wordCount - 1, Math.floor(playProgress * wordCount))
                        : -1;

                    return (
                      <tr
                        key={scene.id}
                        className={`transition-colors ${
                          isPlaying ? 'bg-[#172336]' : 'hover:bg-[#161B27]/60'
                        }`}
                      >
                        <td className="px-4 py-3.5 align-top">
                          <span className="inline-flex h-7 min-w-[36px] items-center justify-center rounded-md bg-[#182336] px-2 font-mono text-xs font-bold text-[#7FB9EE] tabular-nums">
                            #{scene.id}
                          </span>
                        </td>
                        <td className="px-4 py-3.5 align-top">
                          <div className="space-y-1.5">
                            <p className="font-mono text-xs font-semibold text-white tabular-nums">
                              {formatTimePrecise(scene.start)} – {formatTimePrecise(scene.end)}
                            </p>
                            <p className="font-mono text-[11px] font-medium text-[#5B9BD5] tabular-nums">
                              Durasi {dur.toFixed(1)} dtk · {wordCount} kata (~{syllableCount} suku kata)
                            </p>
                            <div className="flex items-center gap-1 pt-0.5 font-mono text-[11px] tabular-nums">
                              <input
                                type="number"
                                step="0.1"
                                min={0}
                                aria-label={`Waktu mulai adegan ${scene.id}`}
                                value={scene.start}
                                onChange={(e) =>
                                  handleSceneFieldChange(scene.id, 'start', e.target.value)
                                }
                                className="w-16 rounded border border-[#242B3D] bg-[#0B0E15] px-1.5 py-0.5 text-[11px] text-[#C5CEE0] focus:border-[#5B9BD5] focus:text-white focus:outline-none"
                              />
                              <span className="text-[#5C667C]">–</span>
                              <input
                                type="number"
                                step="0.1"
                                min={0}
                                aria-label={`Waktu selesai adegan ${scene.id}`}
                                value={scene.end}
                                onChange={(e) =>
                                  handleSceneFieldChange(scene.id, 'end', e.target.value)
                                }
                                className="w-16 rounded border border-[#242B3D] bg-[#0B0E15] px-1.5 py-0.5 text-[11px] text-[#C5CEE0] focus:border-[#5B9BD5] focus:text-white focus:outline-none"
                              />
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3.5 align-top">
                          <div className="space-y-2">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="inline-flex items-center gap-1.5 rounded-md border border-[#24324A] bg-[#141D2D] px-2 py-0.5 text-[11px] font-medium text-[#8EBCE8]">
                                <Film className="h-3 w-3" aria-hidden="true" />
                                <span>
                                  Pergantian Fokus Visual (100% kalimat selesai sebelum pindah gambar)
                                </span>
                              </span>
                              {wordCount >= 8 && (
                                <button
                                  type="button"
                                  onClick={() => handleSplitSceneIntoTwoVisualBeats(scene.id)}
                                  title="Pecah kalimat ini menjadi 2 fokus visual terpisah tepat pada jeda klausa tengah kalimat"
                                  className="inline-flex items-center gap-1 rounded-md border border-[#2A3A56] bg-[#162134] px-2 py-0.5 text-[11px] font-medium text-[#A9CCF2] hover:border-[#5B9BD5] hover:text-white"
                                >
                                  <Scissors className="h-3 w-3" aria-hidden="true" />
                                  <span>Bagi 2 Fokus Visual</span>
                                </button>
                              )}
                            </div>
                            <textarea
                              rows={2}
                              aria-label={`Teks narasi adegan ${scene.id}`}
                              value={scene.text}
                              onChange={(e) =>
                                handleSceneFieldChange(scene.id, 'text', e.target.value)
                              }
                              className="w-full min-w-[260px] rounded-lg border border-[#232A3B] bg-[#0C0F16] px-3 py-2 text-xs leading-relaxed text-[#E6EAF2] focus:border-[#5B9BD5] focus:outline-none"
                            />
                            {isPlaying && words.length > 0 && (
                              <div className="rounded-lg border border-[#294063] bg-[#0F1826] px-2.5 py-1.5 text-[11px] leading-relaxed">
                                <div className="mb-1 flex items-center justify-between text-[10px] font-mono text-[#7FB9EE] tabular-nums">
                                  <span>Progres Ucapan Suara Narasi</span>
                                  <span>{Math.round(playProgress * 100)}% kalimat terucap</span>
                                </div>
                                <p className="flex flex-wrap gap-1">
                                  {words.map((w, wIdx) => (
                                    <span
                                      key={`${scene.id}-w-${wIdx}`}
                                      className={`rounded px-1 py-0.5 transition-colors ${
                                        wIdx < activeWordIdx
                                          ? 'text-[#8EBCE8]'
                                          : wIdx === activeWordIdx
                                            ? 'bg-[#5B9BD5] font-semibold text-[#0B0D12]'
                                            : 'text-[#6B778F]'
                                      }`}
                                    >
                                      {w}
                                    </span>
                                  ))}
                                </p>
                              </div>
                            )}
                            {scene.scenePrompt && (
                              <p className="rounded-lg border border-[#1E2636] bg-[#0B0E14] px-2.5 py-1.5 text-[11px] leading-relaxed text-[#9AA8C2]">
                                <span className="font-semibold text-[#F5C451]">Adegan Visual:</span>{' '}
                                {scene.scenePrompt}
                              </p>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3.5 text-center align-top">
                          <div className="flex flex-col items-center gap-1">
                            <button
                              type="button"
                              disabled={!project.audioMeta}
                              onClick={() => handleTogglePlayScene(scene)}
                              aria-label={
                                isPlaying
                                  ? `Hentikan audio adegan ${scene.id}`
                                  : `Putar audio adegan ${scene.id}`
                              }
                              className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border transition-colors disabled:opacity-40 ${
                                isPlaying
                                  ? 'border-[#5B9BD5] bg-[#1B2B42] text-[#5B9BD5]'
                                  : 'border-[#272E40] bg-[#161B27] text-[#C5CEE0] hover:border-[#3E4963] hover:text-white'
                              }`}
                            >
                              {isPlaying ? (
                                <Square className="h-3.5 w-3.5" aria-hidden="true" />
                              ) : (
                                <Play className="h-3.5 w-3.5" aria-hidden="true" />
                              )}
                            </button>
                            {isPlaying && playingTimeSec !== null && (
                              <span className="font-mono text-[10px] font-semibold text-[#F5C451] tabular-nums">
                                {formatTimePrecise(playingTimeSec)}
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Pagination Bar */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#1E2433] bg-[#0F121A] px-4 py-3 text-xs text-[#8F9BB3] tabular-nums">
              <span>
                Menampilkan {(safePage - 1) * PAGE_SIZE + 1}–
                {Math.min(safePage * PAGE_SIZE, project.scenes.length)} dari {project.scenes.length}{' '}
                adegan (12 per halaman)
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={safePage <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="inline-flex items-center gap-1 rounded-lg border border-[#272E40] bg-[#151A26] px-2.5 py-1.5 text-xs font-medium text-[#D2D8E6] hover:text-white disabled:opacity-40"
                >
                  <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Sebelumnya</span>
                </button>
                <span className="px-2 font-medium text-white">
                  Halaman {safePage} / {totalPages}
                </span>
                <button
                  type="button"
                  disabled={safePage >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  className="inline-flex items-center gap-1 rounded-lg border border-[#272E40] bg-[#151A26] px-2.5 py-1.5 text-xs font-medium text-[#D2D8E6] hover:text-white disabled:opacity-40"
                >
                  <span>Berikutnya</span>
                  <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>
            </div>
          </div>

          {/* Bottom Direct Forward CTA to Kotak 4 */}
          <div className="flex justify-end">
            <button
              type="button"
              onClick={onNext}
              disabled={!canProceedToStep4}
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[#5B9BD5] px-6 py-3.5 text-sm font-bold text-[#0B0D12] transition-colors hover:bg-[#73ACE0] disabled:opacity-40 disabled:cursor-not-allowed sm:w-auto tabular-nums"
            >
              <span>Teruskan {project.scenes.length} Timestamp ke Kotak 4 (Buat Prompt)</span>
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </>
      ) : (
        <div className="rounded-xl border border-[#1E2433] bg-[#12151E] p-10 text-center space-y-3">
          <p className="text-sm font-semibold text-white">Belum ada daftar timestamp fokus visual.</p>
          <p className="text-xs text-[#8F9BB3] max-w-xl mx-auto">
            {project.audioMeta
              ? hasScript
                ? `Audio "${project.audioMeta.fileName}" (${project.audioMeta.duration.toFixed(1)} detik) dan naskah siap! Klik "Buat Timestamp dari Naskah + Audio (Instan)" untuk menyelaraskan ke jeda suara aktif, atau klik "Transkripsi Suara Audio (AI)" jika suara berbeda dari naskah.`
                : `Audio "${project.audioMeta.fileName}" (${project.audioMeta.duration.toFixed(1)} detik) siap. Klik "Transkripsi Suara Audio (AI)" di atas untuk memulai.`
              : 'Upload file audio narasi di Kotak 2 terlebih dahulu sebelum membuat timestamp.'}
          </p>
        </div>
      )}
    </section>
  );
};
