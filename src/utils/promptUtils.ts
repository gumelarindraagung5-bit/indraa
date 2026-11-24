import { MANDATORY_PROMPT_SUFFIX, type SceneItem } from '../types/project';
import { detectCrowdInText, formatSceneCode } from './timelineMath';

export type PromptCopyFormat = 'numbered-paragraph' | 'plain-single-line';

export interface PromptAssemblyConfig {
  stylePrompt: string;
  characterPrompt: string;
  crowdPrompt: string;
}

export interface NormalizedAiPromptItem {
  id: number;
  scene: string;
  shotType?: string;
}

function parseNumericSceneId(rawId: unknown): number | null {
  if (typeof rawId === 'number' && Number.isFinite(rawId)) return Math.trunc(rawId);
  if (typeof rawId === 'string') {
    const match = rawId.match(/\d+/);
    if (match) {
      const parsed = Number(match[0]);
      if (Number.isFinite(parsed)) return Math.trunc(parsed);
    }
  }
  return null;
}

function extractRawPromptEntry(entry: unknown): NormalizedAiPromptItem | null {
  if (!entry || typeof entry !== 'object') return null;
  const obj = entry as Record<string, unknown>;
  const id = parseNumericSceneId(obj.id ?? obj.sceneId ?? obj.scene_id);
  const rawText = obj.scene ?? obj.scenePrompt ?? obj.prompt ?? obj.description;
  const scene = typeof rawText === 'string' ? rawText.trim() : '';
  const shotType = typeof obj.shotType === 'string' ? obj.shotType.trim() : undefined;
  if (id === null || scene.length < 6) return null;
  return { id, scene, ...(shotType ? { shotType } : {}) };
}

/**
 * Salvages complete JSON objects from a partially truncated JSON array string
 * (e.g., when a model hits token limits near the end of a large batch).
 */
function salvageJsonObjects(raw: string): unknown[] {
  const objects: unknown[] = [];
  let inString = false;
  let escape = false;
  let depth = 0;
  let startIdx = -1;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) startIdx = i;
      depth++;
    } else if (ch === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && startIdx !== -1) {
          const slice = raw.slice(startIdx, i + 1);
          try {
            objects.push(JSON.parse(slice));
          } catch {
            // Skip malformed fragment
          }
          startIdx = -1;
        }
      }
    }
  }

  return objects;
}

/**
 * Parses Gemini's JSON prompt batch response cleanly, handling markdown fences,
 * wrapped { prompts: [...] } shapes, string IDs ("1", "scene_001"), and truncated JSON arrays.
 */
export function parseAndNormalizePromptItems(rawText: string | undefined): NormalizedAiPromptItem[] {
  if (!rawText || !rawText.trim()) return [];
  const cleaned = rawText
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  let rawList: unknown[] = [];
  try {
    const parsed = JSON.parse(cleaned) as unknown;
    if (Array.isArray(parsed)) {
      rawList = parsed;
    } else if (parsed && typeof parsed === 'object') {
      const rec = parsed as Record<string, unknown>;
      const nested = rec.prompts ?? rec.scenes ?? rec.items ?? rec.data;
      if (Array.isArray(nested)) {
        rawList = nested;
      }
    }
  } catch {
    rawList = salvageJsonObjects(cleaned);
  }

  const results: NormalizedAiPromptItem[] = [];
  const seen = new Set<number>();
  for (const item of rawList) {
    const norm = extractRawPromptEntry(item);
    if (norm && !seen.has(norm.id)) {
      seen.add(norm.id);
      results.push(norm);
    }
  }
  return results;
}

/**
 * Checks which requested scene IDs are missing or have blank scene descriptions in an AI batch response.
 */
export function findMissingPromptIds(
  requestedIds: number[],
  returned: Array<{ id?: number | string; scene?: string; scenePrompt?: string }>
): number[] {
  const validIds = new Set<number>();
  for (const item of returned) {
    const text = (item.scene ?? item.scenePrompt ?? '').trim();
    const numId = parseNumericSceneId(item.id);
    if (numId !== null && text.length >= 6) {
      validIds.add(numId);
    }
  }
  return requestedIds.filter((id) => !validIds.has(id));
}

