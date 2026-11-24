import { MANDATORY_PROMPT_SUFFIX, type ChapterItem, type SceneItem } from '../types/project';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export const MIN_CLIP_DURATION = 1.0;

/**
 * Adjusts the cut boundary between scene[leftIndex] and scene[leftIndex + 1].
 * Left clip expands/shrinks while right clip compensates identically so total duration never changes.
 * Enforces minimum 1.0 second duration on both adjacent clips.
 */
export function adjustCutBoundary(
  scenes: SceneItem[],
  leftIndex: number,
  newBoundaryTime: number,
  minClipDuration = MIN_CLIP_DURATION
): SceneItem[] {
  if (leftIndex < 0 || leftIndex >= scenes.length - 1) {
    return scenes;
  }

  const left = scenes[leftIndex];
  const right = scenes[leftIndex + 1];

  const minAllowed = round2(left.start + minClipDuration);
  const maxAllowed = round2(right.end - minClipDuration);

  if (minAllowed > maxAllowed) {
    return scenes;
  }

  const clamped = round2(Math.max(minAllowed, Math.min(maxAllowed, newBoundaryTime)));
  if (clamped === left.end && clamped === right.start) {
    return scenes;
  }

  return scenes.map((scene, idx) => {
    if (idx === leftIndex) {
      return { ...scene, end: clamped };
    }
    if (idx === leftIndex + 1) {
      return { ...scene, start: clamped };
    }
    return scene;
  });
}

/**
 * Nudges the cut boundary after `leftIndex` by `deltaSeconds` (e.g. -0.3, -0.1, +0.1, +0.3).
 */
export function nudgeCutBoundary(
  scenes: SceneItem[],
  leftIndex: number,
  deltaSeconds: number
): SceneItem[] {
  if (leftIndex < 0 || leftIndex >= scenes.length - 1) {
    return scenes;
  }
  const currentBoundary = scenes[leftIndex].end;
  return adjustCutBoundary(scenes, leftIndex, round2(currentBoundary + deltaSeconds));
}

/**
 * Natural numeric filename comparator (so scene_2.png comes before scene_10.png).
 */
export function compareNaturalFileName(a: string, b: string): number {
  return a.localeCompare(b, 'id', { numeric: true, sensitivity: 'base' });
}

/**
 * Formats seconds to mm:ss (or hh:mm:ss if >= 1 hour).
 */
export function formatTimeMMSS(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (hrs > 0) {
    return `${hrs}:${pad(mins)}:${pad(secs)}`;
  }
  return `${pad(mins)}:${pad(secs)}`;
}

/**
 * Formats seconds with 1 decimal for timeline / table display (e.g. 01:04.2).
 */
export function formatTimePrecise(seconds: number): string {
  const safe = Math.max(0, seconds);
  const mins = Math.floor(safe / 60);
  const secs = (safe % 60).toFixed(1).padStart(4, '0');
  return `${String(mins).padStart(2, '0')}:${secs}`;
}

/**
 * Formats AI-selected chapter picks using real Kotak 3 scene timestamps.
 * Guarantees first chapter is always 00:00 and chapters are sorted chronologically without duplicates.
 */
