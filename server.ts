import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import multer from 'multer';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import { parseAndNormalizePromptItems } from './src/utils/promptUtils';

const PORT = Number(process.env.PORT) || 3000;
const MODEL_FLASH = 'gemini-4-hydrogen';
const MODEL_FAST_LITE = 'gemini-3.1-flash-lite';
const MODEL_TRANSCRIBE = 'gemini-3.5-transcribe';
const TWENTY_MB = 20 * 1024 * 1024;

const uploadDir = path.join(os.tmpdir(), 'stickman-video-studio-uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: {
    fileSize: 250 * 1024 * 1024, // 250 MB ceiling for long narration WAV files
  },
});

function getAiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    const err = new Error(
      'GEMINI_API_KEY belum dikonfigurasi. Pastikan API key tersedia di panel Settings > Secrets.'
    ) as Error & { statusCode?: number };
    err.statusCode = 500;
    throw err;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function isTransientAvailabilityError(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err);
  const status = (err as { statusCode?: number; status?: number })?.statusCode ||
    (err as { status?: number })?.status;
  return (
    status === 503 ||
    status === 502 ||
    status === 429 ||
    status === 500 ||
    status === 504 ||
    /\b(502|503|429|504)\b/.test(raw) ||
    raw.includes('UNAVAILABLE') ||
    raw.includes('OVERLOADED') ||
    raw.includes('high demand') ||
    raw.includes('RESOURCE_EXHAUSTED') ||
    raw.includes('DEADLINE_EXCEEDED') ||
    raw.includes('TIMEOUT') ||
    raw.includes('fetch failed') ||
    raw.includes('ECONNRESET') ||
    raw.includes('ETIMEDOUT')
  );
}

// Track temporary 503/timeout congestion on MODEL_FLASH so subsequent calls don't stall waiting for another 503
let flashCongestedUntil = 0;
const CONGESTION_COOLDOWN_MS = 300_000;

async function generateWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const err = new Error('Permintaan ke model Gemini melebihi batas waktu (TIMEOUT).') as Error & {
            statusCode?: number;
          };
          err.statusCode = 504;
          reject(err);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function generateTextWithFallback(
  ai: GoogleGenAI,
  params: {
    contents: Parameters<GoogleGenAI['models']['generateContent']>[0]['contents'];
    config?: Record<string, unknown>;
    timeoutMs?: number;
    flashTimeoutMs?: number;
    liteTimeoutMs?: number;
    preferLite?: boolean;
  }
) {
  const now = Date.now();
  const flashFirst = !params.preferLite && now >= flashCongestedUntil;
  const flashTimeout = params.flashTimeoutMs ?? params.timeoutMs ?? 16_000;
  const liteTimeout = params.liteTimeoutMs ?? Math.max(params.timeoutMs ?? 25_000, 30_000);
  const candidates = flashFirst
    ? [
        { model: MODEL_FLASH, thinkingLevel: ThinkingLevel.LOW, timeout: flashTimeout },
        { model: MODEL_FAST_LITE, thinkingLevel: ThinkingLevel.MINIMAL, timeout: liteTimeout },
      ]
    : [
        { model: MODEL_FAST_LITE, thinkingLevel: ThinkingLevel.MINIMAL, timeout: liteTimeout },
        { model: MODEL_FLASH, thinkingLevel: ThinkingLevel.LOW, timeout: flashTimeout },
      ];

  let lastErr: unknown = null;

  for (const candidate of candidates) {
    try {
      const response = await generateWithTimeout(
        ai.models.generateContent({
          model: candidate.model,
          contents: params.contents,
          config: {
            ...(params.config || {}),
            thinkingConfig: {
              thinkingLevel: candidate.thinkingLevel,
            },
          },
        }),
        candidate.timeout
      );

      if (response.text && response.text.trim().length > 0) {
        return { response, model: candidate.model };
      }
      lastErr = new Error('Model AI mengembalikan respons kosong.');
    } catch (err) {
      lastErr = err;
      if (candidate.model === MODEL_FLASH && isTransientAvailabilityError(err)) {
        flashCongestedUntil = Date.now() + CONGESTION_COOLDOWN_MS;
      }
      if (!isTransientAvailabilityError(err)) {
        throw err;
      }
    }
  }

  throw lastErr ?? new Error('Gagal menghasilkan konten dari Gemini AI.');
}

