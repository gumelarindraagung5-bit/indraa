import type { SceneItem } from '../types/project';
import {
  snapExistingScenesToAudioPauses,
  type AudioWaveformData,
} from './scriptTimestampAligner';

export interface RawSceneInput {
  id?: number;
  start: number;
  end: number;
  text: string;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Splits a text string into `parts` natural chunks near punctuation or word boundaries.
 */
function splitTextIntoParts(text: string, parts: number): string[] {
  const clean = text.trim().replace(/\s+/g, ' ');
  if (parts <= 1 || !clean) {
    return [clean];
  }

  const words = clean.split(' ');
  if (words.length <= parts) {
    // Not enough words to split evenly; return as many non-empty parts as possible
    const out: string[] = [];
    for (let i = 0; i < parts; i++) {
      out.push(words[i] ?? '');
    }
    return out;
  }

  const result: string[] = [];
  let remaining = words.slice();
  for (let p = parts; p > 1; p--) {
    const idealCount = Math.max(1, Math.round(remaining.length / p));
    // Look within +/- 3 words for a natural break (., !, ?, ,, ;)
    let splitIdx = idealCount;
    let bestScore = -1;
    const minIdx = Math.max(1, idealCount - 3);
    const maxIdx = Math.min(remaining.length - (p - 1), idealCount + 3);

    for (let i = minIdx; i <= maxIdx; i++) {
      const w = remaining[i - 1];
      let score = 0;
      if (/[.!?]["'”’)]*$/.test(w)) score = 3;
      else if (/[,;:—–]["'”’)]*$/.test(w)) score = 2;
      else if (i === idealCount) score = 1;
      if (score > bestScore) {
        bestScore = score;
        splitIdx = i;
      }
    }

    result.push(remaining.slice(0, splitIdx).join(' '));
    remaining = remaining.slice(splitIdx);
  }
  result.push(remaining.join(' '));
  return result;
}

export interface SceneValidationOptions {
  /**
   * When true, preserves natural non-rigid pacing around minDuration..maxDuration
   * (allows short visual beats down to minDuration - 1.2s and flowing sentences up to maxDuration + 2.0s)
   * instead of mechanically chopping/merging every scene to rigid bounds.
   */
  flexible?: boolean;
  /**
   * Optional decoded audio waveform; when provided, internal scene cut boundaries
   * are snapped to the nearest real acoustic silence/breath pauses in the audio.
   */
  audioWaveform?: AudioWaveformData | null;
}

/**
 * Post-AI deterministic scene validator:
 * 1. Sort by start time
 * 2. First scene starts at 0, close all gaps/overlaps
 * 3. Last scene ends exactly at audioDuration
 * 4. Merge scenes shorter than effective minimum duration
 * 5. Split scenes longer than effective maximum duration at natural punctuation boundaries
 * 6. Snap cut boundaries to real acoustic silence pauses if waveform is provided
 * 7. Re-number sequentially from 1..N with guaranteed continuity
 */
export function validateAndNormalizeScenes(
  rawScenes: RawSceneInput[],
  audioDuration: number,
  minDuration: number,
  maxDuration: number,
  options?: SceneValidationOptions
): SceneItem[] {
  const safeDuration = Math.max(0.5, round2(audioDuration));
  const baseMin = Math.max(1, Math.min(minDuration, safeDuration));
  const baseMax = Math.max(baseMin, maxDuration);
  const flexible = Boolean(options?.flexible);

  // In flexible mode, respect natural sentence/visual beats around 3-6s instead of rigid mechanical cuts
  const safeMin = flexible ? Math.max(1.5, round2(baseMin - 1.2)) : baseMin;
  const safeMax = flexible ? round2(baseMax + 2.0) : baseMax;

  // Filter out invalid entries & sort by start time
  const sorted = rawScenes
    .filter((s) => s && typeof s.start === 'number' && typeof s.end === 'number' && !Number.isNaN(s.start))
    .map((s) => ({
      start: Math.max(0, Math.min(safeDuration, s.start)),
      end: Math.max(0, Math.min(safeDuration, s.end)),
      text: (s.text || '').trim(),
    }))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  if (sorted.length === 0) {
    return [
      {
        id: 1,
        start: 0,
        end: safeDuration,
        text: '',
      },
    ];
  }

  // Step 1: Close gaps & fix overlaps, anchor start=0 and end=safeDuration
  const normalized: Array<{ start: number; end: number; text: string }> = [];
  for (let i = 0; i < sorted.length; i++) {
    const curr = sorted[i];
    const start = i === 0 ? 0 : normalized[i - 1].end;
    let end = i === sorted.length - 1 ? safeDuration : curr.end;

    if (end <= start) {
      const nextStart = i < sorted.length - 1 ? sorted[i + 1].start : safeDuration;
      end = nextStart > start ? Math.min(safeDuration, nextStart) : Math.min(safeDuration, start + 0.5);
    }

    if (i < sorted.length - 1 && sorted[i + 1].start > end) {
      const midpoint = round2((end + sorted[i + 1].start) / 2);
      end = Math.min(safeDuration, midpoint);
    }

    normalized.push({
      start: round2(start),
      end: round2(end),
      text: curr.text,
    });
  }

  normalized[0].start = 0;
  normalized[normalized.length - 1].end = safeDuration;

  // Step 2: Merge scenes shorter than safeMin (only if > 1 scene exists)
  let merged = normalized.slice();
  let changed = true;
  let guard = 0;
  while (changed && merged.length > 1 && guard < 50000) {
    changed = false;
    guard++;
    for (let i = 0; i < merged.length; i++) {
      const dur = round2(merged[i].end - merged[i].start);
      if (dur < safeMin - 0.001) {
        if (i === 0) {
          merged[1] = {
            start: merged[0].start,
            end: merged[1].end,
            text: [merged[0].text, merged[1].text].filter(Boolean).join(' ').trim(),
          };
          merged.splice(0, 1);
        } else if (i === merged.length - 1) {
          merged[i - 1] = {
            start: merged[i - 1].start,
            end: merged[i].end,
            text: [merged[i - 1].text, merged[i].text].filter(Boolean).join(' ').trim(),
          };
          merged.splice(i, 1);
        } else {
          const prevDur = merged[i - 1].end - merged[i - 1].start;
          const nextDur = merged[i + 1].end - merged[i + 1].start;
          if (prevDur <= nextDur) {
            merged[i - 1] = {
              start: merged[i - 1].start,
              end: merged[i].end,
              text: [merged[i - 1].text, merged[i].text].filter(Boolean).join(' ').trim(),
            };
            merged.splice(i, 1);
          } else {
            merged[i + 1] = {
              start: merged[i].start,
              end: merged[i + 1].end,
              text: [merged[i].text, merged[i + 1].text].filter(Boolean).join(' ').trim(),
            };
            merged.splice(i, 1);
          }
        }
        changed = true;
        break;
      }
    }
  }

  // Step 3: Split scenes longer than safeMax
  const splitResult: Array<{ start: number; end: number; text: string }> = [];
  for (const item of merged) {
    const dur = round2(item.end - item.start);
    if (dur <= safeMax + 0.001) {
      splitResult.push(item);
      continue;
    }

    const numParts = Math.max(2, Math.ceil(dur / safeMax));
    const textParts = splitTextIntoParts(item.text, numParts);
    const totalChars = textParts.reduce((acc, t) => acc + Math.max(1, t.length), 0);
    let cursor = item.start;

    for (let p = 0; p < numParts; p++) {
      const isLast = p === numParts - 1;
      const weight = Math.max(1, textParts[p].length) / totalChars;
      const idealPartDur = dur * weight;
      const uniformDur = dur / numParts;
      const blendedDur = round2(idealPartDur * 0.55 + uniformDur * 0.45);
      const nextEnd = isLast ? item.end : round2(Math.min(item.end - 0.1, cursor + blendedDur));

      splitResult.push({
        start: round2(cursor),
        end: nextEnd,
        text: textParts[p].trim(),
      });
      cursor = nextEnd;
    }
  }

  // Step 4: Final continuity pass & sequential numbering
  const finalScenes: SceneItem[] = splitResult.map((s, idx) => ({
    id: idx + 1,
    start: idx === 0 ? 0 : round2(splitResult[idx - 1].end),
    end: idx === splitResult.length - 1 ? safeDuration : round2(s.end),
    text: s.text,
  }));

  if (options?.audioWaveform) {
    return snapExistingScenesToAudioPauses(finalScenes, options.audioWaveform, safeDuration);
  }

  return finalScenes;
}

export function getSceneSummaryStats(scenes: SceneItem[]): {
  count: number;
  averageDuration: number;
  totalDuration: number;
} {
  if (scenes.length === 0) {
    return { count: 0, averageDuration: 0, totalDuration: 0 };
  }
  const totalDuration = scenes.reduce((sum, s) => sum + Math.max(0, s.end - s.start), 0);
  return {
    count: scenes.length,
    averageDuration: Math.round((totalDuration / scenes.length) * 10) / 10,
    totalDuration: Math.round(totalDuration * 100) / 100,
  };
}
