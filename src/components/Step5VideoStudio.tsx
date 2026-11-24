import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Play,
  Pause,
  Upload,
  Sparkles,
  Trash2,
  ImagePlus,
  Download,
  FileText,
  FileJson,
  AlertTriangle,
  AlertCircle,
  RefreshCw,
  ArrowLeft,
  ArrowRight,
  Film,
  X,
  Zap,
  CheckCircle2,
} from 'lucide-react';
import type {
  ImageRecordMeta,
  SceneItem,
  StudioProject,
  SubtitleMode,
  SubtitlePosition,
} from '../types/project';
import { fetchWithRetry } from '../utils/apiClient';
import { decodeAndChunkAudioBlob } from '../utils/audioChunker';
import { renderStudioFrame } from '../utils/canvasRenderer';
import {
  createThumbnailFromBlob,
  decodeAudioInfo,
  deleteImageRecord,
  getAllImageRecords,
  getAudioBlob,
  saveImageRecord,
  saveManyImageRecords,
  type StoredImageRecord,
} from '../utils/mediaDb';
import {
  alignScriptToVisualTimestamps,
  snapExistingScenesToAudioPauses,
} from '../utils/scriptTimestampAligner';
import { triggerBlobDownload, triggerTextDownload } from '../utils/storage';
import { generateSrtContent } from '../utils/subtitleUtils';
import {
  assignUploadedImagesToScenes,
  compareNaturalFileName,
  extractSceneNumberFromFileName,
  findSceneAtTime,
  formatSceneCode,
  formatTimePrecise,
  nudgeCutBoundary,
} from '../utils/timelineMath';
import { exportStudioVideo, type ExportProgress, type ExportResult } from '../utils/videoExporter';
import { TimelineTrack } from './TimelineTrack';

interface Step5Props {
  project: StudioProject;
  onUpdate: (patch: Partial<StudioProject>) => void;
  onPrev: () => void;
  onNext: () => void;
}

const AI_MATCH_BATCH = 10;