function formatGeminiError(err: unknown): { status: number; message: string } {
  const raw = err instanceof Error ? err.message : String(err);
  const statusMatch = raw.match(/\b(400|401|403|404|429|500|503|504)\b/);
  const status =
    (err as { statusCode?: number; status?: number })?.statusCode ||
    (err as { status?: number })?.status ||
    (statusMatch ? Number(statusMatch[1]) : 500);

  if (status === 403 || raw.includes('PERMISSION_DENIED') || raw.includes('API_KEY_INVALID')) {
    return {
      status: 403,
      message: 'Akses Gemini API ditolak atau API key tidak valid. Periksa kunci Anda di Settings > Secrets.',
    };
  }
  if (status === 503 || status === 504 || raw.includes('UNAVAILABLE') || raw.includes('high demand') || raw.includes('TIMEOUT')) {
    return {
      status: status === 504 ? 504 : 503,
      message: 'Server Gemini AI sedang padat sementara. Tunggu beberapa detik lalu klik "Coba lagi".',
    };
  }
  if (status === 429 || raw.includes('RESOURCE_EXHAUSTED')) {
    return {
      status: 429,
      message: 'Kuota Gemini API sementara terlampaui. Tunggu beberapa detik lalu coba lagi.',
    };
  }
  if (status === 404 || raw.includes('NOT_FOUND')) {
    return {
      status: 404,
      message: 'Model AI tidak ditemukan atau belum tersedia. Silakan coba lagi.',
    };
  }

  // Extract readable inner message if SDK threw nested JSON string
  let cleanMsg = raw;
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } };
    if (parsed?.error?.message) {
      cleanMsg = parsed.error.message;
    }
  } catch {
    // keep raw
  }

  return {
    status: status >= 400 && status < 600 ? status : 500,
    message: cleanMsg || 'Terjadi kesalahan saat memproses permintaan AI.',
  };
}

function parseJsonSafe<T>(text: string | undefined, fallback: T): T {
  if (!text) return fallback;
  const cleaned = text
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  return JSON.parse(cleaned) as T;
}

function safeUnlink(filePath?: string) {
  if (!filePath) return;
  fs.promises.unlink(filePath).catch(() => {});
}