/**
 * Assembles the final structured prompt for a single scene from locked [STYLE], [CHARACTER],
 * conditional [CROWD] (strictly when narration mentions many people), and [SCENE].
 * Returns a clean single-paragraph string without internal blank lines so it fits both copy formats cleanly.
 */
export function buildFinalSingleLinePrompt(
  scene: SceneItem,
  config: PromptAssemblyConfig
): string {
  const includeCrowd = detectCrowdInText(scene.text || '');
  const rawScene = (scene.scenePrompt || '')
    .replace(/\s+/g, ' ')
    .replace(/Clean artwork, strictly no text, no numbers, no UI\.?/gi, '')
    .trim();

  const styleClean = (config.stylePrompt || '').replace(/\s+/g, ' ').trim();
  const charClean = (config.characterPrompt || '').replace(/\s+/g, ' ').trim();
  const crowdClean = (config.crowdPrompt || '').replace(/\s+/g, ' ').trim();

  const parts: string[] = [
    `[STYLE] ${styleClean}`,
    `[CHARACTER] ${charClean}`,
  ];

  if (includeCrowd && crowdClean) {
    parts.push(`[CROWD] ${crowdClean}`);
  }

  const finalScene = rawScene
    ? `${rawScene.replace(/[.]+$/, '')}. ${MANDATORY_PROMPT_SUFFIX}`
    : MANDATORY_PROMPT_SUFFIX;

  parts.push(`[SCENE] ${finalScene}`);
  return parts.join(' ');
}

/**
 * Formats a list of scenes into the user-selected copy / .txt download format:
 * - 'numbered-paragraph': numbered (scene_001 ...), one prompt per paragraph separated by blank lines
 * - 'plain-single-line': unnumbered, strictly one prompt per line
 */
export function formatPromptsForCopy(
  scenes: SceneItem[],
  config: PromptAssemblyConfig,
  format: PromptCopyFormat,
  batchHeader?: string
): string {
  if (scenes.length === 0) return '';

  const formattedItems = scenes.map((scene) => {
    const body = buildFinalSingleLinePrompt(scene, config);
    if (format === 'numbered-paragraph') {
      return `${formatSceneCode(scene.id)}: ${body}`;
    }
    return body;
  });

  const joined =
    format === 'numbered-paragraph'
      ? formattedItems.join('\n\n')
      : formattedItems.join('\n');

  const trimmedHeader = batchHeader?.trim();
  if (trimmedHeader) {
    return format === 'numbered-paragraph'
      ? `${trimmedHeader}\n\n${joined}`
      : `${trimmedHeader}\n${joined}`;
  }
  return joined;
}

/**
 * Slices scenes by 1-based inclusive range [fromScene, toScene].
 */
export function sliceScenesByRange(
  scenes: SceneItem[],
  fromScene: number,
  toScene: number
): SceneItem[] {
  if (scenes.length === 0) return [];
  const start = Math.max(1, Math.min(scenes.length, Math.floor(fromScene) || 1));
  const end = Math.max(start, Math.min(scenes.length, Math.floor(toScene) || start));
  return scenes.slice(start - 1, end);
}

/**
 * Splits scene list into first half and second half cleanly.
 */
export function splitScenesInHalf(scenes: SceneItem[]): {
  firstHalf: SceneItem[];
  secondHalf: SceneItem[];
} {
  const mid = Math.ceil(scenes.length / 2);
  return {
    firstHalf: scenes.slice(0, mid),
    secondHalf: scenes.slice(mid),
  };
}

export type PromptGenerateScope = 'first-50' | 'all';

/**
 * Selects target scene IDs for Kotak 4 generation modes:
 * - 'first-50': scenes 1..50 (or 1..N if total < 50)
 * - 'all': all scenes 1..N
 */
export function selectGenerateTargetIds(
  scenes: SceneItem[],
  scope: PromptGenerateScope
): number[] {
  if (scenes.length === 0) return [];
  if (scope === 'first-50') {
    return scenes.slice(0, 50).map((s) => s.id);
  }
  return scenes.map((s) => s.id);
}

