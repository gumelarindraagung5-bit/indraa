export type WizardStep = 1 | 2 | 3 | 4 | 5 | 6;

export type NarrationStyleId =
  | 'kok-bisa'
  | 'satu-persen'
  | 'dokumenter-misteri'
  | 'ngobrol-podcast'
  | 'custom';

export interface VideoIdeaSuggestion {
  idea: string;
  category: string;
  hook: string;
  viralScore: number;
}

export interface TitleSuggestion {
  title: string;
  score: number;
  reason: string;
}

export interface AudioMeta {
  fileName: string;
  fileSize: number;
  mimeType: string;
  duration: number;
  usesFilesApi: boolean;
}

export interface SceneItem {
  id: number;
  start: number;
  end: number;
  text: string;
  scenePrompt?: string;
  hasCrowd?: boolean;
  shotType?: string;
  imageId?: string | null;
}

export type VisualStyleId =
  | 'kok-bisa-watercolor'
  | 'satu-persen-editorial'
  | 'hybrid-2d-3d-ricks'
  | 'noir-psikologi'
  | 'claymation-diorama'
  | 'whiteboard-rough-sketch'
  | 'kurzgesagt-scifi'
  | 'vintage-blueprint';

export type SubtitleMode = 'off' | 'lines' | 'dynamic';
export type SubtitlePosition = 'bottom' | 'middle' | 'top';

export interface SubtitleSettings {
  mode: SubtitleMode;
  fontSize: number; // px at 720p reference (e.g. 28 - 48)
  position: SubtitlePosition;
  textColor: string;
  highlightColor: string;
}

export interface VideoExportSettings {
  resolution: '720p' | '1080p';
  fps: 30;
  kenBurns: boolean;
  crossfade: boolean;
}

export interface ThumbnailPromptItem {
  concept: string;
  overlayText: string;
  prompt: string;
}

export interface TitleVariantItem {
  title: string;
  ctrReason: string;
}

export interface ChapterItem {
  sceneId: number;
  timeFormatted: string;
  startSeconds: number;
  title: string;
}

export interface YouTubePackage {
  thumbnailPrompts: ThumbnailPromptItem[];
  titleVariants: TitleVariantItem[];
  description: string;
  chapters: ChapterItem[];
  tags: string[];
  hashtags: string[];
  pinnedComment: string;
}

export interface ImageRecordMeta {
  id: string;
  fileName: string;
  lastModified: number;
  fileSize: number;
  mimeType: string;
  width: number;
  height: number;
}

export interface StudioProject {
  version: number;
  updatedAt: number;
  activeStep: WizardStep;
  // Kotak 1
  topic: string;
  ideaSuggestions: VideoIdeaSuggestion[];
  titleSuggestions: TitleSuggestion[];
  selectedTitle: string;
  narrationStyle: NarrationStyleId;
  customStyleInstruction: string;
  targetDurationMinutes: number;
  targetWordCount: number;
  script: string;
  // Kotak 2
  audioMeta: AudioMeta | null;
  referenceScript: string;
  // Kotak 3
  minSceneSec: number;
  maxSceneSec: number;
  scenes: SceneItem[];
  // Kotak 4
  visualStyle: VisualStyleId;
  stylePrompt: string;
  characterPrompt: string;
  crowdPrompt: string;
  batchHeader: string;
  // Kotak 5
  imagesMeta: ImageRecordMeta[];
  subtitleSettings: SubtitleSettings;
  videoSettings: VideoExportSettings;
  // Kotak 6
  youtubePackage: YouTubePackage | null;
}

export interface NarrationStyleOption {
  id: NarrationStyleId;
  label: string;
  summary: string;
  aiDescription: string;
  voiceInstruction: string;
}

