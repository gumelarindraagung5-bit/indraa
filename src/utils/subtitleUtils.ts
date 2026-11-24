import type { SceneItem } from '../types/project';

export interface TimedWord {
  word: string;
  start: number;
  end: number;
}

export interface SubtitleLineChunk {
  words: TimedWord[];
  text: string;
  start: number;
  end: number;
}

/**
 * Computes proportional start/end timestamps for each word within a scene's duration
 * based on word character length (minimum weight 2 chars so short words remain readable).
 */
export function computeProportionalWordTimings(
  text: string,
  sceneStart: number,
  sceneEnd: number
): TimedWord[] {
  const words = text
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0 || sceneEnd <= sceneStart) {
    return [];
  }

  const totalDuration = sceneEnd - sceneStart;
  const weights = words.map((w) => Math.max(2, w.replace(/[^a-zA-Z0-9À-ÿ]/g, '').length));
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  let cursor = sceneStart;
  return words.map((word, idx) => {
    const isLast = idx === words.length - 1;
    const dur = (weights[idx] / totalWeight) * totalDuration;
    const end = isLast ? sceneEnd : cursor + dur;
    const item: TimedWord = {
      word,
      start: cursor,
      end,
    };
    cursor = end;
    return item;
  });
}

/**
 * Groups timed words into lines of 3 to 6 words for clean YouTube subtitle readability.
 */
export function groupWordsIntoLines(words: TimedWord[], minWords = 3, maxWords = 6): SubtitleLineChunk[] {
  if (words.length === 0) return [];
  if (words.length <= maxWords) {
    return [
      {
        words,
        text: words.map((w) => w.word).join(' '),
        start: words[0].start,
        end: words[words.length - 1].end,
      },
    ];
  }

  const chunks: SubtitleLineChunk[] = [];
  let idx = 0;

  while (idx < words.length) {
    const remaining = words.length - idx;
    let take = Math.min(maxWords, remaining);

    // Avoid leaving a tiny orphan (1-2 words) on the last line
    if (remaining > maxWords && remaining - take < minWords) {
      take = Math.ceil(remaining / 2);
    }

    // Prefer breaking right after punctuation if within [minWords, take]
    if (remaining > maxWords) {
      for (let k = take; k >= minWords; k--) {
        if (/[.,!?;:]$/.test(words[idx + k - 1].word)) {
          take = k;
          break;
        }
      }
    }

    const slice = words.slice(idx, idx + take);
    chunks.push({
      words: slice,
      text: slice.map((w) => w.word).join(' '),
      start: slice[0].start,
      end: slice[slice.length - 1].end,
    });
    idx += take;
  }

  return chunks;
}

export function getActiveSubtitleAtTime(
  scene: SceneItem | undefined,
  currentTime: number
): { chunk: SubtitleLineChunk | null; activeWordIndex: number } {
  if (!scene || !scene.text.trim()) {
    return { chunk: null, activeWordIndex: -1 };
  }
  const timedWords = computeProportionalWordTimings(scene.text, scene.start, scene.end);
  const lines = groupWordsIntoLines(timedWords, 3, 6);
  const chunk =
    lines.find((line) => currentTime >= line.start - 0.01 && currentTime <= line.end + 0.01) ||
    lines[lines.length - 1] ||
    null;

  if (!chunk) {
    return { chunk: null, activeWordIndex: -1 };
  }

  let activeWordIndex = chunk.words.findIndex(
    (w) => currentTime >= w.start - 0.01 && currentTime <= w.end + 0.01
  );
  if (activeWordIndex === -1 && currentTime >= chunk.end) {
    activeWordIndex = chunk.words.length - 1;
  }
  return { chunk, activeWordIndex };
}

export function formatSrtTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const ms = Math.round((safe - Math.floor(safe)) * 1000);
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const pad3 = (n: number) => String(n).padStart(3, '0');
  if (ms === 1000) {
    return formatSrtTime(Math.floor(safe) + 1);
  }
  return `${pad2(hrs)}:${pad2(mins)}:${pad2(secs)},${pad3(ms)}`;
}

export function generateSrtContent(scenes: SceneItem[]): string {
  const entries: string[] = [];
  let counter = 1;

  for (const scene of scenes) {
    if (!scene.text.trim()) continue;
    const words = computeProportionalWordTimings(scene.text, scene.start, scene.end);
    const lines = groupWordsIntoLines(words, 3, 6);
    for (const line of lines) {
      entries.push(
        `${counter}\n${formatSrtTime(line.start)} --> ${formatSrtTime(line.end)}\n${line.text}`
      );
      counter++;
    }
  }

  return entries.join('\n\n') + (entries.length > 0 ? '\n' : '');
}
