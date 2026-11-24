import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeProportionalWordTimings,
  groupWordsIntoLines,
  generateSrtContent,
  formatSrtTime,
} from './subtitleUtils';

test('computes proportional word timings spanning exact scene duration', () => {
  const words = computeProportionalWordTimings('Otak manusia bekerja cepat', 2.0, 6.0);
  assert.equal(words.length, 4);
  assert.equal(words[0].start, 2.0);
  assert.equal(words[3].end, 6.0);
  // Longer word ("manusia" / "bekerja") gets longer duration than shorter word ("Otak")
  const otakDur = words[0].end - words[0].start;
  const manusiaDur = words[1].end - words[1].start;
  assert.ok(manusiaDur > otakDur);
});

test('groups words into 3-6 word lines without tiny trailing orphans', () => {
  const words = computeProportionalWordTimings(
    'Satu dua tiga empat lima enam tujuh',
    0,
    7
  );
  const lines = groupWordsIntoLines(words, 3, 6);
  assert.equal(lines.length, 2);
  assert.ok(lines[0].words.length >= 3 && lines[0].words.length <= 6);
  assert.ok(lines[1].words.length >= 3 && lines[1].words.length <= 6);
});

test('formats SRT timestamps and generates valid SRT blocks', () => {
  assert.equal(formatSrtTime(65.432), '00:01:05,432');
  const srt = generateSrtContent([
    { id: 1, start: 0, end: 4, text: 'Pernah merasa waktu berjalan cepat?' },
    { id: 2, start: 4, end: 8, text: 'Ini penjelasannya.' },
  ]);
  assert.ok(srt.includes('1\n00:00:00,000 --> 00:00:04,000\nPernah merasa waktu berjalan cepat?'));
  assert.ok(srt.includes('2\n00:00:04,000 --> 00:00:08,000\nIni penjelasannya.'));
});
