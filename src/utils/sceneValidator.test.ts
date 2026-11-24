import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAndNormalizeScenes, getSceneSummaryStats } from './sceneValidator';

test('sorts unsorted scenes, closes gaps, anchors start=0 and end=audioDuration', () => {
  const raw = [
    { id: 2, start: 6.2, end: 10.0, text: 'Kedua.' },
    { id: 1, start: 0.8, end: 4.5, text: 'Pertama.' },
    { id: 3, start: 10.5, end: 14.2, text: 'Ketiga.' },
  ];

  const out = validateAndNormalizeScenes(raw, 15.0, 3, 6);
  assert.equal(out[0].start, 0);
  assert.equal(out[out.length - 1].end, 15.0);

  for (let i = 0; i < out.length; i++) {
    assert.equal(out[i].id, i + 1);
    if (i > 0) {
      assert.equal(out[i].start, out[i - 1].end, `Gap/overlap detected at index ${i}`);
    }
    const dur = out[i].end - out[i].start;
    assert.ok(dur >= 2.99 && dur <= 6.01, `Scene ${out[i].id} duration out of bounds: ${dur}`);
  }
});

test('merges scenes shorter than minDuration into neighbors without losing text', () => {
  const raw = [
    { start: 0, end: 1.2, text: 'Halo' },
    { start: 1.2, end: 4.5, text: 'dunia sains.' },
    { start: 4.5, end: 9.0, text: 'Ini menarik sekali.' },
    { start: 9.0, end: 10.0, text: 'Ya!' },
  ];

  const out = validateAndNormalizeScenes(raw, 10.0, 3, 6);
  assert.equal(out.length, 2);
  assert.equal(out[0].start, 0);
  assert.equal(out[0].text, 'Halo dunia sains.');
  assert.equal(out[1].end, 10.0);
  assert.equal(out[1].text, 'Ini menarik sekali. Ya!');
});

test('splits scenes longer than maxDuration cleanly within bounds', () => {
  const raw = [
    {
      start: 0,
      end: 15.0,
      text: 'Kalimat pertama menjelaskan dasar sains. Kalimat kedua memberi analogi menarik. Kalimat ketiga mengungkap fakta mengejutkan.',
    },
  ];

  const out = validateAndNormalizeScenes(raw, 15.0, 3, 6);
  assert.equal(out.length, 3);
  assert.equal(out[0].start, 0);
  assert.equal(out[2].end, 15.0);
  for (const s of out) {
    const dur = s.end - s.start;
    assert.ok(dur <= 6.01 && dur >= 2.5, `Unexpected split duration: ${dur}`);
    assert.ok(s.text.length > 0);
  }
});

test('computes accurate scene summary stats', () => {
  const scenes = [
    { id: 1, start: 0, end: 4, text: 'A' },
    { id: 2, start: 4, end: 9, text: 'B' },
  ];
  const stats = getSceneSummaryStats(scenes);
  assert.equal(stats.count, 2);
  assert.equal(stats.averageDuration, 4.5);
  assert.equal(stats.totalDuration, 9);
});

test('flexible mode preserves natural non-rigid visual beats (e.g. 2.4s punchline, 7.2s flowing sentence) while still merging micro-fragments and splitting overly long blocks', () => {
  const raw = [
    { start: 0, end: 2.4, text: 'Pernahkah kamu bertanya?' },
    { start: 2.4, end: 9.6, text: 'Bayangkan otakmu bekerja seperti kantor pos raksasa yang sibuk mengatur jutaan pesan setiap harinya.' },
    { start: 9.6, end: 14.2, text: 'Setiap momen baru langsung disimpan rapi.' },
    { start: 14.2, end: 15.0, text: 'Ya!' },
  ];

  const out = validateAndNormalizeScenes(raw, 15.0, 3, 6, { flexible: true });
  // Micro-fragment 0.8s ("Ya!") merges into scene 3, while 2.4s and 7.2s stay intact (not rigidly chopped/merged)
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((s) => s.id), [1, 2, 3]);
  assert.equal(out[0].start, 0);
  assert.equal(out[0].end, 2.4);
  assert.equal(Math.round((out[1].end - out[1].start) * 100) / 100, 7.2);
  assert.equal(out[2].end, 15.0);
  assert.equal(out[2].text, 'Setiap momen baru langsung disimpan rapi. Ya!');
});