export const NARRATION_STYLES: NarrationStyleOption[] = [
  {
    id: 'kok-bisa',
    label: 'Kok Bisa',
    summary: 'Pertanyaan pemantik, ramah, penuh rasa ingin tahu',
    aiDescription:
      'Gaya Kok Bisa: dibuka dengan pertanyaan pemantik yang bikin penasaran, ramah, antusias, penuh rasa ingin tahu, penjelasan ilmiah ringan dengan analogi konkret.',
    voiceInstruction:
      'Gaya suara narator edukasi ramah dan antusias seperti Kok Bisa. Tempo bicara sedang-cepat (±170 kata/menit), artikulasi jernih, intonasi naik saat bertanya, jeda singkat penuh penasaran sebelum mengungkap fakta penting. Hindari nada kaku seperti berita TV.',
  },
  {
    id: 'satu-persen',
    label: 'Satu Persen',
    summary: 'Santai, analogi sehari-hari, insight mendalam',
    aiDescription:
      'Gaya Satu Persen: santai seperti teman pintar yang diajak ngobrol, penuh empati, pakai analogi kehidupan sehari-hari anak muda, reflektif, dan memberikan insight psikologis/pengembangan diri yang mendalam.',
    voiceInstruction:
      'Gaya suara hangat, tenang, dan relatable seperti narator Satu Persen. Tempo santai namun terarah (±155-165 kata/menit), penekanan lembut pada poin refleksi, seolah sedang berbincang empat mata dengan penonton.',
  },
  {
    id: 'dokumenter-misteri',
    label: 'Dokumenter Misteri',
    summary: 'Atmosferik, investigatif, penuh teka-teki',
    aiDescription:
      'Gaya Dokumenter Misteri: narasi investigatif yang membangun ketegangan perlahan, membuka petunjuk demi petunjuk, dramatis namun tetap berbasis fakta.',
    voiceInstruction:
      'Gaya suara berat, tenang, dan misterius ala dokumenter investigasi. Tempo sedikit lebih lambat (±145-155 kata/menit), berikan jeda dramatis 0,5-1 detik sebelum kalimat plot twist atau pengungkapan bukti.',
  },
  {
    id: 'ngobrol-podcast',
    label: 'Ngobrol Podcast',
    summary: 'Akrab, dialogis, mengalir santai',
    aiDescription:
      'Gaya Ngobrol Podcast: sangat akrab, mengalir seperti curhat atau diskusi cerdas bareng teman, pakai bahasa lisan sehari-hari yang tetap sopan dan tertata.',
    voiceInstruction:
      'Gaya suara kasual dan akrab seperti host podcast favorit. Dinamika suara ekspresif, natural, sesekali terdengar tersenyum saat bercerita, ritme luwes seperti ngobrol langsung tanpa membaca teks.',
  },
  {
    id: 'custom',
    label: 'Custom',
    summary: 'Tentukan sendiri karakter dan instruksi narasi',
    aiDescription: 'Gaya narasi kustom sesuai arahan pengguna.',
    voiceInstruction:
      'Sesuaikan gaya suara dengan arahan custom naskah Anda. Jaga artikulasi tetap jernih, tempo konsisten sekitar 160-170 kata per menit, dan berikan penekanan pada kalimat hook pembuka.',
  },
];

export interface VisualStylePreset {
  id: VisualStyleId;
  label: string;
  summary: string;
  stylePrompt: string;
  characterPrompt: string;
  crowdPrompt: string;
}

