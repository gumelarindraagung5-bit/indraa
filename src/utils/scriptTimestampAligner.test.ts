import test from 'node:test';
import assert from 'node:assert/strict';
import {
  alignScriptToVisualTimestamps,
  countIndonesianSyllables,
  hasImbalancedSpeechTimestamps,
  rebalanceSceneTimestampsToSpeechDuration,
  snapExistingScenesToAudioPauses,
  splitSceneIntoTwoVisualBeats,
} from './scriptTimestampAligner';

test('alignScriptToVisualTimestamps creates varied non-rigid timestamps covering 0..exact audioDuration with 1..N numbering', () => {
  const paragraph =
    'Pernahkah kamu menyadari bahwa selama puluhan ribu tahun, kehidupan kakek buyut kita hampir tidak pernah berubah sama sekali dalam hal kecepatan? ' +
    'Padahal hari ini, jam di dinding tetap berdetak dengan kecepatan persis sama, enam puluh detik setiap menitnya. ' +
    'Rahasianya ternyata bukan ada pada jam tanganmu, melainkan di dalam cara otak manusia merekam memori baru setiap hari. ' +
    'Saat kita mengalami hal baru di tempat asing, otak bekerja ekstra keras memotret setiap detail kecil di sekitar kita. ' +
    'Sebaliknya, ketika rutinitas hari Senin sampai Jumat selalu sama persis, otak masuk ke mode autopilot demi menghemat energi. ' +
    'Akibatnya, satu minggu yang penuh rutinitas terasa cepat sekali lewat saat kita menoleh ke belakang di akhir pekan. ' +
    'Ilmuwan menyebut fenomena paradoks ini sebagai holiday paradox yang dialami hampir semua orang di seluruh dunia. ' +
    'Bayangkan otakmu seperti kamera film lama yang hanya memotret saat ada kejadian unik yang mencuri perhatianmu. ' +
    'Kabar baiknya, kamu bisa memperlambat rasa waktu hanya dengan mencoba satu kebiasaan baru setiap pekan.';

  // Repeat to simulate an ~8.5-minute narration (~512.1 seconds)
  const longScript = Array.from({ length: 6 }, () => paragraph).join(' ');
  const scenes = alignScriptToVisualTimestamps(longScript, 512.1, {
    minSec: 3.5,
    maxSec: 5.8,
  });

  assert.ok(scenes.length >= 75 && scenes.length <= 135, `Expected ~90-115 scenes, got ${scenes.length}`);
  assert.equal(scenes[0].id, 1);
  assert.equal(scenes[0].start, 0);
  assert.equal(scenes[scenes.length - 1].end, 512.1);

  // Verify zero gaps, zero overlaps, sequential numbering 1..N, and non-rigid varied durations
  const durations = new Set<number>();
  for (let i = 0; i < scenes.length; i++) {
    assert.equal(scenes[i].id, i + 1);
    assert.ok(scenes[i].text.trim().length > 0);
    if (i > 0) {
      assert.equal(scenes[i].start, scenes[i - 1].end);
    }
    const dur = Math.round((scenes[i].end - scenes[i].start) * 10) / 10;
    assert.ok(dur >= 2.0 && dur <= 7.8, `Scene ${scenes[i].id} duration out of natural range: ${dur}s`);
    durations.add(dur);
  }

  // Must NOT be rigid/uniform (many distinct natural durations)
  assert.ok(durations.size >= 8, `Expected varied non-rigid durations, got only ${durations.size} distinct values`);

  // Verify every single word is preserved without truncation
  const reassembled = scenes.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim();
  assert.equal(reassembled, longScript.replace(/\s+/g, ' ').trim());
});

test('alignScriptToVisualTimestamps snaps internal cuts toward real audio silence pauses and tracks VAD speech curve', () => {
  const sampleRate = 1000;
  const duration = 12.0;
  const samples = new Float32Array(sampleRate * duration);
  // Sentence 1 spoken from 0.4s to 4.1s, long breath pause from 4.1s to 4.8s, Sentence 2 spoken from 4.8s to 11.4s
  for (let i = 0; i < samples.length; i++) {
    const t = i / sampleRate;
    const isSilent = t < 0.4 || (t >= 4.1 && t <= 4.8) || t > 11.4;
    samples[i] = isSilent ? 0.0005 : 0.42 * Math.sin(i * 0.17);
  }

  const script =
    'Kalimat pertama pendek yang diucapkan cepat di awal rekaman. ' +
    'Kalimat kedua memiliki durasi pembacaan sedikit lebih panjang setelah jeda napas satu detik penuh.';

  const scenes = alignScriptToVisualTimestamps(script, duration, {
    minSec: 3.5,
    maxSec: 6.5,
    audioWaveform: { monoSamples: samples, sampleRate },
  });

  assert.equal(scenes.length, 2);
  assert.equal(scenes[0].start, 0);
  assert.equal(scenes[1].end, 12.0);
  assert.ok(
    scenes[0].end >= 4.0 && scenes[0].end <= 5.0,
    `Expected VAD + silence-snapped cut near 4.1s..4.8s pause, got ${scenes[0].end}s`
  );
});

