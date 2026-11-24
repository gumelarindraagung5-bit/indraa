import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import type { SceneItem, SubtitleSettings, VideoExportSettings } from '../types/project';
import { renderStudioFrame } from './canvasRenderer';
import { getAllImageRecords } from './mediaDb';

export interface ExportProgress {
  phase: 'preparing' | 'encoding-audio' | 'encoding-video' | 'finalizing';
  percent: number;
  message: string;
}

export interface ExportResult {
  blob: Blob;
  extension: 'mp4' | 'webm';
  engine: 'webcodecs-mp4' | 'mediarecorder-webm';
}

async function loadAllSceneBitmaps(
  scenes: SceneItem[]
): Promise<Map<string, HTMLImageElement | ImageBitmap>> {
  const neededIds = new Set(scenes.map((s) => s.imageId).filter((id): id is string => Boolean(id)));
  const allRecords = await getAllImageRecords();
  const map = new Map<string, HTMLImageElement | ImageBitmap>();

  for (const rec of allRecords) {
    if (!neededIds.has(rec.id)) continue;
    try {
      const bitmap = await createImageBitmap(rec.originalBlob);
      map.set(rec.id, bitmap);
    } catch {
      // Fallback to HTMLImageElement
      const url = URL.createObjectURL(rec.originalBlob);
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = reject;
        el.src = url;
      });
      map.set(rec.id, img);
      URL.revokeObjectURL(url);
    }
  }
  return map;
}

function disposeBitmaps(map: Map<string, HTMLImageElement | ImageBitmap>) {
  for (const val of map.values()) {
    if ('close' in val && typeof val.close === 'function') {
      val.close();
    }
  }
}

async function canUseWebCodecsMp4(width: number, height: number, fps: number): Promise<boolean> {
  if (
    typeof window === 'undefined' ||
    typeof VideoEncoder === 'undefined' ||
    typeof AudioEncoder === 'undefined' ||
    typeof VideoFrame === 'undefined' ||
    typeof AudioData === 'undefined'
  ) {
    return false;
  }

  try {
    const videoSupport = await VideoEncoder.isConfigSupported({
      codec: 'avc1.420028',
      width,
      height,
      bitrate: width >= 1920 ? 6_000_000 : 3_500_000,
      framerate: fps,
    });
    const audioSupport = await AudioEncoder.isConfigSupported({
      codec: 'mp4a.40.2',
      numberOfChannels: 2,
      sampleRate: 48000,
      bitrate: 128_000,
    });
    return Boolean(videoSupport.supported && audioSupport.supported);
  } catch {
    return false;
  }
}