export const VISUAL_STYLE_PRESETS: VisualStylePreset[] = [
  {
    id: 'kok-bisa-watercolor',
    label: 'Stickman Kok Bisa (Watercolor)',
    summary: 'Tinta hitam halus, sapuan cat air hangat, tunik biru slate',
    stylePrompt:
      'Full-frame 2D hand-drawn ink and watercolor storybook illustration, fine black ink outlines, warm atmospheric watercolor washes, cozy golden lighting.',
    characterPrompt:
      '2D minimalist stickman (Kok Bisa style, not realistic, not anime): oversized bald smooth cream-white circle head with thick black outline, ONLY two small vertical black dot eyes and simple line mouth, no hair/nose/ears, narrow trapezoid slate-blue tunic (#5B9BD5), thin black stick-figure arms and legs.',
    crowdPrompt:
      'Background crowd of similar minimalist 2D stickman figures with cream-white round heads, tiny dot eyes, and muted pastel trapezoid tunics (soft ochre, sage green, dusty coral, slate gray) drawn with fine black ink outlines.',
  },
  {
    id: 'satu-persen-editorial',
    label: 'Satu Persen Editorial (Vektor)',
    summary: 'Ilustrasi vektor 2D modern, garis tegas, palet editorial rapi',
    stylePrompt:
      'Full-frame flat 2D modern editorial vector illustration, clean crisp geometric shapes, muted deep teal and warm cream palette, subtle matte paper texture, minimalist balanced composition.',
    characterPrompt:
      '2D minimalist editorial stickman (Satu Persen style, clean flat vector): smooth round off-white circle head with crisp dark charcoal outline, simple two black dot eyes and expressive minimal line mouth, wearing a clean geometric mustard-amber sweater tunic (#E2A83B), slender dark charcoal stick limbs.',
    crowdPrompt:
      'Supporting crowd of flat 2D editorial minimalist stickman figures in muted navy, olive, and terracotta geometric tunics matching the clean vector aesthetic.',
  },
  {
    id: 'hybrid-2d-3d-ricks',
    label: 'Hybrid 2D in 3D World (Ricks Clips)',
    summary: 'Stickman 2D datar di dunia latar & properti 3D berdimensi',
    stylePrompt:
      'Flat 2D illustrated animation cels composited into a fully dimensional, shaded stylized 3D environment. Only the background, furniture, and props are rendered in textured 3D with perspective, directional studio lighting, soft depth of field, and realistic contact shadows. Characters remain completely flat 2D cutouts with zero 3D volume, zero shading, and zero gradients, though they may cast soft ground shadows onto the 3D floor. No anime, no photorealistic humans, no 3D-modeled characters, no text, no speech bubbles, no watermarks.',
    characterPrompt:
      'Flat 2D minimalist stickman character (strictly 2D cel, never 3D): solid pure-white circular face with thick consistent black outline, flat black oval eyes, separate floating graphic eyebrows, simple drawn expressive mouth, flat solid black messy hair, narrow flat-colored torso wearing a solid slate-blue t-shirt (#4A78B8) and dark charcoal pants (#2C2F36), extremely thin black line arms and legs, small flat rounded white hands, and minimal black feet. No spherical head, no sculpted cheeks, no cylindrical limbs, no skin texture, no clothing folds, no lighting highlights or shading on the character.',
    crowdPrompt:
      'Background crowd made of the same flat 2D minimalist stickman style with solid white circular faces, thick black outlines, thin black line limbs, and varied flat solid-colored shirts (muted grey, olive, mustard, burgundy), standing inside the shaded 3D environment with no shading on their bodies.',
  },
  {
    id: 'noir-psikologi',
    label: 'Noir Psikologi (Monochrome + Aksen)',
    summary: 'Tinta hitam-putih kontras tinggi + 1 aksen merah crimson',
    stylePrompt:
      'High-contrast graphic novel noir illustration, stark black and off-white ink drawing, gritty halftone paper grain texture, dramatic hard shadows, strictly monochrome palette with ONLY vibrant crimson red (#D92626) as a single accent color on key emotional objects. No full color, no 3D render, no text.',
    characterPrompt:
      '2D minimalist stickman in ink noir style: plain white circle head with rough ink outline, expressive minimalist dot eyes, hollow tired gaze, black line limbs, wearing a stark dark silhouette hoodie or coat with heavy black ink shadows.',
    crowdPrompt:
      'Background crowd of monochrome ink noir 2D minimalist stickman silhouettes with plain white circle heads, rough black ink outlines, dark shadow coats, and zero color.',
  },
  {
    id: 'claymation-diorama',
    label: 'Claymation / Miniature Diorama 3D',
    summary: 'Stop-motion tanah liat taktil, miniatur kardus & pencahayaan hangat',
    stylePrompt:
      'Handcrafted stop-motion claymation diorama photography, tactile polymer clay textures with subtle fingerprints, miniature cardboard and felt props, soft tilt-shift macro lens blur, warm cozy studio rim lighting, Pixar-meets-Aardman miniature feel. No smooth CGI plastic, no text.',
    characterPrompt:
      'Cute minimalist stickman sculpted from matte white polymer clay: round slightly imperfect clay head, tiny indented black bead eyes, thin bent black wire arms and legs, chunky matte navy clay sweater, tiny clay shoes.',
    crowdPrompt:
      'Background crowd of handcrafted miniature claymation stickman figures sculpted from matte white polymer clay with tiny black bead eyes, thin wire limbs, and chunky muted clay sweaters (mustard, olive, burgundy, slate grey).',
  },
  {
    id: 'whiteboard-rough-sketch',
    label: 'Whiteboard / Rough Sketch Komedi',
    summary: 'Sketsa spidol hitam kasar di kertas sketchbook ala Sam O\'Nella',
    stylePrompt:
      'Raw hand-drawn marker sketch on clean textured off-white sketchbook paper (#F7F5EE), deliberately imperfect wobbly black felt-tip lines, minimal flat highlighter color accents (pastel yellow and muted blue), clean negative space, deadpan internet comic aesthetic. No shading, no gradients, no 3D.',
    characterPrompt:
      'Expressive rough-sketched 2D stickman drawn with wobbly black marker: slightly uneven white circle head, deadpan dot eyes, exaggerated simple line mouth, stick limbs, wearing a hastily sketched flat-colored shirt.',
    crowdPrompt:
      'Background crowd of hastily sketched 2D stickman figures drawn with wobbly black felt-tip marker lines, uneven white circle heads, deadpan dot eyes, and minimal pastel highlighter shirt accents.',
  },
  {
    id: 'kurzgesagt-scifi',
    label: 'Kurzgesagt Geometric Sci-Fi',
    summary: 'Vektor geometris modern tanpa garis hitam, latar biru malam + glow',
    stylePrompt:
      'Modern flat geometric vector infographic illustration inspired by space science explainers, bold clean shapes with zero black outlines, rich deep midnight-navy backgrounds (#0F172A) contrasted with luminous cyan, coral, and amber soft glow accents, crisp layered depth. No sketch lines, no realism, no text.',
    characterPrompt:
      'Stylized lineless geometric minimalist character: smooth cream circular head with two simple dark oval eyes, rounded pill-shaped torso in vibrant teal (#14B8A6), simple rounded capsule limbs, clean flat vector color blocking with subtle rim glow.',
    crowdPrompt:
      'Background crowd of lineless geometric minimalist flat vector characters with smooth cream circular heads, dark oval eyes, and rounded pill-shaped torsos in coral, amber, cyan, and slate-blue flat color blocking.',
  },
  {
    id: 'vintage-blueprint',
    label: 'Vintage Blueprint / Chalkboard Teknis',
    summary: 'Cetak biru & papan tulis gelap, garis kapur putih-kuning teknis',
    stylePrompt:
      'Clean architectural cyan blueprint / dark slate chalkboard technical illustration (#102542 background), crisp fine white and pale-yellow chalk drafting lines, subtle grid markings and technical diagram callout arrows without readable words, moody matte texture. No photorealism, no clutter.',
    characterPrompt:
      'Minimalist chalk-drawn 2D stickman outlined in crisp white technical linework on dark slate background, simple round head, expressive white dot eyes, thin schematic line body with light yellow accent fill on the torso.',
    crowdPrompt:
      'Background crowd of minimalist chalk-drawn 2D stickman figures outlined in crisp white technical drafting lines on the dark blueprint background with subtle pale-yellow and cyan chalk accents.',
  },
];

