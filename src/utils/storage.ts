import {
  createDefaultProject,
  VISUAL_STYLE_PRESETS,
  type StudioProject,
  type WizardStep,
} from '../types/project';
import {
  createThumbnailFromBlob,
  saveAudioBlob,
  saveManyImageRecords,
  type StoredImageRecord,
} from './mediaDb';
import {
  hasImbalancedSpeechTimestamps,
  rebalanceSceneTimestampsToSpeechDuration,
} from './scriptTimestampAligner';

const STORAGE_KEY = 'stickman_video_studio_project_v1';

export function loadProjectFromLocalStorage(): StudioProject {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createDefaultProject();
    const parsed = JSON.parse(raw) as Partial<StudioProject>;
    const defaults = createDefaultProject();
    const audioDur = parsed.audioMeta?.duration || 0;
    const rawScenes = Array.isArray(parsed.scenes) ? parsed.scenes : defaults.scenes;
    const healedScenes =
      rawScenes.length > 0 && hasImbalancedSpeechTimestamps(rawScenes, audioDur)
        ? rebalanceSceneTimestampsToSpeechDuration(rawScenes, audioDur)
        : rawScenes;

    return {
      ...defaults,
      ...parsed,
      ideaSuggestions: Array.isArray(parsed.ideaSuggestions) ? parsed.ideaSuggestions : [],
      scenes: healedScenes,
      subtitleSettings: {
        ...defaults.subtitleSettings,
        ...(parsed.subtitleSettings || {}),
      },
      videoSettings: {
        ...defaults.videoSettings,
        ...(parsed.videoSettings || {}),
      },
    };
  } catch {
    return createDefaultProject();
  }
}

export function saveProjectToLocalStorage(project: StudioProject): void {
  try {
    const payload: StudioProject = {
      ...project,
      updatedAt: Date.now(),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore quota errors silently; media blobs live in IndexedDB
  }
}

export function clearProjectLocalStorage(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function serializeProjectForExport(project: StudioProject): string {
  // Explicitly export JSON metadata only (never audio/image binary blobs)
  const clean: StudioProject = {
    ...project,
    updatedAt: Date.now(),
  };
  return JSON.stringify(clean, null, 2);
}

export function parseImportedProject(jsonText: string): StudioProject {
  const parsed = JSON.parse(jsonText) as Partial<StudioProject>;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Format file proyek JSON tidak valid.');
  }
  const defaults = createDefaultProject();
  const step = Number(parsed.activeStep);
  const validStep: WizardStep = step >= 1 && step <= 6 ? (step as WizardStep) : 1;

  return {
    ...defaults,
    ...parsed,
    activeStep: validStep,
    scenes: Array.isArray(parsed.scenes) ? parsed.scenes : [],
    ideaSuggestions: Array.isArray(parsed.ideaSuggestions) ? parsed.ideaSuggestions : [],
    titleSuggestions: Array.isArray(parsed.titleSuggestions) ? parsed.titleSuggestions : [],
    imagesMeta: Array.isArray(parsed.imagesMeta) ? parsed.imagesMeta : [],
    subtitleSettings: {
      ...defaults.subtitleSettings,
      ...(parsed.subtitleSettings || {}),
    },
    videoSettings: {
      ...defaults.videoSettings,
      ...(parsed.videoSettings || {}),
    },
  };
}

export function triggerTextDownload(filename: string, content: string, mimeType = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function triggerBlobDownload(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * Generates a synthetic WAV audio file (16-bit PCM mono, 22050Hz) with realistic syllable cadence
 * and silence/breath valleys at sentence cut boundaries for deterministic ?demo=1 testing.
 */
function createSyntheticWavBlob(durationSec: number, cutBoundaries: number[] = []): Blob {
  const sampleRate = 22050;
  const numSamples = Math.floor(sampleRate * durationSec);
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, numSamples * 2, true);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const edgeEnv = Math.min(1, t * 4) * Math.min(1, (durationSec - t) * 4);
    // Natural syllable cadence (~4.5 syllables/sec + word emphasis modulation)
    const syllableEnv =
      0.35 +
      0.45 * Math.pow(Math.max(0, Math.sin(2 * Math.PI * 4.4 * t + Math.sin(t * 1.7))), 1.4) +
      0.2 * Math.abs(Math.cos(2 * Math.PI * 1.8 * t));

    // Breath pause valley near sentence cut boundaries
    let pauseAtten = 1;
    for (let c = 0; c < cutBoundaries.length; c++) {
      const dist = Math.abs(t - cutBoundaries[c]);
      if (dist < 0.22) {
        const norm = dist / 0.22;
        pauseAtten = Math.min(pauseAtten, 0.02 + 0.98 * norm * norm);
      }
    }

    const freq = 185 + 55 * Math.sin(t * 1.9);
    const harmonic =
      Math.sin(2 * Math.PI * freq * t) * 0.65 +
      Math.sin(4 * Math.PI * freq * t) * 0.25 +
      Math.sin(6 * Math.PI * freq * t) * 0.1;
    const sample = harmonic * 0.42 * edgeEnv * syllableEnv * pauseAtten;
    view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, sample)) * 32767, true);
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