export function buildChaptersFromScenes(
  picks: Array<{ sceneId: number; title: string }>,
  scenes: SceneItem[]
): ChapterItem[] {
  if (scenes.length === 0) {
    return [];
  }

  const sceneMap = new Map<number, SceneItem>();
  for (const s of scenes) {
    sceneMap.set(s.id, s);
  }

  const validPicks: ChapterItem[] = [];
  const seenIds = new Set<number>();

  for (const pick of picks) {
    const scene = sceneMap.get(pick.sceneId);
    if (!scene || seenIds.has(scene.id)) continue;
    seenIds.add(scene.id);
    validPicks.push({
      sceneId: scene.id,
      startSeconds: scene.start,
      timeFormatted: formatTimeMMSS(scene.start),
      title: pick.title.trim() || `Bab ${validPicks.length + 1}`,
    });
  }

  validPicks.sort((a, b) => a.startSeconds - b.startSeconds);

  // Guarantee first chapter starts at 00:00 (scene 1)
  if (validPicks.length === 0) {
    return [
      {
        sceneId: scenes[0].id,
        startSeconds: 0,
        timeFormatted: '00:00',
        title: 'Pembukaan',
      },
    ];
  }

  if (validPicks[0].startSeconds > 0) {
    validPicks.unshift({
      sceneId: scenes[0].id,
      startSeconds: 0,
      timeFormatted: '00:00',
      title: 'Pembukaan',
    });
  } else {
    validPicks[0] = {
      ...validPicks[0],
      startSeconds: 0,
      timeFormatted: '00:00',
    };
  }

  return validPicks;
}

const CROWD_KEYWORDS =
  /\b(banyak orang|kerumunan|masyarakat|penonton|warga|orang-orang|khalayak|massa|ribuan|jutaan|publik|populasi|penduduk|orang banyak|crowd|people|audience|society)\b/i;

export function detectCrowdInText(text: string): boolean {
  return CROWD_KEYWORDS.test(text);
}

/**
 * Assembles the final structured image prompt for a scene with locked [STYLE], [CHARACTER],
 * conditional [CROWD], [SCENE], and mandatory clean-artwork suffix.
 */
export function assembleScenePrompt(params: {
  stylePrompt: string;
  characterPrompt: string;
  crowdPrompt: string;
  scenePrompt: string;
  narrationText: string;
  hasCrowd?: boolean;
}): string {
  const includeCrowd = Boolean(params.hasCrowd) || detectCrowdInText(params.narrationText);
  const cleanScene = params.scenePrompt
    .trim()
    .replace(/Clean artwork, strictly no text, no numbers, no UI\.?/gi, '')
    .trim();

  const lines: string[] = [
    `[STYLE] ${params.stylePrompt.trim()}`,
    `[CHARACTER] ${params.characterPrompt.trim()}`,
  ];

  if (includeCrowd && params.crowdPrompt.trim()) {
    lines.push(`[CROWD] ${params.crowdPrompt.trim()}`);
  }

  const finalScene = cleanScene
    ? `${cleanScene.replace(/[.]+$/, '')}. ${MANDATORY_PROMPT_SUFFIX}`
    : MANDATORY_PROMPT_SUFFIX;

  lines.push(`[SCENE] ${finalScene}`);
  return lines.join('\n');
}

export function formatSceneCode(sceneNumber: number): string {
  return `scene_${String(sceneNumber).padStart(3, '0')}`;
}

export function findSceneAtTime(scenes: SceneItem[], time: number): { scene: SceneItem | null; index: number } {
  if (scenes.length === 0) return { scene: null, index: -1 };
  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    if (time >= s.start && (time < s.end || i === scenes.length - 1)) {
      return { scene: s, index: i };
    }
  }
  return { scene: scenes[0], index: 0 };
}

/**
 * Extracts an explicit 1-based scene number from a filename if present and within [1..maxSceneCount].
 * Supports patterns like "scene_005.png", "05 - intro.jpg", "adegan-12.webp", "5.png", "prompt 3.jpg".
 * Ignores 8+ digit timestamps/hashes (e.g. "20261119_102233.png").
 */