export const Step5VideoStudio: React.FC<Step5Props> = ({
  project,
  onUpdate,
  onPrev,
  onNext,
}) => {
  const bulkUploadRef = useRef<HTMLInputElement>(null);
  const replaceImgRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Media caches (ObjectURLs & HTMLImageElements, zero base64 in React state!)
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [waveformPeaks, setWaveformPeaks] = useState<number[]>([]);
  const [thumbUrls, setThumbUrls] = useState<Map<string, string>>(new Map());
  const fullImageMapRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const objectUrlsToRevokeRef = useRef<string[]>([]);

  // Playback & selection state
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [selectedSceneId, setSelectedSceneId] = useState<number | null>(
    project.scenes[0]?.id ?? null
  );
  const [rightTab, setRightTab] = useState<'scene' | 'subtitle' | 'export'>('scene');

  // Upload, voice sync & AI matching state
  const [matchMode, setMatchMode] = useState<'name' | 'time'>('name');
  const [uploadingImages, setUploadingImages] = useState(false);
  const [syncingVoice, setSyncingVoice] = useState(false);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);
  const [aiMatching, setAiMatching] = useState(false);
  const [aiMatchProgress, setAiMatchProgress] = useState({ current: 0, total: 0, message: '' });
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Video Export state
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const exportAbortRef = useRef<AbortController | null>(null);

  const totalDuration = useMemo(() => {
    if (project.audioMeta?.duration) return project.audioMeta.duration;
    return project.scenes[project.scenes.length - 1]?.end || 0;
  }, [project.audioMeta?.duration, project.scenes]);

  const lastSceneEnd = project.scenes[project.scenes.length - 1]?.end || 0;
  const hasDurationMismatch =
    project.scenes.length > 0 &&
    project.audioMeta &&
    project.audioMeta.duration > 0 &&
    Math.abs(lastSceneEnd - project.audioMeta.duration) > 0.35;

  // Load Audio Blob + High-Resolution Waveform Peaks (1200 bins) from IndexedDB
  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;

    getAudioBlob()
      .then(async (rec) => {
        if (cancelled || !rec?.blob) return;
        setAudioBlob(rec.blob);
        url = URL.createObjectURL(rec.blob);
        setAudioUrl(url);
        const info = await decodeAudioInfo(rec.blob, 1200);
        if (!cancelled) {
          setWaveformPeaks(info.peaks);
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [project.audioMeta?.fileName, project.audioMeta?.fileSize]);

  // Draw current frame onto the single 16:9 <canvas> preview
  const drawPreviewAt = useCallback(
    (timeSec: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      renderStudioFrame({
        ctx,
        width: canvas.width,
        height: canvas.height,
        currentTime: timeSec,
        scenes: project.scenes,
        imageElements: fullImageMapRef.current,
        subtitleSettings: project.subtitleSettings,
        videoSettings: project.videoSettings,
      });
    },
    [project.scenes, project.subtitleSettings, project.videoSettings]
  );

  // Load Image Blobs (320px thumb URLs + full preview Image objects) from IndexedDB
  const reloadImageCaches = useCallback(async () => {
    const records = await getAllImageRecords();
    const nextThumbUrls = new Map<string, string>();
    const nextFullMap = new Map<string, HTMLImageElement>();
    const createdUrls: string[] = [];

    for (const rec of records) {
      const thumbUrl = URL.createObjectURL(rec.thumbBlob);
      createdUrls.push(thumbUrl);
      nextThumbUrls.set(rec.id, thumbUrl);

      const fullUrl = URL.createObjectURL(rec.originalBlob);
      createdUrls.push(fullUrl);
      const img = new Image();
      img.onload = () => {
        drawPreviewAt(audioRef.current?.currentTime ?? 0);
      };
      img.src = fullUrl;
      nextFullMap.set(rec.id, img);
    }

    // Revoke previous object URLs cleanly
    for (const old of objectUrlsToRevokeRef.current) {
      URL.revokeObjectURL(old);
    }
    objectUrlsToRevokeRef.current = createdUrls;
    fullImageMapRef.current = nextFullMap;
    setThumbUrls(nextThumbUrls);
  }, [drawPreviewAt]);

  useEffect(() => {
    reloadImageCaches();
    return () => {
      for (const u of objectUrlsToRevokeRef.current) {
        URL.revokeObjectURL(u);
      }
      objectUrlsToRevokeRef.current = [];
    };
  }, [reloadImageCaches]);

  // Re-draw when paused or settings/images change
  useEffect(() => {
    drawPreviewAt(currentTime);
    const timer = setTimeout(() => drawPreviewAt(currentTime), 120);
    return () => clearTimeout(timer);
  }, [drawPreviewAt, currentTime, thumbUrls]);

  // Master-clock playback loop synced strictly to ONE <audio> element
  useEffect(() => {
    if (!isPlaying) return;
    let rafId = 0;

    const tick = () => {
      const el = audioRef.current;
      if (!el || el.paused || el.ended) {
        setIsPlaying(false);
        return;
      }
      const t = el.currentTime;
      setCurrentTime(t);
      drawPreviewAt(t);
      const { scene } = findSceneAtTime(project.scenes, t);
      if (scene) {
        setSelectedSceneId((prev) => (prev === scene.id ? prev : scene.id));
      }
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [isPlaying, drawPreviewAt, project.scenes]);

  const handleTogglePlay = useCallback(() => {
    const el = audioRef.current;
    if (!el || !audioUrl) {
      setErrorMsg('Belum ada audio narasi. Upload audio di Kotak 2 untuk memutar preview.');
      return;
    }
    setErrorMsg(null);
    if (el.paused) {
      el.play()
        .then(() => setIsPlaying(true))
        .catch(() => setIsPlaying(false));
    } else {
      el.pause();
      setIsPlaying(false);
    }
  }, [audioUrl]);

  // Spacebar shortcut for Play/Pause (ignored when typing inside inputs/textareas)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') {
        return;
      }
      e.preventDefault();
      handleTogglePlay();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleTogglePlay]);

  const handleSeek = (timeSec: number) => {
    const clamped = Math.max(0, Math.min(totalDuration || 0, timeSec));
    if (audioRef.current) {
      audioRef.current.currentTime = clamped;
    }
    setCurrentTime(clamped);
    drawPreviewAt(clamped);
    const { scene } = findSceneAtTime(project.scenes, clamped);
    if (scene) setSelectedSceneId(scene.id);
  };

  /**
   * 1-Click Audio-to-Photo Synchronization right inside Kotak 5:
   * Snaps all scene cut boundaries to the real acoustic silence valleys (and scales/aligns to exact audio duration)
   * while preserving every photo (`imageId`) and prompt (`scenePrompt`) already placed on the timeline.
   */
  const handleSyncPhotosAndAudioVoice = async (realignFromScript = false) => {
    if (project.scenes.length === 0) return;
    setErrorMsg(null);
    setSyncNotice(null);
    setSyncingVoice(true);

    try {
      const rec = await getAudioBlob();
      if (!rec?.blob) {
        throw new Error('File audio belum diunggah di Kotak 2.');
      }

      const decoded = await decodeAndChunkAudioBlob(rec.blob, 45, 6);
      const exactDur = project.audioMeta?.duration || decoded.duration;
      const waveform = {
        monoSamples: decoded.monoSamples,
        sampleRate: decoded.sampleRate,
      };

      const prevById = new Map(project.scenes.map((s) => [s.id, s]));
      const activeScript = (project.referenceScript || project.script || '').trim();

      let nextScenes: SceneItem[];
      if (realignFromScript && activeScript.length > 0) {
        const aligned = alignScriptToVisualTimestamps(activeScript, exactDur, {
          minSec: project.minSceneSec,
          maxSec: project.maxSceneSec,
          audioWaveform: waveform,
        });
        nextScenes = aligned.map((s, idx) => {
          const prev = prevById.get(s.id) || project.scenes[idx];
          return {
            ...s,
            imageId: prev?.imageId ?? null,
            scenePrompt: prev?.scenePrompt,
            shotType: prev?.shotType,
          };
        });
      } else {
        // Scale to exact audio duration if needed, then snap every cut boundary to real acoustic voice pauses
        const currentEnd = project.scenes[project.scenes.length - 1]?.end || exactDur;
        const scale = Math.abs(currentEnd - exactDur) > 0.25 ? exactDur / Math.max(0.1, currentEnd) : 1;
        const scaled = project.scenes.map((s, idx, arr) => ({
          ...s,
          start: idx === 0 ? 0 : Math.round(s.start * scale * 100) / 100,
          end:
            idx === arr.length - 1
              ? Math.round(exactDur * 100) / 100
              : Math.round(s.end * scale * 100) / 100,
        }));
        nextScenes = snapExistingScenesToAudioPauses(scaled, exactDur, waveform);
      }

      onUpdate({ scenes: nextScenes });
      setSyncNotice(
        `Berhasil mengunci titik pergantian ${nextScenes.length} foto ke jeda napas & kurva suara narasi (00:00.0 – ${formatTimePrecise(exactDur)}).`
      );
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Gagal menyinkronkan titik potong foto dengan suara.'
      );
    } finally {
      setSyncingVoice(false);
    }
  };

  // Multi-image upload & smart scene assignment (respects filename numbers & multi-batch uploads without overwriting Scene #1)
  const handleBulkImageUpload = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setErrorMsg(null);
    setSyncNotice(null);
    setUploadingImages(true);

    try {
      const files = Array.from(fileList).filter((f) => f.type.startsWith('image/'));
      if (files.length === 0) {
        setErrorMsg('Tidak ada file gambar valid yang dipilih.');
        return;
      }

      if (matchMode === 'name') {
        files.sort((a, b) => compareNaturalFileName(a.name, b.name));
      } else {
        files.sort((a, b) => a.lastModified - b.lastModified);
      }

      const storedRecords: StoredImageRecord[] = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const { thumbBlob, width, height } = await createThumbnailFromBlob(f, 320);
        const id = `img-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 7)}`;
        storedRecords.push({
          id,
          fileName: f.name,
          lastModified: f.lastModified,
          fileSize: f.size,
          mimeType: f.type || 'image/png',
          width,
          height,
          originalBlob: f,
          thumbBlob,
        });
      }

      await saveManyImageRecords(storedRecords);

      const newMeta: ImageRecordMeta[] = storedRecords.map(
        ({ originalBlob: _o, thumbBlob: _t, ...meta }) => meta
      );
      const mergedMeta = [...project.imagesMeta, ...newMeta];

      // Smart assignment: matches explicit filename numbers (e.g. scene_005.png -> Adegan #5)
      // or fills empty scenes sequentially without overwriting Scene #1 on multi-batch uploads!
      const updatedScenes = assignUploadedImagesToScenes(project.scenes, newMeta, matchMode);

      onUpdate({
        imagesMeta: mergedMeta,
        scenes: updatedScenes,
      });

      await reloadImageCaches();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Gagal memproses gambar yang diunggah.');
    } finally {
      setUploadingImages(false);
    }
  };

  // Re-apply sorting mode on already uploaded images (respecting explicit scene numbers in filenames when mode === 'name')
  const handleReassignByMode = (mode: 'name' | 'time') => {
    setMatchMode(mode);
    if (project.imagesMeta.length === 0 || project.scenes.length === 0) return;

    const clearedScenes = project.scenes.map((s) => ({ ...s, imageId: null }));
    const updatedScenes = assignUploadedImagesToScenes(
      clearedScenes,
      project.imagesMeta.map((m) => ({
        id: m.id,
        fileName: m.fileName,
        lastModified: m.lastModified,
      })),
      mode
    );
    onUpdate({ scenes: updatedScenes });
  };

  // Mode (c): AI Match using 320px thumbnails in batches of 10 images
  const handleMatchImagesWithAI = async () => {
    if (project.scenes.length === 0) {
      setErrorMsg('Belum ada daftar adegan untuk dicocokkan.');
      return;
    }

    const allImages = await getAllImageRecords();
    if (allImages.length === 0) {
      setErrorMsg('Upload gambar terlebih dahulu sebelum menjalankan pencocokan AI.');
      return;
    }

    setErrorMsg(null);
    setAiMatching(true);
    const totalBatches = Math.ceil(allImages.length / AI_MATCH_BATCH);
    const assignedMap = new Map<number, string>();
    const availableSceneIds = new Set(project.scenes.map((s) => s.id));

    try {
      for (let i = 0; i < allImages.length; i += AI_MATCH_BATCH) {
        const batchNum = Math.floor(i / AI_MATCH_BATCH) + 1;
        const batchImages = allImages.slice(i, i + AI_MATCH_BATCH);
        setAiMatchProgress({
          current: batchNum,
          total: totalBatches,
          message: `Mencocokkan gambar batch ${batchNum} dari ${totalBatches} (${batchImages.length} thumbnail 320px)...`,
        });

        const candidateScenes = project.scenes
          .filter((s) => availableSceneIds.has(s.id))
          .map((s) => ({
            id: s.id,
            text: s.text,
            scenePrompt: s.scenePrompt || '',
          }));

        if (candidateScenes.length === 0) break;

        const formData = new FormData();
        formData.append('scenes', JSON.stringify(candidateScenes));
        formData.append('imageIds', JSON.stringify(batchImages.map((img) => img.id)));
        batchImages.forEach((img, idx) => {
          formData.append('thumbnails', img.thumbBlob, `thumb_${idx}.jpg`);
        });

        const data = await fetchWithRetry<{
          matches: Array<{ imageIndex: number; sceneId: number }>;
        }>(
          '/api/ai/match-images',
          {
            method: 'POST',
            body: formData,
          },
          { maxRetries: 2 }
        );

        for (const m of data.matches || []) {
          const imgRec = batchImages[m.imageIndex];
          if (imgRec && availableSceneIds.has(m.sceneId)) {
            assignedMap.set(m.sceneId, imgRec.id);
            availableSceneIds.delete(m.sceneId);
          }
        }
      }

      const updatedScenes = project.scenes.map((s) => ({
        ...s,
        imageId: assignedMap.get(s.id) ?? s.imageId ?? null,
      }));
      onUpdate({ scenes: updatedScenes });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Gagal mencocokkan gambar dengan AI.');
    } finally {
      setAiMatching(false);
    }
  };

  // Selected scene editing actions
  const selectedSceneIndex = useMemo(
    () => project.scenes.findIndex((s) => s.id === selectedSceneId),
    [project.scenes, selectedSceneId]
  );
  const selectedScene: SceneItem | null =
    selectedSceneIndex >= 0 ? project.scenes[selectedSceneIndex] : project.scenes[0] || null;

  const handleReplaceSelectedImage = async (file: File) => {
    if (!selectedScene) return;
    const { thumbBlob, width, height } = await createThumbnailFromBlob(file, 320);
    const id = `img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const record: StoredImageRecord = {
      id,
      fileName: file.name,
      lastModified: file.lastModified,
      fileSize: file.size,
      mimeType: file.type || 'image/png',
      width,
      height,
      originalBlob: file,
      thumbBlob,
    };
    await saveImageRecord(record);

    const { originalBlob: _o, thumbBlob: _t, ...meta } = record;
    const updatedScenes = project.scenes.map((s) =>
      s.id === selectedScene.id ? { ...s, imageId: id } : s
    );

    onUpdate({
      imagesMeta: [...project.imagesMeta, meta],
      scenes: updatedScenes,
    });
    await reloadImageCaches();
  };

  const handleRemoveSelectedImage = async () => {
    if (!selectedScene || !selectedScene.imageId) return;
    const removedId = selectedScene.imageId;
    const updatedScenes = project.scenes.map((s) =>
      s.id === selectedScene.id ? { ...s, imageId: null } : s
    );
    const stillUsed = updatedScenes.some((s) => s.imageId === removedId);
    if (!stillUsed) {
      await deleteImageRecord(removedId).catch(() => {});
    }
    onUpdate({
      scenes: updatedScenes,
      imagesMeta: stillUsed
        ? project.imagesMeta
        : project.imagesMeta.filter((m) => m.id !== removedId),
    });
    await reloadImageCaches();
  };

  const handleNudge = (delta: number) => {
    if (selectedSceneIndex < 0 || selectedSceneIndex >= project.scenes.length - 1) return;
    const updated = nudgeCutBoundary(project.scenes, selectedSceneIndex, delta);
    onUpdate({ scenes: updated });
  };

  // Warnings calculation
  const missingImagesCount = useMemo(
    () => project.scenes.filter((s) => !s.imageId).length,
    [project.scenes]
  );

  // Export handlers
  const handleStartVideoExport = async () => {
    if (!audioBlob || project.scenes.length === 0) {
      setErrorMsg('Pastikan audio narasi (Kotak 2) dan adegan (Kotak 3) sudah tersedia sebelum export video.');
      return;
    }

    setErrorMsg(null);
    setExportResult(null);
    setExporting(true);
    const controller = new AbortController();
    exportAbortRef.current = controller;

    try {
      const result = await exportStudioVideo({
        audioBlob,
        duration: totalDuration,
        scenes: project.scenes,
        subtitleSettings: project.subtitleSettings,
        videoSettings: project.videoSettings,
        signal: controller.signal,
        onProgress: (p) => setExportProgress(p),
      });
      setExportResult(result);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Gagal mengekspor video.');
    } finally {
      setExporting(false);
      exportAbortRef.current = null;
    }
  };

  const handleDownloadVideo = () => {
    if (!exportResult) return;
    const slug = (project.selectedTitle || 'stickman-video')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);
    triggerBlobDownload(`${slug || 'stickman-video'}.${exportResult.extension}`, exportResult.blob);
  };

  const handleDownloadSrt = () => {
    const srt = generateSrtContent(project.scenes);
    triggerTextDownload('subtitle-stickman.srt', srt);
  };

  const handleExportTimelineJson = () => {
    const payload = {
      title: project.selectedTitle,
      totalDuration,
      videoSettings: project.videoSettings,
      subtitleSettings: project.subtitleSettings,
      scenes: project.scenes,
    };
    triggerTextDownload(
      'timeline-stickman.json',
      JSON.stringify(payload, null, 2),
      'application/json'
    );
  };

  // Find current image metadata for selectedScene
  const selectedImageMeta = useMemo(() => {
    if (!selectedScene?.imageId) return null;
    return project.imagesMeta.find((m) => m.id === selectedScene.imageId) || null;
  }, [selectedScene?.imageId, project.imagesMeta]);

  return (
    <section className="mx-auto max-w-[1380px] space-y-5" aria-labelledby="step5-heading">
      {/* Single Master Audio Element (NO <video> element for preview!) */}
      <audio
        ref={audioRef}
        src={audioUrl || undefined}
        onEnded={() => setIsPlaying(false)}
        className="hidden"
      />

      {/* Header */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between border-b border-[#1D2230] pb-4">
        <div>
          <p className="text-xs font-medium text-[#5B9BD5]">Kotak 5 dari 6</p>
          <h1 id="step5-heading" className="mt-1 text-2xl font-bold tracking-tight text-white">
            Studio Editing Video &amp; Sinkronisasi Foto-Suara
          </h1>
          <p className="mt-1 text-sm text-[#8F9BB3]">
            Unggah foto adegan (mendukung penomoran otomatis maupun bertahap), kunci batas foto ke jeda gelombang suara, lalu render MP4.
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={onPrev}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[#2A3142] bg-[#141824] px-3.5 py-2 text-xs font-medium text-[#D2D8E6] hover:text-white whitespace-nowrap shrink-0"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Kotak 4</span>
          </button>
          <button
            type="button"
            onClick={onNext}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[#5B9BD5] px-4 py-2 text-xs font-semibold text-[#0B0D12] hover:bg-[#73ACE0] whitespace-nowrap shrink-0"
          >
            <span>Lanjut ke Kotak 6</span>
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Duration mismatch alert if Kotak 2 audio duration differs from scene end */}
      {hasDurationMismatch && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#854D0E] bg-[#26190B] px-4 py-3 text-xs text-[#FDE68A]"
        >
          <div className="flex items-center gap-2.5">
            <AlertTriangle className="h-4 w-4 shrink-0 text-[#F5C451]" aria-hidden="true" />
            <span>
              Durasi audio Kotak 2 ({formatTimePrecise(totalDuration)}) belum sama dengan batas akhir timestamp adegan ({formatTimePrecise(lastSceneEnd)}). Klik tombol di kanan agar foto dan suara langsung sinkron.
            </span>
          </div>
          <button
            type="button"
            disabled={syncingVoice}
            onClick={() => handleSyncPhotosAndAudioVoice(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[#F5C451] px-3.5 py-1.5 text-xs font-bold text-[#0B0D12] hover:bg-[#F7D070] disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            <Zap className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Sinkronkan Foto &amp; Suara Sekarang</span>
          </button>
        </div>
      )}

      {syncNotice && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#1E4631] bg-[#10241A] px-4 py-2.5 text-xs text-[#86EFAC]"
        >
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-[#4ADE80]" aria-hidden="true" />
            <span>{syncNotice}</span>
          </div>
          <button
            type="button"
            onClick={() => setSyncNotice(null)}
            className="text-[#86EFAC] hover:text-white"
            aria-label="Tutup notifikasi sinkronisasi"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      )}

      {/* Top Upload & Matching Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#1E2433] bg-[#12151E] px-4 py-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <input
            ref={bulkUploadRef}
            type="file"
            multiple
            accept="image/*"
            onChange={(e) => {
              handleBulkImageUpload(e.target.files);
              e.target.value = '';
            }}
            className="hidden"
            aria-label="Upload banyak gambar adegan"
          />
          <button
            type="button"
            disabled={uploadingImages}
            onClick={() => bulkUploadRef.current?.click()}
            className="inline-flex items-center gap-2 rounded-lg bg-[#5B9BD5] px-3.5 py-2 text-xs font-semibold text-[#0B0D12] hover:bg-[#73ACE0] disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            <Upload className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{uploadingImages ? 'Membuat Thumbnail 320px...' : 'Upload Gambar Banyak'}</span>
          </button>

          <div className="flex items-center gap-1 rounded-lg bg-[#0C0F16] p-1 border border-[#22283A]">
            <button
              type="button"
              onClick={() => handleReassignByMode('name')}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                matchMode === 'name'
                  ? 'bg-[#1D273B] text-white'
                  : 'text-[#8F9BB3] hover:text-white'
              }`}
            >
              Urut Nomor / Nama File
            </button>
            <button
              type="button"
              onClick={() => handleReassignByMode('time')}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                matchMode === 'time'
                  ? 'bg-[#1D273B] text-white'
                  : 'text-[#8F9BB3] hover:text-white'
              }`}
            >
              Urut Waktu File
            </button>
          </div>

          <button
            type="button"
            disabled={aiMatching || project.imagesMeta.length === 0}
            onClick={handleMatchImagesWithAI}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[#2E384F] bg-[#161D2C] px-3 py-2 text-xs font-medium text-[#E6EAF2] hover:border-[#5B9BD5] hover:text-white disabled:opacity-40 whitespace-nowrap shrink-0"
          >
            {aiMatching ? (
              <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Sparkles className="h-3.5 w-3.5 text-[#5B9BD5]" aria-hidden="true" />
            )}
            <span>{aiMatching ? 'Mencocokkan AI...' : 'Cocokkan Gambar via AI'}</span>
          </button>

          <button
            type="button"
            disabled={syncingVoice || project.scenes.length === 0 || !audioBlob}
            onClick={() => handleSyncPhotosAndAudioVoice(false)}
            title="Selaraskan kembali seluruh titik potong foto dengan jeda keheningan suara narasi"
            className="inline-flex items-center gap-1.5 rounded-lg border border-[#2F4363] bg-[#172337] px-3 py-2 text-xs font-semibold text-[#8EC5FC] hover:border-[#5B9BD5] hover:text-white disabled:opacity-40 whitespace-nowrap shrink-0"
          >
            {syncingVoice ? (
              <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Zap className="h-3.5 w-3.5 text-[#F5C451]" aria-hidden="true" />
            )}
            <span>Sinkronkan Foto &amp; Jeda Suara</span>
          </button>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            disabled={project.scenes.length === 0}
            onClick={handleDownloadSrt}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[#272E40] bg-[#161B27] px-3 py-1.5 text-xs font-medium text-[#D2D8E6] hover:text-white disabled:opacity-40 whitespace-nowrap shrink-0"
          >
            <FileText className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Subtitle (.srt)</span>
          </button>
          <button
            type="button"
            disabled={project.scenes.length === 0}
            onClick={handleExportTimelineJson}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[#272E40] bg-[#161B27] px-3 py-1.5 text-xs font-medium text-[#D2D8E6] hover:text-white disabled:opacity-40 whitespace-nowrap shrink-0"
          >
            <FileJson className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Timeline (.json)</span>
          </button>
        </div>
      </div>

      {/* AI Matching Progress Bar */}
      {aiMatching && (
        <div className="rounded-xl border border-[#23324A] bg-[#131C2B] px-4 py-3 space-y-1.5">
          <div className="flex justify-between text-xs text-[#B9CBE6] tabular-nums">
            <span>{aiMatchProgress.message}</span>
            <span>
              {aiMatchProgress.current}/{aiMatchProgress.total}
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#1C273B]">
            <div
              className="h-full rounded-full bg-[#5B9BD5] transition-all"
              style={{
                width: `${
                  aiMatchProgress.total > 0
                    ? Math.round((aiMatchProgress.current / aiMatchProgress.total) * 100)
                    : 15
                }%`,
              }}
            />
          </div>
        </div>
      )}

      {/* Warnings & Errors */}
      {missingImagesCount > 0 && project.scenes.length > 0 && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-2.5 rounded-xl border border-[#6E4B15] bg-[#241B0E] px-4 py-2.5 text-xs text-[#FBD38D]"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            <strong>{missingImagesCount} dari {project.scenes.length} adegan</strong> belum memiliki gambar. Anda dapat mengunggah foto berikutnya secara bertahap (otomatis mengisi adegan kosong atau sesuai nomor di nama file tanpa menimpa Adegan #1).
          </span>
        </div>
      )}

      {errorMsg && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#7F1D1D] bg-[#251317] px-4 py-2.5 text-xs text-[#FCA5A5]"
        >
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{errorMsg}</span>
          </div>
          <button
            type="button"
            onClick={() => setErrorMsg(null)}
            aria-label="Tutup pesan kesalahan"
            className="text-[#FCA5A5] hover:text-white"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      )}

      {/* Main Split Studio: Left 16:9 Canvas Preview + Right Inspector Panel */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        {/* Left: 16:9 Preview Canvas */}
        <div className="space-y-3 lg:col-span-7">
          <div className="overflow-hidden rounded-xl border border-[#1E2433] bg-[#080A0F]">
            <canvas
              ref={canvasRef}
              width={1280}
              height={720}
              data-testid="studio-preview-canvas"
              className="aspect-video w-full block bg-black"
            />
          </div>

          {/* Transport Bar */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#1E2433] bg-[#12151E] px-4 py-2.5">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleTogglePlay}
                className="inline-flex items-center gap-2 rounded-lg bg-[#5B9BD5] px-4 py-2 text-xs font-semibold text-[#0B0D12] hover:bg-[#73ACE0] whitespace-nowrap shrink-0"
              >
                {isPlaying ? (
                  <>
                    <Pause className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Jeda</span>
                  </>
                ) : (
                  <>
                    <Play className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Putar Preview</span>
                  </>
                )}
              </button>

              <span className="font-mono text-xs text-[#D2D8E6] tabular-nums">
                {formatTimePrecise(currentTime)} / {formatTimePrecise(totalDuration)}
              </span>

              {selectedScene && (
                <span className="hidden sm:inline-flex items-center rounded-md bg-[#182235] px-2 py-0.5 font-mono text-[11px] font-semibold text-[#7FB9EE] tabular-nums">
                  Aktif: #{selectedScene.id} ({formatTimePrecise(selectedScene.start)}–{formatTimePrecise(selectedScene.end)})
                </span>
              )}
            </div>

            <span className="text-xs text-[#7C879E]">
              Tekan Spasi untuk Putar / Jeda
            </span>
          </div>
        </div>

        {/* Right: Tabbed Studio Panel (Adegan / Subtitle / Export) */}
        <div className="flex flex-col rounded-xl border border-[#1E2433] bg-[#12151E] lg:col-span-5">
          <div
            role="tablist"
            aria-label="Panel pengaturan studio"
            className="grid grid-cols-3 border-b border-[#1E2433] p-1.5 gap-1 bg-[#0E1119] rounded-t-xl"
          >
            {[
              { id: 'scene' as const, label: 'Edit Adegan' },
              { id: 'subtitle' as const, label: 'Subtitle' },
              { id: 'export' as const, label: 'Export Video' },
            ].map((tab) => (
              <button
                key={tab.id}
                role="tab"
                type="button"
                aria-selected={rightTab === tab.id}
                onClick={() => setRightTab(tab.id)}
                className={`rounded-lg py-2 text-xs font-semibold transition-colors whitespace-nowrap ${
                  rightTab === tab.id
                    ? 'bg-[#1A2436] text-white'
                    : 'text-[#8F9BB3] hover:text-white'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="flex-1 p-4 space-y-4">
            {/* TAB 1: Selected Scene Editor */}
            {rightTab === 'scene' && (
              <>
                {selectedScene ? (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between gap-2">
                      <h2 className="text-sm font-semibold text-white tabular-nums">
                        {formatSceneCode(selectedScene.id)} ({formatTimePrecise(selectedScene.start)} –{' '}
                        {formatTimePrecise(selectedScene.end)})
                      </h2>
                      <span className="font-mono text-xs text-[#5B9BD5] tabular-nums">
                        Durasi {(selectedScene.end - selectedScene.start).toFixed(1)} dtk
                      </span>
                    </div>

                    {/* Thumbnail & Replace/Delete */}
                    <div className="flex items-center gap-3">
                      <div className="h-20 w-36 shrink-0 overflow-hidden rounded-lg border border-[#262E42] bg-[#0B0E14]">
                        {selectedScene.imageId && thumbUrls.get(selectedScene.imageId) ? (
                          <img
                            src={thumbUrls.get(selectedScene.imageId)}
                            alt={`Preview ${formatSceneCode(selectedScene.id)}`}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center text-[11px] text-[#7C879E]">
                            Belum ada gambar
                          </div>
                        )}
                      </div>

                      <div className="flex flex-col gap-1.5 min-w-0">
                        {selectedImageMeta && (
                          <p className="truncate text-[11px] text-[#8FA8CC]" title={selectedImageMeta.fileName}>
                            File: {selectedImageMeta.fileName}
                            {extractSceneNumberFromFileName(selectedImageMeta.fileName)
                              ? ` (Nomor #${extractSceneNumberFromFileName(selectedImageMeta.fileName)})`
                              : ''}
                          </p>
                        )}
                        <input
                          ref={replaceImgRef}
                          type="file"
                          accept="image/*"
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) handleReplaceSelectedImage(f);
                            e.target.value = '';
                          }}
                          className="hidden"
                          aria-label="Ganti gambar adegan terpilih"
                        />
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={() => replaceImgRef.current?.click()}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-[#2B3449] bg-[#181E2D] px-3 py-1.5 text-xs font-medium text-[#E6EAF2] hover:border-[#5B9BD5] hover:text-white whitespace-nowrap"
                          >
                            <ImagePlus className="h-3.5 w-3.5" aria-hidden="true" />
                            <span>{selectedScene.imageId ? 'Ganti Gambar' : 'Pilih Gambar'}</span>
                          </button>
                          <button
                            type="button"
                            disabled={!selectedScene.imageId}
                            onClick={handleRemoveSelectedImage}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-[#3B2026] bg-[#221418] px-3 py-1.5 text-xs font-medium text-[#FCA5A5] hover:bg-[#331920] disabled:opacity-40 whitespace-nowrap"
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                            <span>Hapus</span>
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* Cut Point Nudge Buttons */}
                    <div className="space-y-1.5 border-t border-[#1D2230] pt-3">
                      <p className="text-xs font-medium text-[#D2D8E6]">
                        Geser Titik Potong Akhir Adegan Ini
                      </p>
                      <div className="grid grid-cols-4 gap-2">
                        {[-0.3, -0.1, 0.1, 0.3].map((delta) => (
                          <button
                            key={delta}
                            type="button"
                            disabled={selectedSceneIndex >= project.scenes.length - 1}
                            onClick={() => handleNudge(delta)}
                            className="rounded-lg border border-[#272E40] bg-[#161B27] py-1.5 font-mono text-xs font-medium text-[#E6EAF2] hover:border-[#5B9BD5] hover:text-white disabled:opacity-35 tabular-nums"
                          >
                            {delta > 0 ? `+${delta.toFixed(1).replace('.', ',')}` : delta.toFixed(1).replace('.', ',')} dtk
                          </button>
                        ))}
                      </div>
                      <p className="text-[11px] text-[#7C879E]">
                        Klip kiri memanjang/memendek secara seimbang dengan klip kanan (total durasi audio tetap).
                      </p>
                    </div>

                    {/* Narration Text */}
                    <div className="space-y-1.5 border-t border-[#1D2230] pt-3">
                      <label htmlFor="studio-scene-text" className="block text-xs font-medium text-[#D2D8E6]">
                        Teks Narasi Saat Foto Ini Tampil (juga dipakai untuk Subtitle)
                      </label>
                      <textarea
                        id="studio-scene-text"
                        rows={3}
                        value={selectedScene.text}
                        onChange={(e) => {
                          const updated = project.scenes.map((s) =>
                            s.id === selectedScene.id ? { ...s, text: e.target.value } : s
                          );
                          onUpdate({ scenes: updated });
                        }}
                        className="w-full rounded-lg border border-[#272E40] bg-[#0C0F16] p-2.5 text-xs leading-relaxed text-white focus:border-[#5B9BD5] focus:outline-none"
                      />
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-[#8F9BB3]">
                    Belum ada adegan terpilih. Buat timestamp di Kotak 3 terlebih dahulu.
                  </p>
                )}
              </>
            )}

            {/* TAB 2: Subtitle Settings */}
            {rightTab === 'subtitle' && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-white">Mode Subtitle</p>
                  <div className="grid grid-cols-1 gap-2">
                    {(
                      [
                        { id: 'off', label: 'Mati', desc: 'Tanpa teks subtitle di atas video' },
                        {
                          id: 'lines',
                          label: '3–6 Kata per Baris',
                          desc: 'Teks rapi berganti proporsional mengikuti durasi kata',
                        },
                        {
                          id: 'dynamic',
                          label: 'Dinamis dengan Highlight Kata',
                          desc: 'Kata yang sedang diucapkan tersorot warna aksen secara langsung',
                        },
                      ] as Array<{ id: SubtitleMode; label: string; desc: string }>
                    ).map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() =>
                          onUpdate({
                            subtitleSettings: { ...project.subtitleSettings, mode: opt.id },
                          })
                        }
                        className={`rounded-lg border p-3 text-left transition-colors ${
                          project.subtitleSettings.mode === opt.id
                            ? 'border-[#5B9BD5] bg-[#172233] text-white'
                            : 'border-[#232A3B] bg-[#0E1118] text-[#B6C0D4] hover:border-[#343E57]'
                        }`}
                      >
                        <span className="block text-xs font-semibold">{opt.label}</span>
                        <span className="mt-0.5 block text-[11px] text-[#8F9BB3]">{opt.desc}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Size */}
                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs">
                    <label htmlFor="sub-size" className="text-[#D2D8E6]">
                      Ukuran Teks
                    </label>
                    <span className="font-mono text-[#5B9BD5] tabular-nums">
                      {project.subtitleSettings.fontSize}px
                    </span>
                  </div>
                  <input
                    id="sub-size"
                    type="range"
                    min={22}
                    max={54}
                    value={project.subtitleSettings.fontSize}
                    onChange={(e) =>
                      onUpdate({
                        subtitleSettings: {
                          ...project.subtitleSettings,
                          fontSize: Number(e.target.value),
                        },
                      })
                    }
                    className="w-full accent-[#5B9BD5]"
                  />
                </div>

                {/* Position */}
                <div className="space-y-1.5">
                  <span className="block text-xs text-[#D2D8E6]">Posisi Subtitle</span>
                  <div className="grid grid-cols-3 gap-2">
                    {(
                      [
                        { id: 'bottom', label: 'Bawah' },
                        { id: 'middle', label: 'Tengah' },
                        { id: 'top', label: 'Atas' },
                      ] as Array<{ id: SubtitlePosition; label: string }>
                    ).map((pos) => (
                      <button
                        key={pos.id}
                        type="button"
                        onClick={() =>
                          onUpdate({
                            subtitleSettings: { ...project.subtitleSettings, position: pos.id },
                          })
                        }
                        className={`rounded-lg border py-1.5 text-xs font-medium ${
                          project.subtitleSettings.position === pos.id
                            ? 'border-[#5B9BD5] bg-[#172233] text-white'
                            : 'border-[#232A3B] bg-[#0E1118] text-[#9AA5BC] hover:text-white'
                        }`}
                      >
                        {pos.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Colors */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="sub-color" className="block text-xs text-[#D2D8E6]">
                      Warna Teks
                    </label>
                    <div className="mt-1.5 flex items-center gap-2 rounded-lg border border-[#272E40] bg-[#0C0F16] px-2.5 py-1.5">
                      <input
                        id="sub-color"
                        type="color"
                        value={project.subtitleSettings.textColor}
                        onChange={(e) =>
                          onUpdate({
                            subtitleSettings: {
                              ...project.subtitleSettings,
                              textColor: e.target.value,
                            },
                          })
                        }
                        className="h-5 w-7 cursor-pointer bg-transparent"
                      />
                      <span className="font-mono text-xs text-[#9AA5BC]">
                        {project.subtitleSettings.textColor}
                      </span>
                    </div>
                  </div>

                  <div>
                    <label htmlFor="sub-highlight" className="block text-xs text-[#D2D8E6]">
                      Warna Highlight
                    </label>
                    <div className="mt-1.5 flex items-center gap-2 rounded-lg border border-[#272E40] bg-[#0C0F16] px-2.5 py-1.5">
                      <input
                        id="sub-highlight"
                        type="color"
                        value={project.subtitleSettings.highlightColor}
                        onChange={(e) =>
                          onUpdate({
                            subtitleSettings: {
                              ...project.subtitleSettings,
                              highlightColor: e.target.value,
                            },
                          })
                        }
                        className="h-5 w-7 cursor-pointer bg-transparent"
                      />
                      <span className="font-mono text-xs text-[#9AA5BC]">
                        {project.subtitleSettings.highlightColor}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* TAB 3: Video Options & MP4/WebM Export */}
            {rightTab === 'export' && (
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <span className="block text-xs font-semibold text-white">Resolusi &amp; Frame Rate</span>
                  <div className="grid grid-cols-2 gap-2">
                    {(['720p', '1080p'] as const).map((res) => (
                      <button
                        key={res}
                        type="button"
                        onClick={() =>
                          onUpdate({
                            videoSettings: { ...project.videoSettings, resolution: res },
                          })
                        }
                        className={`rounded-lg border py-2 text-xs font-semibold tabular-nums ${
                          project.videoSettings.resolution === res
                            ? 'border-[#5B9BD5] bg-[#172233] text-white'
                            : 'border-[#232A3B] bg-[#0E1118] text-[#9AA5BC] hover:text-white'
                        }`}
                      >
                        {res === '720p' ? '720p HD (Default) · 30 fps' : '1080p Full HD · 30 fps'}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Effects Toggles */}
                <div className="space-y-2">
                  <label className="flex items-center justify-between rounded-lg border border-[#232A3B] bg-[#0E1118] px-3.5 py-2.5 text-xs text-[#E6EAF2]">
                    <span>Efek Zoom Pelan (Ken Burns)</span>
                    <input
                      type="checkbox"
                      checked={project.videoSettings.kenBurns}
                      onChange={(e) =>
                        onUpdate({
                          videoSettings: {
                            ...project.videoSettings,
                            kenBurns: e.target.checked,
                          },
                        })
                      }
                      className="h-4 w-4 accent-[#5B9BD5]"
                    />
                  </label>

                  <label className="flex items-center justify-between rounded-lg border border-[#232A3B] bg-[#0E1118] px-3.5 py-2.5 text-xs text-[#E6EAF2]">
                    <span>Transisi Crossfade 0,3 detik</span>
                    <input
                      type="checkbox"
                      checked={project.videoSettings.crossfade}
                      onChange={(e) =>
                        onUpdate({
                          videoSettings: {
                            ...project.videoSettings,
                            crossfade: e.target.checked,
                          },
                        })
                      }
                      className="h-4 w-4 accent-[#5B9BD5]"
                    />
                  </label>
                </div>

                {/* Render Action */}
                <div className="space-y-3 border-t border-[#1D2230] pt-3">
                  <p className="text-[11px] leading-relaxed text-[#8F9BB3]">
                    Menggunakan WebCodecs + mp4-muxer (H.264 + AAC) untuk render lebih cepat dari real-time, dengan fallback otomatis ke WebM jika browser tidak mendukung.
                  </p>

                  {!exporting ? (
                    <button
                      type="button"
                      disabled={!audioBlob || project.scenes.length === 0}
                      onClick={handleStartVideoExport}
                      className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[#5B9BD5] px-4 py-2.5 text-xs font-semibold text-[#0B0D12] hover:bg-[#73ACE0] disabled:opacity-40"
                    >
                      <Film className="h-4 w-4" aria-hidden="true" />
                      <span>Render &amp; Export Video (MP4)</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => exportAbortRef.current?.abort()}
                      className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-[#7F1D1D] bg-[#2D1418] px-4 py-2.5 text-xs font-semibold text-[#FCA5A5] hover:bg-[#3F1A20]"
                    >
                      <X className="h-4 w-4" aria-hidden="true" />
                      <span>Batalkan Render</span>
                    </button>
                  )}

                  {exportProgress && (
                    <div className="space-y-1.5">
                      <div className="flex justify-between text-xs text-[#9AA5BC] tabular-nums">
                        <span className="truncate">{exportProgress.message}</span>
                        <span>{exportProgress.percent}%</span>
                      </div>
                      <div className="h-2 w-full overflow-hidden rounded-full bg-[#1C2233]">
                        <div
                          className="h-full rounded-full bg-[#5B9BD5] transition-all"
                          style={{ width: `${exportProgress.percent}%` }}
                        />
                      </div>
                    </div>
                  )}

                  {exportResult && (
                    <button
                      type="button"
                      onClick={handleDownloadVideo}
                      className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[#16A34A] px-4 py-2.5 text-xs font-semibold text-white hover:bg-[#15803D]"
                    >
                      <Download className="h-4 w-4" aria-hidden="true" />
                      <span>
                        Download Video (.{exportResult.extension.toUpperCase()})
                      </span>
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Bottom Interactive Timeline */}
      <TimelineTrack
        scenes={project.scenes}
        totalDuration={totalDuration}
        currentTime={currentTime}
        selectedSceneId={selectedScene?.id ?? null}
        thumbUrls={thumbUrls}
        waveformPeaks={waveformPeaks}
        onSeek={handleSeek}
        onSelectScene={setSelectedSceneId}
        onScenesChange={(nextScenes) => onUpdate({ scenes: nextScenes })}
        onSnapCutsToVoicePauses={() => handleSyncPhotosAndAudioVoice(false)}
        syncingVoicePauses={syncingVoice}
      />
    </section>
  );
};