async function exportWithWebCodecsMp4(params: {
  audioBlob: Blob;
  duration: number;
  scenes: SceneItem[];
  subtitleSettings: SubtitleSettings;
  videoSettings: VideoExportSettings;
  width: number;
  height: number;
  signal: AbortSignal;
  onProgress: (p: ExportProgress) => void;
}): Promise<ExportResult> {
  const { audioBlob, duration, scenes, subtitleSettings, videoSettings, width, height, signal, onProgress } =
    params;

  onProgress({ phase: 'preparing', percent: 3, message: 'Memuat gambar resolusi penuh dan mendekode audio...' });

  const bitmaps = await loadAllSceneBitmaps(scenes);

  try {
    if (signal.aborted) throw new Error('Ekspor dibatalkan oleh pengguna.');

    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const decodeCtx = new AudioCtx({ sampleRate: 48000 });
    const rawBuffer = await audioBlob.arrayBuffer();
    const audioBuffer = await decodeCtx.decodeAudioData(rawBuffer.slice(0));
    await decodeCtx.close().catch(() => {});

    const sampleRate = audioBuffer.sampleRate;
    const numberOfChannels = Math.min(2, audioBuffer.numberOfChannels);

    const target = new ArrayBufferTarget();
    const muxer = new Muxer({
      target,
      video: {
        codec: 'avc',
        width,
        height,
      },
      audio: {
        codec: 'aac',
        numberOfChannels,
        sampleRate,
      },
      fastStart: 'in-memory',
    });

    const videoEncoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (err) => {
        throw err;
      },
    });

    videoEncoder.configure({
      codec: 'avc1.420028',
      width,
      height,
      bitrate: width >= 1920 ? 6_000_000 : 3_500_000,
      framerate: videoSettings.fps,
    });

    const audioEncoder = new AudioEncoder({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
      error: (err) => {
        throw err;
      },
    });

    audioEncoder.configure({
      codec: 'mp4a.40.2',
      numberOfChannels,
      sampleRate,
      bitrate: 128_000,
    });

    // Encode Audio PCM -> AAC (planar f32)
    onProgress({ phase: 'encoding-audio', percent: 10, message: 'Mengenkode trek audio AAC...' });
    const chunkFrames = 4096;
    const totalAudioFrames = audioBuffer.length;
    const channelArrays: Float32Array[] = [];
    for (let ch = 0; ch < numberOfChannels; ch++) {
      channelArrays.push(audioBuffer.getChannelData(ch));
    }

    for (let offset = 0; offset < totalAudioFrames; offset += chunkFrames) {
      if (signal.aborted) throw new Error('Ekspor dibatalkan oleh pengguna.');
      const framesCount = Math.min(chunkFrames, totalAudioFrames - offset);
      const planar = new Float32Array(framesCount * numberOfChannels);
      for (let ch = 0; ch < numberOfChannels; ch++) {
        planar.set(channelArrays[ch].subarray(offset, offset + framesCount), ch * framesCount);
      }

      const audioData = new AudioData({
        format: 'f32-planar',
        sampleRate,
        numberOfFrames: framesCount,
        numberOfChannels,
        timestamp: Math.round((offset / sampleRate) * 1_000_000),
        data: planar,
      });

      audioEncoder.encode(audioData);
      audioData.close();

      if (audioEncoder.encodeQueueSize > 20) {
        await new Promise((r) => setTimeout(r, 4));
      }
    }

    await audioEncoder.flush();

    // Encode Video Frames -> H.264 faster-than-real-time
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;

    const fps = videoSettings.fps;
    const totalFrames = Math.max(1, Math.ceil(duration * fps));
    const frameDurationUs = Math.round(1_000_000 / fps);

    for (let f = 0; f < totalFrames; f++) {
      if (signal.aborted) throw new Error('Ekspor dibatalkan oleh pengguna.');

      const currentTime = Math.min(duration, f / fps);
      renderStudioFrame({
        ctx,
        width,
        height,
        currentTime,
        scenes,
        imageElements: bitmaps,
        subtitleSettings,
        videoSettings,
      });

      const frame = new VideoFrame(canvas, {
        timestamp: f * frameDurationUs,
        duration: frameDurationUs,
      });

      const keyFrame = f % (fps * 2) === 0;
      videoEncoder.encode(frame, { keyFrame });
      frame.close();

      // Backpressure guard so memory stays flat
      if (videoEncoder.encodeQueueSize > 12) {
        await new Promise((r) => setTimeout(r, 8));
      }

      if (f % 15 === 0 || f === totalFrames - 1) {
        const pct = 15 + Math.round(((f + 1) / totalFrames) * 80);
        onProgress({
          phase: 'encoding-video',
          percent: pct,
          message: `Merender MP4 (WebCodecs): frame ${f + 1} / ${totalFrames}`,
        });
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    onProgress({ phase: 'finalizing', percent: 97, message: 'Menyelesaikan file MP4...' });
    await videoEncoder.flush();
    videoEncoder.close();
    audioEncoder.close();
    muxer.finalize();

    const blob = new Blob([target.buffer], { type: 'video/mp4' });
    onProgress({ phase: 'finalizing', percent: 100, message: 'Video MP4 siap diunduh!' });
    return {
      blob,
      extension: 'mp4',
      engine: 'webcodecs-mp4',
    };
  } finally {
    disposeBitmaps(bitmaps);
  }
}

