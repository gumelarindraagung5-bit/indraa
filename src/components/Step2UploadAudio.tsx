import React, { useEffect, useRef, useState } from 'react';
import {
  Upload,
  FileAudio,
  Trash2,
  ArrowRight,
  ArrowLeft,
  AlertCircle,
  FileText,
  CheckCircle2,
  Zap,
  AudioLines,
} from 'lucide-react';
import type { SceneItem, StudioProject } from '../types/project';
import { decodeAndChunkAudioBlob } from '../utils/audioChunker';
import {
  decodeAudioInfo,
  deleteAudioBlob,
  formatBytes,
  getAudioBlob,
  saveAudioBlob,
} from '../utils/mediaDb';
import {
  alignScriptToVisualTimestamps,
  snapExistingScenesToAudioPauses,
} from '../utils/scriptTimestampAligner';
import { formatTimePrecise } from '../utils/timelineMath';

interface Step2Props {
  project: StudioProject;
  onUpdate: (patch: Partial<StudioProject>) => void;
  onPrev: () => void;
  onNext: () => void;
}

const TWENTY_MB = 20 * 1024 * 1024;

export const Step2UploadAudio: React.FC<Step2Props> = ({
  project,
  onUpdate,
  onPrev,
  onNext,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    let activeUrl: string | null = null;
    let cancelled = false;

    getAudioBlob()
      .then((rec) => {
        if (cancelled) return;
        if (rec?.blob) {
          activeUrl = URL.createObjectURL(rec.blob);
          setAudioUrl(activeUrl);
        } else {
          setAudioUrl(null);
        }
      })
      .catch(() => {
        if (!cancelled) setAudioUrl(null);
      });

    return () => {
      cancelled = true;
      if (activeUrl) URL.revokeObjectURL(activeUrl);
    };
  }, [project.audioMeta?.fileName, project.audioMeta?.fileSize]);

  const activeScript = (project.referenceScript || project.script || '').trim();
  const lastSceneEnd = project.scenes[project.scenes.length - 1]?.end || 0;
  const audioDur = project.audioMeta?.duration || 0;
  const isDurationSynced =
    project.scenes.length > 0 && audioDur > 0 && Math.abs(lastSceneEnd - audioDur) <= 0.35;

  const syncScenesWithWaveform = (
    scriptText: string,
    duration: number,
    waveform: { monoSamples: Float32Array; sampleRate: number } | null
  ): SceneItem[] | null => {
    if (scriptText.trim().length > 0) {
      const aligned = alignScriptToVisualTimestamps(scriptText, duration, {
        minSec: project.minSceneSec,
        maxSec: project.maxSceneSec,
        audioWaveform: waveform,
      });
      if (aligned.length > 0) {
        const prevById = new Map(project.scenes.map((s) => [s.id, s]));
        return aligned.map((scene) => {
          const prev = prevById.get(scene.id);
          return {
            ...scene,
            scenePrompt: prev?.text === scene.text ? prev.scenePrompt : prev?.scenePrompt,
            shotType: prev?.text === scene.text ? prev.shotType : prev?.shotType,
            imageId: prev?.imageId ?? null,
          };
        });
      }
    }
    return null;
  };

  const handleAudioFile = async (file: File) => {
    const validExt = /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(file.name);
    if (!file.type.startsWith('audio/') && !validExt) {
      setErrorMsg('Format file tidak didukung. Gunakan file audio MP3, WAV, atau M4A.');
      return;
    }

    setErrorMsg(null);
    setSyncMessage(null);
    setProcessing(true);
    try {
      let duration = 0;
      let waveform: { monoSamples: Float32Array; sampleRate: number } | null = null;

      try {
        const decoded = await decodeAndChunkAudioBlob(file, 45, 6);
        duration = decoded.duration;
        waveform = {
          monoSamples: decoded.monoSamples,
          sampleRate: decoded.sampleRate,
        };
      } catch {
        const info = await decodeAudioInfo(file, 64);
        duration = info.duration;
      }

      const mimeType =
        file.type ||
        (file.name.endsWith('.wav')
          ? 'audio/wav'
          : file.name.endsWith('.m4a')
            ? 'audio/mp4'
            : 'audio/mpeg');

      await saveAudioBlob({
        id: 'primary',
        blob: file,
        fileName: file.name,
        fileSize: file.size,
        mimeType,
        duration,
      });

      // Automatically synchronize timestamps with the newly uploaded audio's real voice pauses!
      let nextScenes: SceneItem[] | undefined;
      if (activeScript) {
        const synced = syncScenesWithWaveform(activeScript, duration, waveform);
        if (synced && synced.length > 0) {
          nextScenes = synced;
          setSyncMessage(
            `Timestamp otomatis diselaraskan ke jeda suara audio "${file.name}" (${synced.length} adegan, 00:00.0 – ${formatTimePrecise(duration)}). Jika isi suara audio berbeda dari naskah Kotak 1, klik "Transkripsi Suara Audio (AI)" di Kotak 3.`
          );
        }
      } else if (project.scenes.length > 0 && Math.abs(lastSceneEnd - duration) > 0.35) {
        // Scale existing scenes to match the new audio duration and snap to real pauses
        const scale = duration / Math.max(0.1, lastSceneEnd);
        const scaled: SceneItem[] = project.scenes.map((s, idx, arr) => ({
          ...s,
          start: idx === 0 ? 0 : Math.round(s.start * scale * 100) / 100,
          end:
            idx === arr.length - 1
              ? Math.round(duration * 100) / 100
              : Math.round(s.end * scale * 100) / 100,
        }));
        nextScenes = waveform
          ? snapExistingScenesToAudioPauses(scaled, duration, waveform)
          : scaled;
        setSyncMessage(
          `Rentang waktu ${nextScenes.length} adegan disesuaikan ke durasi audio baru (${formatTimePrecise(duration)}) dan dikunci ke jeda napas suara.`
        );
      }

      onUpdate({
        audioMeta: {
          fileName: file.name,
          fileSize: file.size,
          mimeType,
          duration,
          usesFilesApi: file.size > TWENTY_MB,
        },
        ...(nextScenes ? { scenes: nextScenes } : {}),
      });
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'Gagal membaca durasi audio. Pastikan file audio tidak rusak.'
      );
    } finally {
      setProcessing(false);
    }
  };

  const handleManualResyncInStep2 = async () => {
    if (!project.audioMeta) return;
    setErrorMsg(null);
    setProcessing(true);
    try {
      let waveform: { monoSamples: Float32Array; sampleRate: number } | null = null;
      const rec = await getAudioBlob();
      if (rec?.blob) {
        const decoded = await decodeAndChunkAudioBlob(rec.blob, 45, 6);
        waveform = {
          monoSamples: decoded.monoSamples,
          sampleRate: decoded.sampleRate,
        };
      }

      if (activeScript) {
        const synced = syncScenesWithWaveform(activeScript, project.audioMeta.duration, waveform);
        if (synced && synced.length > 0) {
          onUpdate({ scenes: synced });
          setSyncMessage(
            `Berhasil menyelaraskan ulang ${synced.length} timestamp mengikuti kurva suara aktif (VAD) & jeda hening audio (${formatTimePrecise(project.audioMeta.duration)}).`
          );
        }
      } else if (project.scenes.length > 0 && waveform) {
        const snapped = snapExistingScenesToAudioPauses(
          project.scenes,
          project.audioMeta.duration,
          waveform
        );
        onUpdate({ scenes: snapped });
        setSyncMessage(
          `Titik potong ${snapped.length} adegan berhasil dikunci ke jeda hening suara audio.`
        );
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Gagal menyelaraskan timestamp dengan audio.');
    } finally {
      setProcessing(false);
    }
  };

  const handleRemoveAudio = async () => {
    await deleteAudioBlob();
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
      setAudioUrl(null);
    }
    setSyncMessage(null);
    onUpdate({ audioMeta: null });
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleAudioFile(file);
  };

  return (
    <section className="mx-auto max-w-[1000px] space-y-8" aria-labelledby="step2-heading">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between border-b border-[#1D2230] pb-5">
        <div>
          <p className="text-xs font-medium text-[#5B9BD5]">Kotak 2 dari 6</p>
          <h1 id="step2-heading" className="mt-1 text-2xl font-bold tracking-tight text-white">
            Upload Audio Narasi
          </h1>
          <p className="mt-1 text-sm text-[#8F9BB3]">
            Unggah rekaman suara atau hasil TTS eksternal (MP3, WAV, M4A). Timestamp adegan otomatis diselaraskan ke jeda suara aktif (VAD) agar foto di Kotak 5 sinkron dengan narasi.
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={onPrev}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[#2A3142] bg-[#141824] px-3.5 py-2 text-xs font-medium text-[#D2D8E6] hover:text-white whitespace-nowrap shrink-0"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Kotak 1</span>
          </button>
          <button
            type="button"
            onClick={onNext}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[#5B9BD5] px-4 py-2 text-xs font-semibold text-[#0B0D12] hover:bg-[#73ACE0] whitespace-nowrap shrink-0"
          >
            <span>Lanjut ke Kotak 3</span>
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>

      {errorMsg && (
        <div
          role="alert"
          className="flex items-center gap-2.5 rounded-xl border border-[#7F1D1D] bg-[#251317] px-4 py-3 text-sm text-[#FCA5A5]"
        >
          <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{errorMsg}</span>
        </div>
      )}

      {syncMessage && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#1E4631] bg-[#10241A] px-4 py-3 text-xs text-[#86EFAC]"
        >
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-[#4ADE80]" aria-hidden="true" />
            <span>{syncMessage}</span>
          </div>
          <button
            type="button"
            onClick={onNext}
            className="inline-flex items-center gap-1 rounded-lg bg-[#166534] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#15803D] whitespace-nowrap shrink-0"
          >
            <span>Cek Timestamp di Kotak 3</span>
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      )}

      {/* Drag & Drop Audio Zone */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        className={`rounded-xl border-2 border-dashed p-8 text-center transition-colors ${
          isDragging
            ? 'border-[#5B9BD5] bg-[#162133]'
            : 'border-[#272F42] bg-[#12151E] hover:border-[#394561]'
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept="audio/mpeg,audio/wav,audio/mp4,audio/x-m4a,.mp3,.wav,.m4a"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleAudioFile(f);
            e.target.value = '';
          }}
          className="hidden"
          aria-label="Pilih file audio narasi"
        />

        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-[#182030] text-[#5B9BD5]">
          <Upload className="h-6 w-6" aria-hidden="true" />
        </div>

        <h2 className="mt-4 text-base font-semibold text-white">
          {processing
            ? 'Menganalisis gelombang suara (VAD) & jeda keheningan audio...'
            : 'Tarik & lepas file audio narasi di sini'}
        </h2>
        <p className="mt-1 text-xs text-[#8F9BB3]">
          Mendukung MP3, WAV, dan M4A. Sistem mendeteksi kurva suara aktif dan jeda napas agar titik potong timestamp akurat.
        </p>

        <button
          type="button"
          disabled={processing}
          onClick={() => inputRef.current?.click()}
          className="mt-5 inline-flex items-center gap-2 rounded-lg bg-[#5B9BD5] px-4 py-2 text-xs font-semibold text-[#0B0D12] transition-colors hover:bg-[#73ACE0] disabled:opacity-50"
        >
          <FileAudio className="h-4 w-4" aria-hidden="true" />
          <span>{project.audioMeta ? 'Ganti File Audio' : 'Pilih File Audio'}</span>
        </button>
      </div>

      {/* Audio Player & Metadata + Synchronization Status */}
      {project.audioMeta && (
        <div className="space-y-4 rounded-xl border border-[#1E2433] bg-[#12151E] p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 space-y-1.5">
              <p className="text-sm font-semibold text-white truncate">
                {project.audioMeta.fileName}
              </p>
              <div className="flex flex-wrap items-center gap-2 text-xs text-[#8F9BB3] tabular-nums">
                <span>
                  Durasi asli: {formatTimePrecise(project.audioMeta.duration)} (
                  {project.audioMeta.duration.toFixed(2)} dtk)
                </span>
                <span aria-hidden="true">·</span>
                <span>Ukuran: {formatBytes(project.audioMeta.fileSize)}</span>
                <span aria-hidden="true">·</span>
                <span
                  className={`inline-flex items-center gap-1 font-medium ${
                    isDurationSynced ? 'text-[#68D391]' : 'text-[#F5C451]'
                  }`}
                >
                  {isDurationSynced ? (
                    <>
                      <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>
                        Sinkron dengan {project.scenes.length} timestamp (00:00.0 –{' '}
                        {formatTimePrecise(lastSceneEnd)})
                      </span>
                    </>
                  ) : (
                    <>
                      <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>
                        Timestamp perlu diselaraskan ke durasi audio ini (
                        {formatTimePrecise(project.audioMeta.duration)})
                      </span>
                    </>
                  )}
                </span>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              {(activeScript || project.scenes.length > 0) && (
                <button
                  type="button"
                  disabled={processing}
                  onClick={handleManualResyncInStep2}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-[#2E4263] bg-[#172338] px-3 py-1.5 text-xs font-semibold text-[#8EC5FC] hover:border-[#5B9BD5] hover:text-white disabled:opacity-40 whitespace-nowrap"
                >
                  <Zap className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Selaraskan Timestamp ke Suara Ini</span>
                </button>
              )}

              <button
                type="button"
                onClick={handleRemoveAudio}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[#3B2026] bg-[#221418] px-3 py-1.5 text-xs font-medium text-[#FCA5A5] hover:bg-[#331920] whitespace-nowrap"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Hapus Audio</span>
              </button>
            </div>
          </div>

          {audioUrl && (
            <audio
              controls
              src={audioUrl}
              className="w-full"
              aria-label="Pemutar audio narasi"
            />
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[#1E2638] bg-[#0D111A] px-3.5 py-2.5 text-xs text-[#9AA8C2]">
            <div className="flex items-center gap-2">
              <AudioLines className="h-4 w-4 shrink-0 text-[#5B9BD5]" aria-hidden="true" />
              <span>
                <strong>Tips Sinkronisasi Suara &amp; Foto:</strong> Jika audio yang Anda upload adalah pembacaan dari naskah di bawah, klik{' '}
                <em>&ldquo;Selaraskan Timestamp ke Suara Ini&rdquo;</em>. Jika rekaman suara Anda berbeda dengan naskah Kotak 1, lanjut ke Kotak 3 lalu klik{' '}
                <em>&ldquo;Transkripsi Audio (AI)&rdquo;</em> agar kalimat mengikuti suara asli di audio.
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Optional Reference Script */}
      <div className="space-y-3 rounded-xl border border-[#1E2433] bg-[#12151E] p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <label htmlFor="ref-script-input" className="text-sm font-semibold text-white">
              Naskah Narasi Audio Ini (Untuk Sinkronisasi Timestamp &amp; Kalimat)
            </label>
            <p className="text-xs text-[#8F9BB3]">
              Tempel teks narasi yang persis diucapkan pada file audio di atas agar pembagian detik kalimat dan pergantian foto di Kotak 5 tepat 100%.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {project.script.trim() && (
              <button
                type="button"
                onClick={() => onUpdate({ referenceScript: project.script })}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[#2B3347] bg-[#181D2B] px-3 py-1.5 text-xs font-medium text-[#E6EAF2] hover:border-[#5B9BD5] hover:text-white whitespace-nowrap shrink-0"
              >
                <FileText className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Salin Naskah dari Kotak 1</span>
              </button>
            )}
            {project.audioMeta && (project.referenceScript || project.script).trim() && (
              <button
                type="button"
                disabled={processing}
                onClick={handleManualResyncInStep2}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[#5B9BD5] px-3 py-1.5 text-xs font-semibold text-[#0B0D12] hover:bg-[#73ACE0] disabled:opacity-40 whitespace-nowrap shrink-0"
              >
                <Zap className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Sinkronkan Naskah &amp; Audio Sekarang</span>
              </button>
            )}
          </div>
        </div>

        <textarea
          id="ref-script-input"
          rows={6}
          value={project.referenceScript}
          onChange={(e) => onUpdate({ referenceScript: e.target.value })}
          placeholder="Tempel naskah yang diucapkan di audio ini, atau kosongkan jika ingin AI mentranskripsi langsung dari suara audio di Kotak 3..."
          className="w-full rounded-lg border border-[#272E40] bg-[#0C0F16] p-3.5 text-sm leading-relaxed text-[#E6EAF2] placeholder-[#556076] focus:border-[#5B9BD5] focus:outline-none"
        />
      </div>
    </section>
  );
};