async function createApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // Health check
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  // KOTAK 1: Buat 10 Ide Video Viral yang Fresh & Tidak Pasaran
  app.post('/api/ai/ideas', async (req, res) => {
    try {
      const { category, seedHint, excludeIdeas } = (req.body || {}) as {
        category?: string;
        seedHint?: string;
        excludeIdeas?: string[];
      };

      const categoryLabel =
        category && category !== 'semua'
          ? `Fokus utama kategori: "${category}", namun tetap variasikan sudut pandangnya agar 10 ide terasa benar-benar berbeda satu sama lain.`
          : 'Campurkan berbagai sudut pandang menarik secara merata: Fakta Unik Jarang Diketahui, Skenario "Bagaimana Jika" (What-If) yang liar tapi ilmiah, Psikologi & Motivasi Anti-Klise, Paradoks Sains Sehari-hari, dan Sejarah/Ekonomi Aneh yang bikin melongo.';

      const seedPart = seedHint?.trim()
        ? `\nKata kunci / minat tambahan dari kreator (jadikan inspirasi opsional): "${seedHint.trim()}"`
        : '';

      const excludeList = Array.isArray(excludeIdeas)
        ? excludeIdeas.filter((x) => typeof x === 'string' && x.trim().length > 0).slice(-20)
        : [];
      const excludePart =
        excludeList.length > 0
          ? `\nDILARANG mengulang atau memparafrase ide-ide yang sudah pernah dibuat berikut:\n${excludeList.map((t) => `- ${t}`).join('\n')}`
          : '';

      const ai = getAiClient();
      const promptContents = `Buatkan tepat 10 ide konten video YouTube edukasi bergaya animasi stickman (seperti Kok Bisa / Satu Persen / Kurzgesagt / Ricks Clips) dalam Bahasa Indonesia yang SANGAT FRESH, TIDAK PASARAN, belum sering dibahas channel lain, dan punya potensi VIRAL tinggi.

${categoryLabel}${seedPart}${excludePart}

ATURAN KUALITAS KETAT:
1. HINDARI topik klise/pasaran seperti "cara sukses bangun jam 5 pagi", "kenapa langit biru", "bahaya main HP sebelum tidur", atau "cara jadi kaya cepat".
2. Cari sudut pandang kontradiktif, paradoks psikologis, efek ilmiah tersembunyi, eksperimen pikiran "Bagaimana Jika" yang konkret, atau fenomena manusia sehari-hari yang belum banyak orang sadari namanya.
3. Setiap ide harus langsung memicu rasa penasaran dan cocok divisualisasikan dengan karakter stickman.
4. Untuk setiap ide sertakan:
   - "idea": Rumusan topik/ide video yang tajam dan siap langsung dipakai buat judul & naskah (1 kalimat padat).
   - "category": Label kategori singkat (misal: "Fakta Unik", "Bagaimana Jika", "Motivasi & Psikologi", "Paradoks Sains", "Sejarah Aneh").
   - "hook": Alasan singkat kenapa ide ini fresh/tidak pasaran dan kalimat pancingan 5 detik pertamanya agar penonton tahan nonton.
   - "viralScore": Skor potensi viral 7 sampai 10 (angka bulat jujur).`;

      const ideaSchema = {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            idea: {
              type: Type.STRING,
              description: 'Ide topik video YouTube yang segar, spesifik, dan memancing penasaran',
            },
            category: {
              type: Type.STRING,
              description: 'Kategori singkat seperti Fakta Unik, Bagaimana Jika, Motivasi & Psikologi, Sains Populer, atau Sejarah Unik',
            },
            hook: {
              type: Type.STRING,
              description: 'Penjelasan singkat kenapa ide ini unik/viral beserta pancingan pembukaannya',
            },
            viralScore: {
              type: Type.INTEGER,
              description: 'Skor potensi viral 1 sampai 10',
            },
          },
          required: ['idea', 'category', 'hook', 'viralScore'],
        },
      };

      const systemInst =
        'Kamu adalah creative director & riset konten viral untuk channel YouTube edukasi stickman Indonesia. Kamu ahli menemukan topik yang segar, anti-mainstream, memicu rasa ingin tahu mendalam, dan memiliki retensi penonton tinggi.';

      const { response } = await generateTextWithFallback(ai, {
        contents: promptContents,
        config: {
          systemInstruction: systemInst,
          responseMimeType: 'application/json',
          responseSchema: ideaSchema,
        },
        timeoutMs: 20_000,
      });

      const ideas = parseJsonSafe<
        Array<{ idea: string; category: string; hook: string; viralScore: number }>
      >(response.text, []).slice(0, 10);

      if (ideas.length === 0) {
        throw new Error('AI belum mengembalikan daftar ide. Silakan coba lagi.');
      }

      res.json({ ideas });
    } catch (err) {
      const formatted = formatGeminiError(err);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  // KOTAK 1: Buat 5 Judul
  app.post('/api/ai/titles', async (req, res) => {
    try {
      const { topic } = req.body as { topic?: string };
      if (!topic || !topic.trim()) {
        res.status(400).json({ error: 'Topik atau ide video harus diisi terlebih dahulu.' });
        return;
      }

      const ai = getAiClient();
      const { response } = await generateTextWithFallback(ai, {
        contents: `Buatkan tepat 5 ide judul YouTube edukasi bergaya stickman (seperti Kok Bisa / Satu Persen) dalam Bahasa Indonesia untuk topik: "${topic.trim()}".
Judul harus memancing rasa ingin tahu tinggi, natural, tidak clickbait murahan, dan kuat secara CTR.
Untuk setiap judul berikan skor potensi klik 1 sampai 10 (angka bulat) dan alasan singkat pancingan penontonnya dalam Bahasa Indonesia.`,
        config: {
          systemInstruction:
            'Kamu adalah strategist konten YouTube edukasi berbahasa Indonesia yang ahli membuat judul rasa ingin tahu tinggi seperti channel Kok Bisa dan Satu Persen.',
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                title: { type: Type.STRING, description: 'Judul video YouTube dalam Bahasa Indonesia' },
                score: { type: Type.INTEGER, description: 'Skor daya tarik 1 sampai 10' },
                reason: { type: Type.STRING, description: 'Alasan singkat kenapa judul ini memancing klik penonton' },
              },
              required: ['title', 'score', 'reason'],
            },
          },
        },
        timeoutMs: 20_000,
      });

      const titles = parseJsonSafe<Array<{ title: string; score: number; reason: string }>>(
        response.text,
        []
      );
      res.json({ titles: titles.slice(0, 5) });
    } catch (err) {
      const formatted = formatGeminiError(err);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  // KOTAK 1: Buat Naskah Narasi
  app.post('/api/ai/script', async (req, res) => {
    try {
      const { topic, title, styleId, styleDescription, customInstruction, durationMinutes, targetWords } =
        req.body as {
          topic?: string;
          title?: string;
          styleId?: string;
          styleDescription?: string;
          customInstruction?: string;
          durationMinutes?: number;
          targetWords?: number;
        };

      if (!topic?.trim() && !title?.trim()) {
        res.status(400).json({ error: 'Isi topik atau judul video terlebih dahulu.' });
        return;
      }

      const words = Math.max(120, Math.min(5000, Number(targetWords) || (Number(durationMinutes) || 8) * 170));
      const minutes = Number(durationMinutes) || Math.round(words / 170);

      const stylePrompt =
        styleId === 'custom' && customInstruction?.trim()
          ? `Gaya narasi khusus dari pengguna: ${customInstruction.trim()}`
          : `Gaya narasi: ${styleDescription || 'Kok Bisa (pertanyaan pemantik, ramah, penuh rasa ingin tahu)'}`;

      const ai = getAiClient();
      const { response, model: usedModel } = await generateTextWithFallback(ai, {
        contents: `Tulis naskah narasi voice-over YouTube berbahasa Indonesia yang siap dibacakan langsung.

Topik: ${topic?.trim() || title?.trim()}
Judul terpilih: ${title?.trim() || topic?.trim()}
${stylePrompt}
Target durasi: sekitar ${minutes} menit
Target jumlah kata: sekitar ${words} kata (usahakan mendekati jumlah kata ini dengan ketat, antara ${Math.round(words * 0.9)} hingga ${Math.round(words * 1.1)} kata).

Struktur wajib naskah:
1. Hook super kuat di 10 detik pertama (2 sampai 3 kalimat pembuka yang langsung membuat penonton penasaran).
2. Alur pertanyaan pemantik lalu penjelasan bertahap yang logis dan mudah dicerna.
3. Gunakan analogi sehari-hari yang konkret agar konsep rumit jadi terasa dekat.
4. Sisipkan satu plot twist atau fakta mengejutkan di pertengahan hingga akhir.
5. Penutup yang berkesan dan mengajak berpikir.

ATURAN FORMAT KETAT:
- Tulis murni teks narasi yang diucapkan narator dalam paragraf mengalir.
- DILARANG menggunakan tanda baca aneh seperti asterisk, pagar, tanda kurung siku, garis miring, atau simbol markdown.
- DILARANG menulis penanda adegan, judul bab, atau instruksi visual seperti [Adegan 1], [Musik], (Tertawa), atau Narator:.
- DILARANG menggunakan emoji sama sekali.
- Gunakan kalimat alami Bahasa Indonesia yang enak diucapkan di mikrofon.`,
        config: {
          systemInstruction:
            'Kamu adalah penulis naskah video edukasi YouTube Indonesia terbaik. Tulis murni teks narasi yang mengalir alami tanpa markdown, tanpa penanda adegan, tanpa emoji, dan tanpa simbol aneh.',
          maxOutputTokens: Math.min(32768, Math.max(4096, Math.round(words * 4))),
        },
        flashTimeoutMs: 16_000,
        liteTimeoutMs: Math.min(60_000, Math.max(35_000, words * 20)),
      });

      const rawScript = (response.text || '')
        .replace(/[*#_`~[\]]/g, '')
        .replace(/\p{Extended_Pictographic}/gu, '')
        .trim();

      if (!rawScript) {
        res.status(502).json({
          error: 'AI mengembalikan naskah kosong. Silakan klik "Buat Naskah Narasi" sekali lagi.',
        });
        return;
      }

      res.json({ script: rawScript, model: usedModel });
    } catch (err) {
      const formatted = formatGeminiError(err);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  // KOTAK 3: Timestamp Adegan per Bagian Audio (~60 detik, waktu relatif terhadap awal bagian)
  app.post('/api/ai/timestamps', upload.single('audio'), async (req, res) => {
    const file = req.file;
    let uploadedFileName: string | null = null;

    try {
      if (!file) {
        res.status(400).json({ error: 'File potongan audio tidak ditemukan.' });
        return;
      }

      const chunkDuration = Number(req.body.chunkDuration || req.body.duration) || 45;
      const chunkIndex = Number(req.body.chunkIndex) || 0;
      const totalChunks = Number(req.body.totalChunks) || 1;
      const minSec = Math.max(1, Number(req.body.minSec) || 3);
      const maxSec = Math.max(minSec + 1, Number(req.body.maxSec) || 6);
      const referenceScript = typeof req.body.referenceScript === 'string' ? req.body.referenceScript.trim() : '';
      const pauseHints = typeof req.body.pauseHints === 'string' ? req.body.pauseHints.trim() : '';
      const mimeType = file.mimetype && file.mimetype !== 'application/octet-stream' ? file.mimetype : 'audio/wav';

      const ai = getAiClient();
      let audioPart:
        | { fileData: { fileUri: string; mimeType: string } }
        | { inlineData: { data: string; mimeType: string } };

      if (file.size > TWENTY_MB) {
        const uploaded = await ai.files.upload({
          file: file.path,
          config: { mimeType },
        });
        uploadedFileName = uploaded.name || null;

        let currentFile = uploaded;
        let attempts = 0;
        while (currentFile.state === 'PROCESSING' && attempts < 45) {
          await new Promise((r) => setTimeout(r, 2000));
          currentFile = await ai.files.get({ name: currentFile.name! });
          attempts++;
        }

        if (currentFile.state === 'FAILED') {
          throw new Error('Pemrosesan file audio di Gemini Files API gagal.');
        }

        audioPart = {
          fileData: {
            fileUri: currentFile.uri!,
            mimeType: currentFile.mimeType || mimeType,
          },
        };
      } else {
        const buffer = await fs.promises.readFile(file.path);
        audioPart = {
          inlineData: {
            data: buffer.toString('base64'),
            mimeType,
          },
        };
      }

      const estimatedCount = Math.max(2, Math.round(chunkDuration / ((minSec + maxSec) / 2)));

      const promptText = `Ini adalah bagian ke-${chunkIndex + 1} dari ${totalChunks} potongan audio narasi Bahasa Indonesia.
Durasi PERSIS potongan audio ini adalah ${chunkDuration.toFixed(2)} detik (dari detik 0.00 sampai ${chunkDuration.toFixed(2)}).
${pauseHints ? `\nTITIK JEDA NAPAS/HENING AKUSTIK YANG TERDETEKSI DI AUDIO INI (dalam detik relatif):\n[${pauseHints}]\nUtamakan memilih nilai "end" / "start" tepat pada titik-titik jeda hening di atas agar sinkron 100% dengan suara narator!` : ''}

TUGAS WAJIB:
Dengarkan suara narator dengan teliti, transkripsikan kata demi kata yang BENAR-BENAR DIUCAPKAN di audio ini, dan pecah dari detik 0.00 sampai detik ${chunkDuration.toFixed(2)} menjadi JSON array: [{ "start": number, "end": number, "text": string }].

ATURAN SINKRONISASI SUARA & TIMESTAMP (WAJIB SINKRON DENGAN SUARA):
1. Semua nilai "start" dan "end" WAJIB berupa waktu RELATIF terhadap awal potongan ini (mulai dari 0.00 hingga tepat ${chunkDuration.toFixed(2)} detik) dan WAJIB cocok persis dengan detik saat narator mengucapkan kalimat tersebut di audio.
2. JANGAN BERHENTI DI TENGAH! Adegan terakhir WAJIB berakhir mendekati ${chunkDuration.toFixed(2)} detik sehingga 100% durasi potongan ini tercakup (perkiraan sekitar ${estimatedCount} adegan).
3. Pecah timestamp mengikuti KALIMAT atau KLAUSA yang diucapkan narator dan membutuhkan perubahan visual baru (kisaran ${minSec} hingga ${maxSec} detik, fleksibel & tidak kaku).
4. Pecah HANYA pada jeda napas alami narator (gunakan daftar titik jeda hening di atas sebagai acuan utama). DILARANG memotong di tengah kata yang sedang diucapkan.
5. Field "text" WAJIB berisi kalimat narasi Bahasa Indonesia yang PERSIS terdengar diucapkan pada rentang detik tersebut (jangan mengarang kalimat yang tidak diucapkan di rentang waktu itu).
${referenceScript ? `\nCatatan ejaan istilah dari naskah (gunakan HANYA untuk membantu ejaan kata yang terdengar mirip — urutan dan waktu WAJIB mengikuti suara asli di audio):\n"""\n${referenceScript.slice(0, 8000)}\n"""` : ''}`;

      const timestampSchema = {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            start: { type: Type.NUMBER, description: 'Waktu mulai relatif dalam detik (mulai dari 0)' },
            end: { type: Type.NUMBER, description: 'Waktu selesai relatif dalam detik (hingga akhir potongan)' },
            text: { type: Type.STRING, description: 'Teks narasi Bahasa Indonesia yang diucapkan pada rentang ini' },
          },
          required: ['start', 'end', 'text'],
        },
      };

      const systemInst =
        'Kamu adalah sutradara storyboard dan sistem segmentasi timestamp audio presisi tinggi. Pecah audio secara alami dan tidak kaku di kisaran 3-6 detik mengikuti kalimat yang membutuhkan pergantian visual, WAJIB mencakup 100% durasi audio dari detik 0 sampai detik terakhir tanpa berhenti di tengah, dan kembalikan JSON array [{start, end, text}] yang valid.';

      let scenes: Array<{ start: number; end: number; text: string }> = [];
      let transcriptFallback = '';
      let usedModel = MODEL_FAST_LITE;
      let lastErr: unknown = null;

      // 1. Primary: gemini-3.1-flash-lite (ultra-fast MINIMAL thinking, avoids 503 congestion)
      // 2. Secondary: gemini-4-hydrogen (LOW thinking)
      const structuredModels: Array<{ model: string; thinkingLevel: ThinkingLevel }> = [
        { model: MODEL_FAST_LITE, thinkingLevel: ThinkingLevel.MINIMAL },
        { model: MODEL_FLASH, thinkingLevel: ThinkingLevel.LOW },
      ];

      for (const candidate of structuredModels) {
        try {
          usedModel = candidate.model;
          const response = await ai.models.generateContent({
            model: candidate.model,
            contents: {
              parts: [audioPart, { text: promptText }],
            },
            config: {
              systemInstruction: systemInst,
              responseMimeType: 'application/json',
              maxOutputTokens: 65536,
              thinkingConfig: {
                thinkingLevel: candidate.thinkingLevel,
              },
              responseSchema: timestampSchema,
            },
          });

          const parsed = parseJsonSafe<Array<{ start: number; end: number; text: string }>>(
            response.text,
            []
          );
          if (Array.isArray(parsed) && parsed.length > 0) {
            scenes = parsed;
            lastErr = null;
            break;
          }
        } catch (err) {
          lastErr = err;
          if (!isTransientAvailabilityError(err)) {
            throw err;
          }
        }
      }

      // 3. Dedicated audio transcription fallback: gemini-3.5-transcribe
      if (scenes.length === 0) {
        try {
          usedModel = MODEL_TRANSCRIBE;
          const trRes = await ai.models.generateContent({
            model: MODEL_TRANSCRIBE,
            contents: {
              parts: [
                audioPart,
                {
                  text: 'Transkripsikan seluruh audio Bahasa Indonesia ini secara lengkap dan akurat dalam satu paragraf teks biasa tanpa timestamp.',
                },
              ],
            },
          });
          transcriptFallback = (trRes.text || '').trim();
          if (transcriptFallback) {
            lastErr = null;
          }
        } catch (err) {
          if (!lastErr) lastErr = err;
        }
      }

      if (scenes.length === 0 && !transcriptFallback && lastErr) {
        throw lastErr;
      }

      res.json({
        scenes,
        transcript: transcriptFallback || undefined,
        chunkIndex,
        model: usedModel,
        usedFilesApi: file.size > TWENTY_MB,
      });
    } catch (err) {
      const formatted = formatGeminiError(err);
      res.status(formatted.status).json({ error: formatted.message });
    } finally {
      safeUnlink(file?.path);
      if (uploadedFileName) {
        try {
          const ai = getAiClient();
          await ai.files.delete({ name: uploadedFileName });
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  });

  // KOTAK 4: Prompt Gambar per Batch (hingga 25 adegan per panggilan, wajib 1 objek per adegan)
  app.post('/api/ai/prompts', async (req, res) => {
    try {
      const { scenes, scriptSummary, styleText, characterText, previousSceneHint } = req.body as {
        scenes?: Array<{ id: number | string; text?: string; start?: number; end?: number }>;
        scriptSummary?: string;
        styleText?: string;
        characterText?: string;
        previousSceneHint?: string;
      };

      if (!Array.isArray(scenes) || scenes.length === 0) {
        res.status(400).json({ error: 'Daftar adegan kosong.' });
        return;
      }

      if (scenes.length > 25) {
        res.status(400).json({ error: 'Maksimal 25 adegan per batch permintaan.' });
        return;
      }

      const normalizedInput = scenes.map((s, idx) => {
        const parsedId = Number(s.id);
        return {
          id: Number.isFinite(parsedId) ? Math.trunc(parsedId) : idx + 1,
          start: Number.isFinite(Number(s.start)) ? Number(s.start) : 0,
          end: Number.isFinite(Number(s.end)) ? Number(s.end) : 0,
          text: typeof s.text === 'string' ? s.text.trim() : '',
        };
      });

      const ai = getAiClient();
      const sceneListStr = normalizedInput
        .map(
          (s) =>
            `- ID ${s.id} [${s.start.toFixed(1)}s–${s.end.toFixed(1)}s]: "${s.text || '(jeda visual)'}"`
        )
        .join('\n');

      const expectedIdsStr = normalizedInput.map((s) => s.id).join(', ');

      const promptSchema = {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            id: {
              type: Type.INTEGER,
              description: 'Exact numeric scene id matching the input list',
            },
            scene: {
              type: Type.STRING,
              description:
                'Specific English single static keyframe description illustrating this scene narration, ending with Clean artwork, strictly no text, no numbers, no UI.',
            },
            shotType: {
              type: Type.STRING,
              description: 'Camera shot type such as Wide shot, Medium shot, or Close-up',
            },
          },
          required: ['id', 'scene'],
        },
      };

      const promptContents = `You must generate EXACTLY ${normalizedInput.length} distinct visual keyframe scene descriptions in ENGLISH — one JSON object for EVERY SINGLE scene ID in [${expectedIdsStr}]. Do NOT skip any ID and do NOT merge scenes!

Global narration summary (keep visual motifs, props, and world coherent across the video):
${(scriptSummary || 'Indonesian educational explainer video.').slice(0, 1400)}

Locked style/character reference (do NOT copy these blocks into "scene"; they will be prepended automatically in code):
STYLE: ${(styleText || '').slice(0, 900)}
CHARACTER: ${(characterText || '').slice(0, 900)}
${previousSceneHint ? `Previous batch last scene (vary shot and setting for the first scene below): ${previousSceneHint.slice(0, 300)}` : ''}

Input scenes (${normalizedInput.length} items — you MUST return an array of length ${normalizedInput.length}):
${sceneListStr}

Strict requirements for EVERY item { "id", "scene", "shotType" }:
1. "id": MUST exactly match each input scene ID (${expectedIdsStr}).
2. "scene": Concrete, specific visual storytelling keyframe in English (2-3 concise sentences) directly illustrating what is spoken in THAT scene's Indonesian narration (NEVER generic or repetitive). Describe one single static moment with clear subject action/pose, concrete visual metaphor or props, expressive body language, specific environment/background, lighting, and camera framing.
3. Vary camera framing across consecutive scenes (Wide shot, Medium shot, Close-up, Over-the-shoulder, High-angle shot) and vary backgrounds/props so no two adjacent scenes look alike.
4. ALWAYS end every "scene" string with the exact sentence: "Clean artwork, strictly no text, no numbers, no UI."
5. NEVER include text, labels, numbers, charts with digits, speech bubbles, or UI elements inside the artwork description.`;

      const promptSystemInst =
        'You are an expert storyboard director for Kok Bisa / Satu Persen 2D stickman educational videos. You MUST return a JSON array with EXACTLY one object per requested scene ID, never fewer, never truncated. Each "scene" value is a rich, specific English static keyframe ending with "Clean artwork, strictly no text, no numbers, no UI."';

      const flashFirst = Date.now() >= flashCongestedUntil;
      const promptModels: Array<{
        model: string;
        thinkingLevel: ThinkingLevel;
        timeoutMs: number;
      }> = flashFirst
        ? [
            { model: MODEL_FLASH, thinkingLevel: ThinkingLevel.LOW, timeoutMs: 22_000 },
            { model: MODEL_FAST_LITE, thinkingLevel: ThinkingLevel.MINIMAL, timeoutMs: 32_000 },
          ]
        : [
            { model: MODEL_FAST_LITE, thinkingLevel: ThinkingLevel.MINIMAL, timeoutMs: 32_000 },
            { model: MODEL_FLASH, thinkingLevel: ThinkingLevel.LOW, timeoutMs: 22_000 },
          ];

      const maxTokens = Math.min(16384, Math.max(4096, normalizedInput.length * 600));
      let bestResults: Array<{ id: number; scene: string; shotType?: string }> = [];
      let lastPromptErr: unknown = null;

      for (const candidate of promptModels) {
        try {
          const response = await generateWithTimeout(
            ai.models.generateContent({
              model: candidate.model,
              contents: promptContents,
              config: {
                systemInstruction: promptSystemInst,
                responseMimeType: 'application/json',
                maxOutputTokens: maxTokens,
                thinkingConfig: {
                  thinkingLevel: candidate.thinkingLevel,
                },
                responseSchema: promptSchema,
              },
            }),
            candidate.timeoutMs
          );

          const parsed = parseAndNormalizePromptItems(response.text);
          if (parsed.length > bestResults.length) {
            bestResults = parsed;
          }

          // Complete batch received — no need to call fallback model
          if (bestResults.length >= normalizedInput.length) {
            lastPromptErr = null;
            break;
          }
          // Partial or empty response: try fallback model if available
          if (parsed.length === 0) {
            lastPromptErr = new Error('Model AI mengembalikan daftar prompt kosong.');
          }
        } catch (err) {
          lastPromptErr = err;
          if (candidate.model === MODEL_FLASH && isTransientAvailabilityError(err)) {
            flashCongestedUntil = Date.now() + CONGESTION_COOLDOWN_MS;
          }
          const isAuthOrQuotaFatal =
            (err as { statusCode?: number; status?: number })?.statusCode === 403 ||
            (err as { status?: number })?.status === 403;
          if (isAuthOrQuotaFatal) {
            throw err;
          }
          // Otherwise continue to fallback candidate
        }
      }

      if (bestResults.length === 0 && lastPromptErr) {
        throw lastPromptErr;
      }

      res.json({ prompts: bestResults });
    } catch (err) {
      const formatted = formatGeminiError(err);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  // KOTAK 5: Cocokkan Gambar dengan AI (maks 10 thumbnail 320px per batch)
  app.post('/api/ai/match-images', upload.array('thumbnails', 10), async (req, res) => {
    const files = (req.files as Express.Multer.File[]) || [];
    try {
      if (files.length === 0) {
        res.status(400).json({ error: 'Tidak ada gambar thumbnail yang dikirim.' });
        return;
      }

      const rawScenes = typeof req.body.scenes === 'string' ? JSON.parse(req.body.scenes) : [];
      const rawImageIds = typeof req.body.imageIds === 'string' ? JSON.parse(req.body.imageIds) : [];

      const sceneDescriptions = (
        rawScenes as Array<{ id: number; text: string; scenePrompt?: string }>
      )
        .map(
          (s) =>
            `Scene ID ${s.id}: Narration="${s.text}"${s.scenePrompt ? ` | VisualPrompt="${s.scenePrompt}"` : ''}`
        )
        .join('\n');

      const parts: Array<{ inlineData: { data: string; mimeType: string } } | { text: string }> = [
        {
          text: `Match each of the ${files.length} uploaded thumbnail images (indexed 0 to ${files.length - 1} in exact order) to the single most fitting Scene ID from the available scenes list below.
Each Scene ID should be used at most once if possible.

Available scenes:
${sceneDescriptions}`,
        },
      ];

      for (let i = 0; i < files.length; i++) {
        const buf = await fs.promises.readFile(files[i].path);
        parts.push({ text: `Image index ${i} (id: ${rawImageIds[i] || i}):` });
        parts.push({
          inlineData: {
            data: buf.toString('base64'),
            mimeType: files[i].mimetype || 'image/jpeg',
          },
        });
      }

      const ai = getAiClient();
      const response = await ai.models.generateContent({
        model: MODEL_FLASH,
        contents: { parts },
        config: {
          systemInstruction:
            'You are a visual storyboard matching engine. Inspect each thumbnail image and match it accurately to the best matching scene ID from the list.',
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                imageIndex: { type: Type.INTEGER },
                sceneId: { type: Type.INTEGER },
                confidence: { type: Type.NUMBER },
              },
              required: ['imageIndex', 'sceneId'],
            },
          },
        },
      });

      const matches = parseJsonSafe<Array<{ imageIndex: number; sceneId: number; confidence?: number }>>(
        response.text,
        []
      );

      res.json({ matches });
    } catch (err) {
      const formatted = formatGeminiError(err);
      res.status(formatted.status).json({ error: formatted.message });
    } finally {
      for (const f of files) {
        safeUnlink(f.path);
      }
    }
  });

  // KOTAK 6: Buat Paket YouTube
  app.post('/api/ai/youtube-package', async (req, res) => {
    try {
      const { topic, title, script, scenes, styleText, characterText } = req.body as {
        topic?: string;
        title?: string;
        script?: string;
        scenes?: Array<{ id: number; start: number; end: number; text: string }>;
        styleText?: string;
        characterText?: string;
      };

      if (!topic?.trim() && !title?.trim() && !script?.trim()) {
        res.status(400).json({ error: 'Isi topik, judul, atau naskah terlebih dahulu sebelum membuat paket YouTube.' });
        return;
      }

      const sceneSummaryList = Array.isArray(scenes)
        ? scenes
            .map((s) => `[ID ${s.id} | ${s.start.toFixed(1)}s] ${s.text}`)
            .join('\n')
            .slice(0, 12000)
        : '';

      const ai = getAiClient();
      const response = await ai.models.generateContent({
        model: MODEL_FLASH,
        contents: `Buatkan Paket Optimasi YouTube lengkap untuk video edukasi stickman berbahasa Indonesia berikut:

Topik: ${topic || '-'}
Judul utama saat ini: ${title || '-'}
Cuplikan naskah:
"""
${(script || '').slice(0, 6000)}
"""
Gaya visual karakter:
${styleText || ''}
${characterText || ''}

Daftar adegan asli dari Kotak 3 (gunakan ID adegan ini untuk memilih 6 sampai 10 titik awal bab/chapter):
${sceneSummaryList || '(Belum ada data adegan Kotak 3)'}

Hasilkan JSON lengkap dengan 5 komponen:
1. "thumbnailPrompts": tepat 3 prompt thumbnail 16:9 klik-tinggi dalam Bahasa Inggris yang menggambarkan karakter stickman sangat ekspresif, kontras warna kuat, komposisi YouTube CTR tinggi, DAN boleh menyertakan teks pendek maksimal 4 kata dalam Bahasa Indonesia yang dicetak besar dan jelas di thumbnail (sebutkan teks pendek Bahasa Indonesia-nya di field "overlayText" dan juga masukkan dalam deskripsi prompt-nya).
2. "titleVariants": tepat 5 varian judul YouTube Bahasa Indonesia beserta "ctrReason" (alasan CTR-nya).
3. "description": Deskripsi YouTube SEO berbahasa Indonesia dengan paragraf pembuka yang kuat, ringkasan nilai video, dan ajakan diskusi yang natural (tanpa daftar chapter karena chapter akan diformat terpisah oleh sistem).
4. "chapterPicks": pilih 6 hingga 10 adegan awal bab dari daftar adegan asli di atas (jika daftar adegan tersedia; bab pertama WAJIB menggunakan ID adegan pertama). Format setiap item: { "sceneId": number, "title": "Judul Bab Singkat Bahasa Indonesia" }.
5. "tags": array 12-18 tag YouTube relevan Bahasa Indonesia, "hashtags": array 4-6 hashtag (diawali #), dan "pinnedComment": ide komentar yang disematkan untuk memancing diskusi penonton.`,
        config: {
          systemInstruction:
            'Kamu adalah konsultan pertumbuhan YouTube edukasi Indonesia yang menguasai CTR thumbnail, copywriting judul, SEO deskripsi, dan retensi penonton.',
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              thumbnailPrompts: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    concept: { type: Type.STRING, description: 'Nama singkat konsep thumbnail (Bahasa Indonesia)' },
                    overlayText: { type: Type.STRING, description: 'Teks pendek maks 4 kata Bahasa Indonesia di thumbnail' },
                    prompt: { type: Type.STRING, description: 'Prompt 16:9 lengkap siap pakai untuk generator gambar' },
                  },
                  required: ['concept', 'overlayText', 'prompt'],
                },
              },
              titleVariants: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    title: { type: Type.STRING },
                    ctrReason: { type: Type.STRING },
                  },
                  required: ['title', 'ctrReason'],
                },
              },
              description: { type: Type.STRING },
              chapterPicks: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    sceneId: { type: Type.INTEGER },
                    title: { type: Type.STRING },
                  },
                  required: ['sceneId', 'title'],
                },
              },
              tags: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              hashtags: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              pinnedComment: { type: Type.STRING },
            },
            required: [
              'thumbnailPrompts',
              'titleVariants',
              'description',
              'chapterPicks',
              'tags',
              'hashtags',
              'pinnedComment',
            ],
          },
        },
      });

      const data = parseJsonSafe(response.text, null);
      res.json({ packageData: data });
    } catch (err) {
      const formatted = formatGeminiError(err);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  // Frontend serving: Vite middleware in dev, dist/ static in production
  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    let viteMiddleware: express.RequestHandler | null = null;
    const viteReady = import('vite')
      .then(({ createServer: createViteServer }) =>
        createViteServer({
          server: {
            middlewareMode: true,
            hmr: false,
            watch: null,
          },
          appType: 'spa',
        })
      )
      .then((vite) => {
        viteMiddleware = vite.middlewares;
      });

    app.use(async (req, res, next) => {
      if (!viteMiddleware) {
        await viteReady;
      }
      if (viteMiddleware) {
        viteMiddleware(req, res, next);
      } else {
        next();
      }
    });
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Stickman Video Studio server berjalan di http://localhost:${PORT}`);
  });
}

createApp();
