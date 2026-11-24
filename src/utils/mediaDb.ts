import type { ImageRecordMeta } from '../types/project';

const DB_NAME = 'StickmanVideoStudioDB';
const DB_VERSION = 1;
const STORE_AUDIO = 'audio';
const STORE_IMAGES = 'images';

export interface StoredImageRecord extends ImageRecordMeta {
  originalBlob: Blob;
  thumbBlob: Blob;
}

export interface StoredAudioRecord {
  id: string;
  blob: Blob;
  fileName: string;
  fileSize: number;
  mimeType: string;
  duration: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error || new Error('Gagal membuka IndexedDB'));
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_AUDIO)) {
        db.createObjectStore(STORE_AUDIO, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_IMAGES)) {
        db.createObjectStore(STORE_IMAGES, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

export async function saveAudioBlob(record: StoredAudioRecord): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_AUDIO, 'readwrite');
    tx.objectStore(STORE_AUDIO).put(record);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error || new Error('Gagal menyimpan audio ke IndexedDB'));
    };
  });
}

export async function getAudioBlob(): Promise<StoredAudioRecord | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_AUDIO, 'readonly');
    const req = tx.objectStore(STORE_AUDIO).get('primary');
    req.onsuccess = () => {
      db.close();
      resolve((req.result as StoredAudioRecord) || null);
    };
    req.onerror = () => {
      db.close();
      reject(req.error || new Error('Gagal membaca audio dari IndexedDB'));
    };
  });
}

export async function deleteAudioBlob(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_AUDIO, 'readwrite');
    tx.objectStore(STORE_AUDIO).delete('primary');
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function saveImageRecord(record: StoredImageRecord): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_IMAGES, 'readwrite');
    tx.objectStore(STORE_IMAGES).put(record);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error || new Error('Gagal menyimpan gambar ke IndexedDB'));
    };
  });
}

export async function saveManyImageRecords(records: StoredImageRecord[]): Promise<void> {
  if (records.length === 0) return;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_IMAGES, 'readwrite');
    const store = tx.objectStore(STORE_IMAGES);
    for (const rec of records) {
      store.put(rec);
    }
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error || new Error('Gagal menyimpan kumpulan gambar'));
    };
  });
}

export async function getImageRecord(id: string): Promise<StoredImageRecord | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_IMAGES, 'readonly');
    const req = tx.objectStore(STORE_IMAGES).get(id);
    req.onsuccess = () => {
      db.close();
      resolve((req.result as StoredImageRecord) || null);
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}

export async function getAllImageRecords(): Promise<StoredImageRecord[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_IMAGES, 'readonly');
    const req = tx.objectStore(STORE_IMAGES).getAll();
    req.onsuccess = () => {
      db.close();
      resolve((req.result as StoredImageRecord[]) || []);
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}

export async function deleteImageRecord(id: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_IMAGES, 'readwrite');
    tx.objectStore(STORE_IMAGES).delete(id);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function clearAllMediaDb(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_AUDIO, STORE_IMAGES], 'readwrite');
    tx.objectStore(STORE_AUDIO).clear();
    tx.objectStore(STORE_IMAGES).clear();
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

/**
 * Generates a lightweight 320px-wide JPEG thumbnail Blob via Canvas from any image Blob/File.
 * Never returns base64 strings into React state.
 */
export async function createThumbnailFromBlob(
  blob: Blob,
  maxWidth = 320
): Promise<{ thumbBlob: Blob; width: number; height: number }> {
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Gagal memuat gambar untuk thumbnail'));
      el.src = url;
    });

    const origW = img.naturalWidth || 1280;
    const origH = img.naturalHeight || 720;
    const scale = Math.min(1, maxWidth / origW);
    const targetW = Math.max(1, Math.round(origW * scale));
    const targetH = Math.max(1, Math.round(origH * scale));

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return { thumbBlob: blob, width: origW, height: origH };
    }
    ctx.drawImage(img, 0, 0, targetW, targetH);

    const thumbBlob = await new Promise<Blob>((resolve) => {
      canvas.toBlob(
        (b) => resolve(b || blob),
        'image/jpeg',
        0.78
      );
    });

    return { thumbBlob, width: origW, height: origH };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Fast direct WAV PCM parser for 16-bit/8-bit uncompressed WAV files (runs in <2ms without AudioContext).
 */
