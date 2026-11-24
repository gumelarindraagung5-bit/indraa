import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findSilenceSplitPoints,
  isChunkCoverageComplete,
  evaluateAudioCoverage,
} from './audioChunker';

test('findSilenceSplitPoints splits long audio near lowest RMS silence pause', () => {
  const sampleRate = 1000; // 1kHz synthetic signal for fast test
  const totalSec = 118;
  const samples = new Float32Array(sampleRate * totalSec);

  // Fill with steady speech-level sine wave
  for (let i = 0; i < samples.length; i++) {
    samples[i] = 0.4 * Math.sin(i * 0.2);
  }
  // Insert deliberate silence gap at 57.0s - 57.5s (within +/-8s of 60s target)
  for (let i = 57000; i < 57500; i++) {
    samples[i] = 0.0;
  }

  const chunks = findSilenceSplitPoints(samples, sampleRate, 60, 8);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].startOffset, 0);
  // First cut should land inside the silence window [56.9, 57.6]
  assert.ok(
    chunks[0].endOffset >= 56.9 && chunks[0].endOffset <= 57.6,
    `Expected split in silence gap (~57.2s), got ${chunks[0].endOffset}`
  );
  assert.equal(chunks[1].startOffset, chunks[0].endOffset);
  assert.equal(chunks[1].endOffset, totalSec);
});

test('findSilenceSplitPoints handles 10-minute audio into ~10 chunks covering 0..600s', () => {
  const sampleRate = 200;
  const totalSec = 600;
  const samples = new Float32Array(sampleRate * totalSec);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = 0.2 * Math.sin(i * 0.1);
  }

  const chunks = findSilenceSplitPoints(samples, sampleRate, 60, 8);
  assert.ok(chunks.length >= 9 && chunks.length <= 11, `Expected ~10 chunks, got ${chunks.length}`);
  assert.equal(chunks[0].startOffset, 0);
  assert.equal(chunks[chunks.length - 1].endOffset, 600);
  for (let i = 1; i < chunks.length; i++) {
    assert.equal(chunks[i].startOffset, chunks[i - 1].endOffset);
  }
});

test('isChunkCoverageComplete rejects responses stopping early by > 1s', () => {
  assert.equal(
    isChunkCoverageComplete([{ start: 0, end: 35.0, text: 'Setengah saja' }], 60),
    false
  );
  assert.equal(
    isChunkCoverageComplete(
      [
        { start: 0, end: 30, text: 'Bagian awal' },
        { start: 30, end: 59.3, text: 'Bagian akhir' },
      ],
      60
    ),
    true
  );
});

test('evaluateAudioCoverage detects uncovered tail and reports 100% only when complete', () => {
  const incomplete = evaluateAudioCoverage(
    [
      { start: 0, end: 30 },
      { start: 30, end: 60 },
    ],
    120
  );
  assert.equal(incomplete.isComplete, false);
  assert.equal(incomplete.percent, 50);
  assert.equal(incomplete.uncoveredRanges.length, 1);
  assert.equal(incomplete.uncoveredRanges[0].start, 60);
  assert.equal(incomplete.uncoveredRanges[0].end, 120);

  const complete = evaluateAudioCoverage(
    [
      { start: 0, end: 60 },
      { start: 60, end: 120 },
    ],
    120
  );
  assert.equal(complete.isComplete, true);
  assert.equal(complete.percent, 100);
  assert.equal(complete.uncoveredRanges.length, 0);
});
