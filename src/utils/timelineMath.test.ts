import test from 'node:test';
import assert from 'node:assert/strict';
import {
  adjustCutBoundary,
  nudgeCutBoundary,
  compareNaturalFileName,
  extractSceneNumberFromFileName,
  assignUploadedImagesToScenes,
  buildChaptersFromScenes,
  assembleScenePrompt,
  formatTimeMMSS,
} from './timelineMath';
import { MANDATORY_PROMPT_SUFFIX, type SceneItem } from '../types/project';

const baseScenes: SceneItem[] = [
  { id: 1, start: 0, end: 4, text: 'Adegan satu' },
  { id: 2, start: 4, end: 8, text: 'Adegan dua' },
  { id: 3, start: 8, end: 12, text: 'Adegan tiga' },
];

test('adjustCutBoundary keeps total duration constant and enforces 1s minimum', () => {
  const moved = adjustCutBoundary(baseScenes, 0, 5.5);
  assert.equal(moved[0].end, 5.5);
  assert.equal(moved[1].start, 5.5);
  assert.equal(moved[2].end, 12);

  // Attempting to push past right clip minimum (8 - 1 = 7) clamps to 7
  const clampedRight = adjustCutBoundary(baseScenes, 0, 7.8);
  assert.equal(clampedRight[0].end, 7.0);
  assert.equal(clampedRight[1].start, 7.0);
  assert.equal(clampedRight[1].end - clampedRight[1].start, 1.0);

  // Attempting to push below left clip minimum (0 + 1 = 1) clamps to 1
  const clampedLeft = adjustCutBoundary(baseScenes, 0, 0.2);
  assert.equal(clampedLeft[0].end, 1.0);
  assert.equal(clampedLeft[1].start, 1.0);
});

test('nudgeCutBoundary shifts cut point by exact delta', () => {
  const nudged = nudgeCutBoundary(baseScenes, 0, 0.3);
  assert.equal(nudged[0].end, 4.3);
  assert.equal(nudged[1].start, 4.3);
  const nudgedBack = nudgeCutBoundary(nudged, 0, -0.1);
  assert.equal(nudgedBack[0].end, 4.2);
  assert.equal(nudgedBack[1].start, 4.2);
});

test('compareNaturalFileName sorts numbered filenames naturally', () => {
  const files = ['scene_10.png', 'scene_2.png', 'scene_1.png', 'scene_11.png'];
  files.sort(compareNaturalFileName);
  assert.deepEqual(files, ['scene_1.png', 'scene_2.png', 'scene_10.png', 'scene_11.png']);
});

test('extractSceneNumberFromFileName detects explicit scene numbers without false date matches', () => {
  assert.equal(extractSceneNumberFromFileName('scene_005.png'), 5);
  assert.equal(extractSceneNumberFromFileName('adegan-12.jpg'), 12);
  assert.equal(extractSceneNumberFromFileName('03_stickman_kota.webp'), 3);
  assert.equal(extractSceneNumberFromFileName('8.png'), 8);
  assert.equal(extractSceneNumberFromFileName('IMG_20261119_102233.png'), null);
});

test('assignUploadedImagesToScenes maps numbered filenames and fills empty scenes across multi-batch uploads without overwriting Scene #1', () => {
  const scenes: SceneItem[] = [
    { id: 1, start: 0, end: 4, text: 'Satu', imageId: null },
    { id: 2, start: 4, end: 8, text: 'Dua', imageId: null },
    { id: 3, start: 8, end: 12, text: 'Tiga', imageId: null },
    { id: 4, start: 12, end: 16, text: 'Empat', imageId: null },
  ];

  // Batch 1: upload image explicitly numbered for scene 3 and one unnumbered image
  const afterBatch1 = assignUploadedImagesToScenes(
    scenes,
    [
      { id: 'img-a', fileName: 'scene_003.png', lastModified: 100 },
      { id: 'img-b', fileName: 'random_opening.png', lastModified: 200 },
    ],
    'name'
  );

  assert.equal(afterBatch1[0].imageId, 'img-b'); // filled first empty scene (#1)
  assert.equal(afterBatch1[1].imageId, null);
  assert.equal(afterBatch1[2].imageId, 'img-a'); // matched scene #3 explicitly
  assert.equal(afterBatch1[3].imageId, null);

  // Batch 2: upload two more unnumbered images -> should fill scenes #2 and #4 without overwriting #1 or #3
  const afterBatch2 = assignUploadedImagesToScenes(
    afterBatch1,
    [
      { id: 'img-c', fileName: 'next_shot_1.png', lastModified: 300 },
      { id: 'img-d', fileName: 'next_shot_2.png', lastModified: 400 },
    ],
    'name'
  );

  assert.equal(afterBatch2[0].imageId, 'img-b');
  assert.equal(afterBatch2[1].imageId, 'img-c');
  assert.equal(afterBatch2[2].imageId, 'img-a');
  assert.equal(afterBatch2[3].imageId, 'img-d');
});

test('buildChaptersFromScenes guarantees 00:00 first chapter and mm:ss formatting', () => {
  assert.equal(formatTimeMMSS(125), '02:05');
  const scenes: SceneItem[] = [
    { id: 1, start: 0, end: 15, text: 'Intro' },
    { id: 2, start: 15, end: 75, text: 'Bagian dua' },
    { id: 3, start: 75, end: 140, text: 'Bagian tiga' },
  ];
  const chapters = buildChaptersFromScenes(
    [
      { sceneId: 3, title: 'Plot Twist' },
      { sceneId: 2, title: 'Penjelasan Utama' },
    ],
    scenes
  );
  assert.equal(chapters[0].timeFormatted, '00:00');
  assert.equal(chapters[1].timeFormatted, '00:15');
  assert.equal(chapters[2].timeFormatted, '01:15');
});

test('assembleScenePrompt includes [CROWD] only when relevant and always appends clean suffix', () => {
  const solo = assembleScenePrompt({
    stylePrompt: 'Watercolor style',
    characterPrompt: 'Stickman character',
    crowdPrompt: 'Background stickmen',
    scenePrompt: 'Wide shot of stickman reading a book',
    narrationText: 'Ia membaca buku sendirian di kamar.',
    hasCrowd: false,
  });
  assert.ok(solo.includes('[STYLE] Watercolor style'));
  assert.ok(solo.includes('[CHARACTER] Stickman character'));
  assert.ok(!solo.includes('[CROWD]'));
  assert.ok(solo.endsWith(MANDATORY_PROMPT_SUFFIX));

  const crowd = assembleScenePrompt({
    stylePrompt: 'Watercolor style',
    characterPrompt: 'Stickman character',
    crowdPrompt: 'Background stickmen',
    scenePrompt: 'Wide shot of stickman speaking on stage',
    narrationText: 'Banyak orang berkumpul mendengarkan cerita ini.',
    hasCrowd: false,
  });
  assert.ok(crowd.includes('[CROWD] Background stickmen'));
  assert.ok(crowd.endsWith(MANDATORY_PROMPT_SUFFIX));
});