test('snapExistingScenesToAudioPauses locks drifted cut boundaries to real silence valleys while preserving images', () => {
  const sampleRate = 1000;
  const duration = 10.0;
  const samples = new Float32Array(sampleRate * duration);
  for (let i = 0; i < samples.length; i++) {
    const t = i / sampleRate;
    const isPause = t >= 4.55 && t <= 4.95;
    samples[i] = isPause ? 0.0005 : 0.4 * Math.sin(i * 0.15);
  }

  const driftedScenes = [
    { id: 1, start: 0, end: 5.1, text: 'Kalimat satu.', imageId: 'img-1' },
    { id: 2, start: 5.1, end: 10.0, text: 'Kalimat dua.', imageId: 'img-2' },
  ];

  const snapped = snapExistingScenesToAudioPauses(driftedScenes, duration, {
    monoSamples: samples,
    sampleRate,
  });

  assert.equal(snapped[0].imageId, 'img-1');
  assert.equal(snapped[1].imageId, 'img-2');
  assert.ok(
    snapped[0].end >= 4.4 && snapped[0].end <= 5.05,
    `Expected cut boundary to snap from 5.1s into 4.55..4.95s pause, got ${snapped[0].end}s`
  );
  assert.equal(snapped[1].start, snapped[0].end);
});

test('hasImbalancedSpeechTimestamps detects and rebalanceSceneTimestampsToSpeechDuration fixes prematurely cut 2.7s/2.6s/6.4s sentences', () => {
  const distortedScenes = [
    {
      id: 1,
      start: 0,
      end: 2.7,
      text: 'Pernah nggak kamu merasa waktu berjalan jauh lebih cepat saat liburan dibanding hari Senin pagi?',
    },
    {
      id: 2,
      start: 2.7,
      end: 5.3,
      text: 'Padahal jam di dinding berdetak dengan kecepatan yang persis sama, enam puluh detik setiap menitnya.',
    },
    {
      id: 3,
      start: 5.3,
      end: 11.7,
      text: 'Rahasianya ternyata bukan ada pada jam tanganmu, melainkan di dalam cara otak manusia merekam memori baru.',
    },
  ];

  assert.equal(hasImbalancedSpeechTimestamps(distortedScenes, 15.6), true);

  const rebalanced = rebalanceSceneTimestampsToSpeechDuration(distortedScenes, 15.6);
  assert.equal(rebalanced.length, 3);
  for (const s of rebalanced) {
    const dur = s.end - s.start;
    // Each ~15-word (33-41 syllable) sentence in 15.6s total must get ~4.5s - 5.8s, never 2.7s!
    assert.ok(dur >= 4.4 && dur <= 5.9, `Expected balanced duration 4.4..5.9s, got ${dur}s for scene #${s.id}`);
  }
  assert.equal(hasImbalancedSpeechTimestamps(rebalanced, 15.6), false);
});

test('splitSceneIntoTwoVisualBeats splits a long sentence at its natural clause boundary with syllable-proportional durations', () => {
  const scenes = [
    {
      id: 1,
      start: 0,
      end: 5.2,
      text: 'Pernah nggak kamu merasa waktu berjalan jauh lebih cepat saat liburan dibanding hari Senin pagi?',
    },
  ];

  const split = splitSceneIntoTwoVisualBeats(scenes, 1);
  assert.equal(split.length, 2);
  assert.equal(split[0].id, 1);
  assert.equal(split[1].id, 2);
  assert.equal(split[0].start, 0);
  assert.equal(split[0].end, split[1].start);
  assert.equal(split[1].end, 5.2);
  assert.ok(countIndonesianSyllables(split[0].text) >= 10);
  assert.ok(countIndonesianSyllables(split[1].text) >= 10);
});