export const MANDATORY_PROMPT_SUFFIX = 'Clean artwork, strictly no text, no numbers, no UI.';

export function createDefaultProject(): StudioProject {
  const kokBisaVisual = VISUAL_STYLE_PRESETS[0];
  return {
    version: 1,
    updatedAt: Date.now(),
    activeStep: 1,
    topic: '',
    ideaSuggestions: [],
    titleSuggestions: [],
    selectedTitle: '',
    narrationStyle: 'kok-bisa',
    customStyleInstruction: '',
    targetDurationMinutes: 8,
    targetWordCount: 8 * 170,
    script: '',
    audioMeta: null,
    referenceScript: '',
    minSceneSec: 3,
    maxSceneSec: 6,
    scenes: [],
    visualStyle: 'kok-bisa-watercolor',
    stylePrompt: kokBisaVisual.stylePrompt,
    characterPrompt: kokBisaVisual.characterPrompt,
    crowdPrompt: kokBisaVisual.crowdPrompt,
    batchHeader:
      'Buat gambar rasio 16:9 secara berurutan untuk setiap prompt di bawah ini. Pertahankan gaya dan karakter yang sama persis:',
    imagesMeta: [],
    subtitleSettings: {
      mode: 'lines',
      fontSize: 34,
      position: 'bottom',
      textColor: '#FFFFFF',
      highlightColor: '#F5C451',
    },
    videoSettings: {
      resolution: '720p',
      fps: 30,
      kenBurns: true,
      crossfade: true,
    },
    youtubePackage: null,
  };
}