/**
 * Draws a Kok-Bisa-style watercolor stickman illustration onto an offscreen canvas for ?demo=1 seeding.
 */
async function createSyntheticStickmanImage(sceneIdx: number, palette: [string, string]): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext('2d')!;

  // Warm watercolor background gradient
  const grad = ctx.createLinearGradient(0, 0, 1280, 720);
  grad.addColorStop(0, palette[0]);
  grad.addColorStop(1, palette[1]);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 1280, 720);

  // Soft atmospheric circles
  ctx.fillStyle = 'rgba(255, 245, 224, 0.25)';
  ctx.beginPath();
  ctx.arc(320 + (sceneIdx % 3) * 280, 220, 180, 0, Math.PI * 2);
  ctx.fill();

  // Floor horizon line
  ctx.strokeStyle = '#1E2430';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(120, 560);
  ctx.lineTo(1160, 560);
  ctx.stroke();

  // Stickman character (Kok Bisa style)
  const cx = 560 + ((sceneIdx % 3) - 1) * 90;
  const cy = 360;

  // Slate-blue trapezoid tunic (#5B9BD5)
  ctx.fillStyle = '#5B9BD5';
  ctx.strokeStyle = '#14171F';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(cx - 28, cy + 45);
  ctx.lineTo(cx + 28, cy + 45);
  ctx.lineTo(cx + 46, cy + 145);
  ctx.lineTo(cx - 46, cy + 145);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Legs
  ctx.beginPath();
  ctx.moveTo(cx - 18, cy + 145);
  ctx.lineTo(cx - 24, cy + 200);
  ctx.moveTo(cx + 18, cy + 145);
  ctx.lineTo(cx + 26, cy + 200);
  ctx.stroke();

  // Arms
  ctx.beginPath();
  ctx.moveTo(cx - 28, cy + 68);
  ctx.lineTo(cx - 88, cy + 32 - (sceneIdx % 2) * 35);
  ctx.moveTo(cx + 28, cy + 68);
  ctx.lineTo(cx + 92, cy + 48 + (sceneIdx % 2) * 24);
  ctx.stroke();

  // Oversized bald cream-white head
  ctx.fillStyle = '#FFF9EC';
  ctx.beginPath();
  ctx.arc(cx, cy - 12, 62, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Two vertical black dot eyes + simple line mouth
  ctx.fillStyle = '#14171F';
  ctx.beginPath();
  ctx.ellipse(cx - 16, cy - 16, 4.5, 7, 0, 0, Math.PI * 2);
  ctx.ellipse(cx + 16, cy - 16, 4.5, 7, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.lineWidth = 4.5;
  ctx.arc(cx, cy + 4, 14, 0.15 * Math.PI, 0.85 * Math.PI);
  ctx.stroke();

  return new Promise<Blob>((resolve) => {
    canvas.toBlob((b) => resolve(b!), 'image/jpeg', 0.88);
  });
}

/**
 * Seeds a complete 14-scene demo project into IndexedDB + returns StudioProject (only triggered via ?demo=1).
 */
export async function createSeededDemoProject(): Promise<StudioProject> {
  const kokBisa = VISUAL_STYLE_PRESETS[0];
  const sampleTexts = [
    'Pernah nggak kamu merasa waktu berjalan jauh lebih cepat saat liburan dibanding hari Senin pagi?',
    'Padahal jam di dinding berdetak dengan kecepatan yang persis sama, enam puluh detik setiap menitnya.',
    'Rahasianya ternyata bukan ada pada jam tanganmu, melainkan di dalam cara otak manusia merekam memori baru.',
    'Saat kita mengalami hal baru di tempat asing, otak bekerja ekstra keras memotret setiap detail kecil.',
    'Bayangkan otakmu seperti kamera analog yang memotret puluhan foto setiap menit saat menjelajah kota baru.',
    'Sebaliknya, saat kamu menjalani rutinitas yang sama persis setiap hari, otak masuk ke mode autopilot hemat energi.',
    'Semua perjalanan berangkat kerja yang seragam diringkas otak menjadi satu file memori tipis saja.',
    'Akibatnya ketika kamu menoleh ke belakang di akhir minggu, rutinitas terasa menguap dalam sekejap mata.',
    'Namun fakta mengejutkannya, saat sedang berada di tengah kebosanan, detik justru terasa melambat menyiksa.',
    'Ilmuwan menyebut fenomena paradoks ini sebagai holiday paradox yang dialami hampir semua orang di dunia.',
    'Banyak orang mengira semakin tua usia kita, semakin cepat pula satu tahun berlalu tanpa terasa.',
    'Kabar baiknya, kamu bisa memperlambat rasa waktu dengan satu kebiasaan sederhana setiap pekan.',
    'Cukup kenalkan pengalaman baru, rute jalan berbeda, atau keterampilan unik agar otak kembali merekam kaya.',
    'Jadi mulai besok, hal baru apa yang ingin kamu coba supaya hidupmu terasa jauh lebih panjang dan bermakna?',
  ];

  const avgBeatSec = 5.2;
  const totalDur = Math.round(sampleTexts.length * avgBeatSec * 10) / 10; // 72.8 seconds (~162 wpm natural Indonesian narration)

  const palettes: Array<[string, string]> = [
    ['#F5E6CC', '#D6B88D'],
    ['#DCE8F2', '#9BBAD6'],
    ['#F4DFD0', '#D9A78B'],
    ['#E2ECD9', '#A8C49B'],
  ];

  const imageRecords: StoredImageRecord[] = [];
  for (let i = 0; i < 6; i++) {
    const origBlob = await createSyntheticStickmanImage(i, palettes[i % palettes.length]);
    const { thumbBlob, width, height } = await createThumbnailFromBlob(origBlob, 320);
    imageRecords.push({
      id: `demo-img-${i + 1}`,
      fileName: `scene_${String(i + 1).padStart(3, '0')}.jpg`,
      lastModified: Date.now() - (10 - i) * 1000,
      fileSize: origBlob.size,
      mimeType: 'image/jpeg',
      width,
      height,
      originalBlob: origBlob,
      thumbBlob,
    });
  }
  await saveManyImageRecords(imageRecords);

  const initialScenes = sampleTexts.map((text, idx) => ({
    id: idx + 1,
    start: idx * avgBeatSec,
    end: (idx + 1) * avgBeatSec,
    text,
    shotType: idx % 3 === 0 ? 'Wide shot' : idx % 3 === 1 ? 'Medium shot' : 'Close-up',
    hasCrowd: idx === 10,
    scenePrompt:
      idx % 3 === 0
        ? 'Wide shot of the stickman looking up at a giant glowing watercolor clock floating in a warm golden sky, curious posture.'
        : idx % 3 === 1
          ? 'Medium shot of the stickman holding a vintage sketchbook beside a cozy wooden desk with floating memory Polaroids.'
          : 'Close-up of the stickman tilting his round cream-white head with wide dot eyes as warm light beams highlight a floating hourglass.',
    imageId: idx < imageRecords.length ? imageRecords[idx].id : null,
  }));

  const scenes = rebalanceSceneTimestampsToSpeechDuration(initialScenes, totalDur);
  const cutBoundaries = scenes.slice(0, -1).map((s) => s.end);
  const wavBlob = createSyntheticWavBlob(totalDur, cutBoundaries);

  await saveAudioBlob({
    id: 'primary',
    blob: wavBlob,
    fileName: 'narasi-paradoks-waktu.wav',
    fileSize: wavBlob.size,
    mimeType: 'audio/wav',
    duration: totalDur,
  });

  return {
    ...createDefaultProject(),
    activeStep: 1,
    topic: 'Kenapa waktu terasa lebih cepat saat kita semakin dewasa dan saat liburan?',
    ideaSuggestions: [
      {
        idea: 'Kenapa orang yang paling sering menolong justru paling sering dijauhi secara diam-diam? (Efek Do-Gooder Derogation)',
        category: 'Motivasi & Psikologi',
        hook: 'Fenomena psikologi jarang dibahas yang langsung bikin penonton merasa relate di 5 detik pertama.',
        viralScore: 9,
      },
      {
        idea: 'Bagaimana jika gravitasi bumi mendadak berkurang 50% selama tepat 24 jam saja?',
        category: 'Bagaimana Jika',
        hook: 'Eksperimen pikiran visual ekstrem yang sangat cocok digambar lewat animasi stickman.',
        viralScore: 9,
      },
      {
        idea: 'Fakta aneh di balik "Efek Pintu": kenapa kita selalu lupa tujuan begitu melangkah masuk ke ruangan lain?',
        category: 'Fakta Unik',
        hook: 'Pengalaman universal sehari-hari yang ternyata punya penjelasan neurosains tak terduga.',
        viralScore: 10,
      },
      {
        idea: 'Kenapa semakin banyak pilihan di hidupmu, semakin tinggi risiko kamu menyesal (Paradoks Kebebasan)?',
        category: 'Motivasi & Psikologi',
        hook: 'Menjawab keresahan generasi muda soal FOMO dan quarter-life crisis dengan sudut pandang anti-klise.',
        viralScore: 9,
      },
      {
        idea: 'Bagaimana jika manusia tidak pernah lagi butuh tidur, tapi umur kita berkurang 10 tahun?',
        category: 'Bagaimana Jika',
        hook: 'Dilema filosofis & sains yang memancing perdebatan ramai di kolom komentar.',
        viralScore: 9,
      },
      {
        idea: 'Sejarah gila tahun 536 Masehi: tahun tergelap di bumi ketika matahari hilang selama 18 bulan penuh',
        category: 'Sejarah Unik',
        hook: 'Kisah sejarah nyata yang jarang muncul di buku sekolah dan penuh plot twist iklim.',
        viralScore: 9,
      },
      {
        idea: 'Kenapa suara rekaman kita sendiri selalu terdengar aneh dan bikin malu saat diputar ulang?',
        category: 'Fakta Unik',
        hook: 'Fakta akustik tulang tengkorak yang langsung bikin penonton mencoba mengingat suaranya sendiri.',
        viralScore: 8,
      },
      {
        idea: 'Alasan ilmiah kenapa orang yang "terlalu pintar" sering kalah dari orang yang konsisten bertindak',
        category: 'Motivasi & Psikologi',
        hook: 'Motivasi berbasis riset kognitif tanpa nada menggurui, kuat untuk retensi penonton.',
        viralScore: 9,
      },
      {
        idea: 'Bagaimana jika seluruh internet dunia mati total selama 7 hari—apa yang terjadi jam demi jam?',
        category: 'Bagaimana Jika',
        hook: 'Alur kronologis jam ke jam yang menegangkan dan sangat relevan dengan kehidupan modern.',
        viralScore: 10,
      },
      {
        idea: 'Fenomena "Phantom Vibration": kenapa otakmu sering merasa HP bergetar di saku padahal tidak ada notifikasi?',
        category: 'Fakta Unik',
        hook: 'Fakta psikologi modern yang dialami hampir semua pemilik smartphone namun jarang tahu alasannya.',
        viralScore: 8,
      },
    ],
    selectedTitle: 'Kenapa Waktu Terasa Makin Cepat Saat Kita Dewasa?',
    titleSuggestions: [
      {
        title: 'Kenapa Waktu Terasa Makin Cepat Saat Kita Dewasa?',
        score: 9,
        reason: 'Relatable untuk hampir semua penonton dewasa dan langsung memancing rasa ingin tahu ilmiah.',
      },
      {
        title: 'Otakmu Diam-Diam Mempercepat Waktu, Ini Penjelasan Sainsnya',
        score: 9,
        reason: 'Menghadirkan misteri tentang cara kerja otak sendiri sehingga mendorong klik tinggi.',
      },
      {
        title: 'Paradoks Liburan: Kenapa Seminggu Liburan Terasa Cuma Sehari?',
        score: 8,
        reason: 'Memakai pengalaman sehari-hari yang kontras dan memicu pertanyaan spontan.',
      },
      {
        title: 'Cara Sains Memperlambat Waktu Agar Hidup Terasa Lebih Panjang',
        score: 8,
        reason: 'Menawarkan manfaat nyata yang bisa langsung dipraktikkan penonton.',
      },
      {
        title: 'Apakah Jam Berjalan Lebih Cepat? Fakta Mengejutkan Memori Otak',
        score: 7,
        reason: 'Format pertanyaan klasiknya cocok untuk audiens penasaran ala Kok Bisa.',
      },
    ],
    narrationStyle: 'kok-bisa',
    targetDurationMinutes: 8,
    targetWordCount: 1360,
    script: sampleTexts.join(' '),
    audioMeta: {
      fileName: 'narasi-paradoks-waktu.wav',
      fileSize: wavBlob.size,
      mimeType: 'audio/wav',
      duration: totalDur,
      usesFilesApi: false,
    },
    referenceScript: sampleTexts.join(' '),
    minSceneSec: 3,
    maxSceneSec: 6,
    scenes,
    visualStyle: 'kok-bisa-watercolor',
    stylePrompt: kokBisa.stylePrompt,
    characterPrompt: kokBisa.characterPrompt,
    crowdPrompt: kokBisa.crowdPrompt,
    imagesMeta: imageRecords.map(({ originalBlob: _o, thumbBlob: _t, ...meta }) => meta),
    youtubePackage: {
      thumbnailPrompts: [
        {
          concept: 'Stickman Mengejar Jam Raksasa',
          overlayText: 'WAKTU MAKIN CEPAT?',
          prompt:
            '16:9 high-CTR YouTube thumbnail, Kok Bisa watercolor ink stickman looking shocked while chasing a giant melting golden pocket watch against a deep midnight blue background, bold warm orange rim lighting, crisp Indonesian headline text "WAKTU MAKIN CEPAT?" in thick white and yellow letters on the left.',
        },
        {
          concept: 'Otak Mode Autopilot vs Kamera',
          overlayText: 'OTAK KITA AUTOPILOT',
          prompt:
            '16:9 split-screen high-contrast editorial stickman thumbnail: left side dull monochrome office routine, right side vibrant golden adventure with camera flashes, expressive stickman in the center pointing in surprise, bold Indonesian text "OTAK KITA AUTOPILOT".',
        },
        {
          concept: 'Paradoks Kalender Menguap',
          overlayText: 'RAHASIA PARADOKS WAKTU',
          prompt:
            '16:9 dramatic watercolor stickman thumbnail holding a glowing hourglass whose sand turns into floating calendar pages, warm golden glow against dark slate sky, bold Indonesian text "RAHASIA PARADOKS WAKTU".',
        },
      ],
      titleVariants: [
        {
          title: 'Kenapa Waktu Terasa Makin Cepat Saat Kita Dewasa?',
          ctrReason: 'Pertanyaan universal dengan relevansi emosional tinggi.',
        },
        {
          title: 'Holiday Paradox: Kenapa Liburan Terasa Berakhir Begitu Cepat?',
          ctrReason: 'Memperkenalkan istilah unik yang membuat penonton penasaran.',
        },
        {
          title: 'Ini Alasan Otakmu Membuat Satu Tahun Terasa Seperti Sebulan',
          ctrReason: 'Kontras waktu yang tajam memicu rasa ingin tahu instan.',
        },
        {
          title: 'Kenapa Rutinitas Membuat Hidup Terasa Singkat? (Penjelasan Sains)',
          ctrReason: 'Menyasar keresahan pekerja dan mahasiswa setiap hari.',
        },
        {
          title: 'Cara Memperlambat Waktu Menurut Neurosains, Ternyata Sederhana!',
          ctrReason: 'Memberi janji solusi praktis berbasis sains.',
        },
      ],
      description:
        'Pernahkah kamu merasa hari Senin pagi berjalan sangat lambat, tapi tahu-tahu satu tahun sudah hampir habis lagi? Di video ini kita membedah cara kerja memori otak manusia, fenomena Holiday Paradox, dan bagaimana rutinitas autopilot memengaruhi persepsi waktu kita.\n\nTonton sampai habis untuk mengetahui satu trik sains sederhana agar harimu terasa jauh lebih penuh dan bermakna.',
      chapters: [
        { sceneId: 1, startSeconds: 0, timeFormatted: '00:00', title: 'Kenapa Waktu Terasa Berbeda?' },
        { sceneId: 3, startSeconds: 8, timeFormatted: '00:08', title: 'Cara Otak Merekam Memori Baru' },
        { sceneId: 6, startSeconds: 20, timeFormatted: '00:20', title: 'Jebakan Mode Autopilot Rutinitas' },
        { sceneId: 9, startSeconds: 32, timeFormatted: '00:32', title: 'Mengenal Fenomena Holiday Paradox' },
        { sceneId: 12, startSeconds: 44, timeFormatted: '00:44', title: 'Cara Memperlambat Persepsi Waktu' },
        { sceneId: 14, startSeconds: 52, timeFormatted: '00:52', title: 'Refleksi dan Langkah Pertamamu' },
      ],
      tags: [
        'kenapa waktu terasa cepat',
        'holiday paradox',
        'sains populer indonesia',
        'cara kerja otak',
        'video edukasi stickman',
        'psikologi waktu',
        'memori otak manusia',
        'animasi edukasi',
      ],
      hashtags: ['#SainsPopuler', '#EdukasiIndonesia', '#HolidayParadox', '#CaraKerjaOtak', '#StickmanEdukasi'],
      pinnedComment:
        'Menurutmu, momen apa tahun ini yang terasa paling lama dan paling berkesan? Tulis di komentar ya, yuk kita diskusi bareng!',
    },
  };
}