function tryParseWavPcm(arrayBuffer: ArrayBuffer): { duration: number; samples: Float32Array; sampleRate: number } | null {
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

    // Locate 'data' chunk
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
            const sampleOffset = dataStart + i * bytesPerFrame;
            mono[i] = view.getInt16(sampleOffset, true) / 32768;
          }
        } else {
          for (let i = 0; i < totalFrames; i++) {
            const sampleOffset = dataStart + i * bytesPerFrame;
            mono[i] = (view.getUint8(sampleOffset) - 128) / 128;
          }
        }
        return {
          duration: Math.round((totalFrames / sampleRate) * 100) / 100,
          samples: mono,
          sampleRate,
        };
      }
      offset += 8 + size;
    }
    return null;
  } catch {
    return null;
  }
}

function extractPeakBuckets(channel: Float32Array, peakBuckets: number): number[] {
  const samplesPerBucket = Math.max(1, Math.floor(channel.length / peakBuckets));
  const peaks: number[] = [];

  for (let b = 0; b < peakBuckets; b++) {
    const start = b * samplesPerBucket;
    const end = Math.min(channel.length, start + samplesPerBucket);
    let max = 0;
    const step = Math.max(1, Math.floor((end - start) / 64));
    for (let i = start; i < end; i += step) {
      const v = Math.abs(channel[i]);
      if (v > max) max = v;
    }
    peaks.push(Math.min(1, max));
  }
  return peaks;
}

/**
 * Decodes exact audio duration & high-resolution peak waveform using fast WAV PCM parsing or OfflineAudioContext.
 */
export async function decodeAudioInfo(
  blob: Blob,
  peakBuckets = 320
): Promise<{ duration: number; peaks: number[] }> {
  try {
    const arrayBuffer = await blob.arrayBuffer();

    // 1. Instant path for PCM WAV files (<2ms, never blocks on AudioContext)
    const wavPcm = tryParseWavPcm(arrayBuffer);
    if (wavPcm && wavPcm.duration > 0) {
      return {
        duration: wavPcm.duration,
        peaks: extractPeakBuckets(wavPcm.samples, peakBuckets),
      };
    }

    // 2. OfflineAudioContext path (does not require hardware audio output sink)
    const OfflineCtx =
      window.OfflineAudioContext ||
      (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext })
        .webkitOfflineAudioContext;
    const offlineCtx = new OfflineCtx(1, 1, 44100);
    const decoded = await Promise.race([
      offlineCtx.decodeAudioData(arrayBuffer.slice(0)),
      new Promise<AudioBuffer>((_, reject) =>
        setTimeout(() => reject(new Error('Audio decode timeout')), 3500)
      ),
    ]);

    const duration = Math.round(decoded.duration * 100) / 100;
    const channel = decoded.getChannelData(0);
    return {
      duration,
      peaks: extractPeakBuckets(channel, peakBuckets),
    };
  } catch {
    // Fallback to HTMLAudioElement metadata if AudioContext cannot decode format
    const url = URL.createObjectURL(blob);
    try {
      const duration = await new Promise<number>((resolve, reject) => {
        const audio = new Audio();
        audio.preload = 'metadata';
        audio.onloadedmetadata = () => resolve(Math.round(audio.duration * 100) / 100);
        audio.onerror = () => reject(new Error('Format audio tidak dapat dibaca oleh browser.'));
        audio.src = url;
      });
      const flatPeaks = Array.from(
        { length: peakBuckets },
        (_, i) => 0.25 + 0.2 * Math.abs(Math.sin(i * 0.35))
      );
      return { duration, peaks: flatPeaks };
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