async function exportWithMediaRecorderWebM(params: {
  audioBlob: Blob;
  duration: number;
  scenes: SceneItem[];
  subtitleSettings: SubtitleSettings;
  videoSettings: VideoExportSettings;
  width: number;
  height: number;
  signal: AbortSignal;
  onProgress: (p: ExportProgress) => void;
}): Promise<ExportResult> {
  const { audioBlob, duration, scenes, subtitleSettings, videoSettings, width, height, signal, onProgress } =
    params;

  onProgress({
    phase: 'preparing',
    percent: 5,
    message: 'Browser tidak mendukung WebCodecs MP4, beralih ke mode kompatibel WebM...',
  });

  const bitmaps = await loadAllSceneBitmaps(scenes);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  const audioUrl = URL.createObjectURL(audioBlob);
  const audioEl = new Audio(audioUrl);
  audioEl.crossOrigin = 'anonymous';

  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const audioCtx = new AudioCtx();
  const sourceNode = audioCtx.createMediaElementSource(audioEl);
  const destNode = audioCtx.createMediaStreamDestination();
  sourceNode.connect(destNode);

  const videoStream = canvas.captureStream(videoSettings.fps);
  const combinedStream = new MediaStream([
    ...videoStream.getVideoTracks(),
    ...destNode.stream.getAudioTracks(),
  ]);

  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
    ? 'video/webm;codecs=vp9,opus'
    : 'video/webm';

  const recorder = new MediaRecorder(combinedStream, {
    mimeType,
    videoBitsPerSecond: width >= 1920 ? 5_000_000 : 3_000_000,
  });

  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  try {
    const resultBlob = await new Promise<Blob>((resolve, reject) => {
      let rafId = 0;

      const cleanup = () => {
        cancelAnimationFrame(rafId);
        audioEl.pause();
        URL.revokeObjectURL(audioUrl);
        audioCtx.close().catch(() => {});
      };

      signal.addEventListener('abort', () => {
        if (recorder.state !== 'inactive') recorder.stop();
        cleanup();
        reject(new Error('Ekspor dibatalkan oleh pengguna.'));
      });

      recorder.onstop = () => {
        cleanup();
        resolve(new Blob(chunks, { type: 'video/webm' }));
      };

      recorder.onerror = () => {
        cleanup();
        reject(new Error('Gagal merekam video WebM.'));
      };

      const renderLoop = () => {
        if (signal.aborted) return;
        const t = audioEl.currentTime;
        renderStudioFrame({
          ctx,
          width,
          height,
          currentTime: t,
          scenes,
          imageElements: bitmaps,
          subtitleSettings,
          videoSettings,
        });

        const pct = Math.min(98, Math.round((t / Math.max(0.1, duration)) * 95) + 3);
        onProgress({
          phase: 'encoding-video',
          percent: pct,
          message: `Merekam WebM: ${t.toFixed(1)}s / ${duration.toFixed(1)}s`,
        });

        if (!audioEl.ended && t < duration) {
          rafId = requestAnimationFrame(renderLoop);
        } else if (recorder.state !== 'inactive') {
          recorder.stop();
        }
      };

      audioEl.onended = () => {
        if (recorder.state !== 'inactive') recorder.stop();
      };

      recorder.start(250);
      audioEl
        .play()
        .then(() => {
          rafId = requestAnimationFrame(renderLoop);
        })
        .catch((err) => {
          cleanup();
          reject(err);
        });
    });

    onProgress({ phase: 'finalizing', percent: 100, message: 'Video WebM siap diunduh!' });
    return {
      blob: resultBlob,
      extension: 'webm',
      engine: 'mediarecorder-webm',
    };
  } finally {
    disposeBitmaps(bitmaps);
  }
}

export async function exportStudioVideo(params: {
  audioBlob: Blob;
  duration: number;
  scenes: SceneItem[];
  subtitleSettings: SubtitleSettings;
  videoSettings: VideoExportSettings;
  signal: AbortSignal;
  onProgress: (p: ExportProgress) => void;
}): Promise<ExportResult> {
  const width = params.videoSettings.resolution === '1080p' ? 1920 : 1280;
  const height = params.videoSettings.resolution === '1080p' ? 1080 : 720;

  const useWebCodecs = await canUseWebCodecsMp4(width, height, params.videoSettings.fps);
  if (useWebCodecs) {
    try {
      return await exportWithWebCodecsMp4({ ...params, width, height });
    } catch (err) {
      if (params.signal.aborted) throw err;
      // Graceful fallback if hardware/software H.264 encoder throws mid-flight
      return exportWithMediaRecorderWebM({ ...params, width, height });
    }
  }
  return exportWithMediaRecorderWebM({ ...params, width, height });
}