export function extractSceneNumberFromFileName(
  fileName: string,
  maxSceneCount = 9999
): number | null {
  if (!fileName || maxSceneCount <= 0) return null;
  const base = fileName.replace(/\.[^.]+$/, '').trim();

  // Priority 1: Explicit keyword prefix (scene_005, adegan 5, prompt-5, #5)
  const explicitMatch = base.match(
    /(?:^|[\s_-])(?:scene|adegan|prompt|nomor|no|beat|klip|clip|#)\s*[_#-]*0*(\d{1,4})(?:$|[\s_.-])/i
  );
  if (explicitMatch) {
    const num = Number(explicitMatch[1]);
    if (num >= 1 && num <= maxSceneCount) return num;
  }

  // Priority 2: Filename is purely a number or starts with a leading number (e.g. "005", "5 - ...", "05_...")
  const leadingMatch = base.match(/^0*(\d{1,4})(?:$|[\s_.-])/);
  if (leadingMatch) {
    const num = Number(leadingMatch[1]);
    if (num >= 1 && num <= maxSceneCount) return num;
  }

  return null;
}

/**
 * Assigns newly uploaded images to scenes without desynchronizing or overwriting existing scenes:
 * 1. In 'name' mode, if a file has an explicit scene number (e.g. scene_012.png or 12.png) that is unique
 *    within the uploaded batch, it maps directly to that scene ID.
 * 2. Remaining images fill currently empty scenes (!scene.imageId) in sequential order so batch uploads
 *    (e.g. uploading 1-24 then 25-48, or uploading one by one) never overwrite Scene #1.
 * 3. If all scenes already have images, remaining images overwrite sequentially from Scene #1.
 */
export function assignUploadedImagesToScenes(
  scenes: SceneItem[],
  uploadedImages: Array<{ id: string; fileName: string; lastModified: number }>,
  mode: 'name' | 'time'
): SceneItem[] {
  if (scenes.length === 0 || uploadedImages.length === 0) return scenes;

  const sorted = uploadedImages.slice();
  if (mode === 'name') {
    sorted.sort((a, b) => compareNaturalFileName(a.fileName, b.fileName));
  } else {
    sorted.sort((a, b) => a.lastModified - b.lastModified);
  }

  const nextScenes = scenes.map((s) => ({ ...s }));
  const sceneIndexById = new Map<number, number>();
  nextScenes.forEach((s, idx) => sceneIndexById.set(s.id, idx));

  const remainingImages: Array<{ id: string; fileName: string; lastModified: number }> = [];
  const claimedSceneIds = new Set<number>();

  if (mode === 'name') {
    // Check explicit scene numbers first
    const candidateNums = sorted.map((img) =>
      extractSceneNumberFromFileName(img.fileName, nextScenes.length)
    );
    const numCounts = new Map<number, number>();
    for (const n of candidateNums) {
      if (n !== null) numCounts.set(n, (numCounts.get(n) || 0) + 1);
    }

    for (let i = 0; i < sorted.length; i++) {
      const n = candidateNums[i];
      // Only direct-map if the extracted scene number is unambiguous (appears once in this batch)
      if (n !== null && numCounts.get(n) === 1 && sceneIndexById.has(n)) {
        const targetIdx = sceneIndexById.get(n)!;
        nextScenes[targetIdx].imageId = sorted[i].id;
        claimedSceneIds.add(n);
      } else {
        remainingImages.push(sorted[i]);
      }
    }
  } else {
    remainingImages.push(...sorted);
  }

  if (remainingImages.length > 0) {
    // Find scenes that are currently empty and weren't just claimed
    const emptyIndices: number[] = [];
    nextScenes.forEach((s, idx) => {
      if (!s.imageId && !claimedSceneIds.has(s.id)) {
        emptyIndices.push(idx);
      }
    });

    if (emptyIndices.length > 0) {
      for (let i = 0; i < remainingImages.length && i < emptyIndices.length; i++) {
        nextScenes[emptyIndices[i]].imageId = remainingImages[i].id;
      }
    } else {
      // All scenes already had images: replace sequentially from start (skipping explicitly claimed scenes)
      let imgCursor = 0;
      for (let idx = 0; idx < nextScenes.length && imgCursor < remainingImages.length; idx++) {
        if (claimedSceneIds.has(nextScenes[idx].id)) continue;
        nextScenes[idx].imageId = remainingImages[imgCursor++].id;
      }
    }
  }

  return nextScenes;
}

