import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFinalSingleLinePrompt,
  findMissingPromptIds,
  formatPromptsForCopy,
  parseAndNormalizePromptItems,
  selectGenerateTargetIds,
  sliceScenesByRange,
  splitScenesInHalf,
} from './promptUtils';
import { MANDATORY_PROMPT_SUFFIX, type SceneItem } from '../types/project';

const config = {
  stylePrompt: 'Watercolor ink style.',
  characterPrompt: 'Minimalist stickman.',
  crowdPrompt: 'Background crowd of stickmen.',
};

const sampleScenes: SceneItem[] = [
  { id: 1, start: 0, end: 4, text: 'Ia melihat jam dinding sendiri.', scenePrompt: 'Wide shot of stickman looking at a giant clock' },
  { id: 2, start: 4, end: 8, text: 'Banyak orang berjalan terburu-buru di kota.', scenePrompt: 'Medium shot of stickman amidst rushing commuters' },
  { id: 3, start: 8, end: 12, text: 'Otak kita bekerja seperti kamera.', scenePrompt: 'Close-up of stickman holding a vintage camera' },
  { id: 4, start: 12, end: 16, text: 'Mulailah hal baru besok.', scenePrompt: 'Wide shot of stickman stepping onto a sunny new road' },
];

test('findMissingPromptIds accurately detects missing or empty scene IDs', () => {
  const missing = findMissingPromptIds([1, 2, 3, 4], [
    { id: 1, scene: 'Wide shot of stickman reading at wooden desk.' },
    { id: 2, scene: '   ' },
    { id: '4', scene: 'Close-up of stickman smiling gently.' },
  ]);
  assert.deepEqual(missing, [2, 3]);
});

test('parseAndNormalizePromptItems handles wrapped objects, string IDs, and truncated JSON arrays', () => {
  const truncated = `\`\`\`json
[
  {"id": "1", "scene": "Wide shot of stickman looking at a floating pocket watch.", "shotType": "Wide shot"},
  {"id": "scene_002", "scenePrompt": "Close-up of stickman examining a glowing hourglass with curious eyes."},
  {"id": 3, "scene": "Medium shot of stickman standing inside a truncated`;
  const salvaged = parseAndNormalizePromptItems(truncated);
  assert.equal(salvaged.length, 2);
  assert.equal(salvaged[0].id, 1);
  assert.equal(salvaged[1].id, 2);

  const wrapped = JSON.stringify({
    prompts: [{ id: 5, scene: 'High-angle shot of stickman walking along a chalk path.' }],
  });
  const parsedWrapped = parseAndNormalizePromptItems(wrapped);
  assert.equal(parsedWrapped.length, 1);
  assert.equal(parsedWrapped[0].id, 5);
});

test('buildFinalSingleLinePrompt adds [CROWD] strictly when narration mentions many people', () => {
  const p1 = buildFinalSingleLinePrompt(sampleScenes[0], config);
  assert.ok(!p1.includes('[CROWD]'));
  assert.ok(p1.endsWith(MANDATORY_PROMPT_SUFFIX));

  const p2 = buildFinalSingleLinePrompt(sampleScenes[1], config);
  assert.ok(p2.includes('[CROWD] Background crowd of stickmen.'));
  assert.ok(p2.endsWith(MANDATORY_PROMPT_SUFFIX));
});

test('formatPromptsForCopy supports numbered-paragraph and plain-single-line formats', () => {
  const numbered = formatPromptsForCopy(sampleScenes.slice(0, 2), config, 'numbered-paragraph');
  const blocks = numbered.split('\n\n');
  assert.equal(blocks.length, 2);
  assert.ok(blocks[0].startsWith('scene_001: [STYLE]'));
  assert.ok(blocks[1].startsWith('scene_002: [STYLE]'));

  const plain = formatPromptsForCopy(sampleScenes.slice(0, 2), config, 'plain-single-line');
  const lines = plain.split('\n');
  assert.equal(lines.length, 2);
  assert.ok(lines[0].startsWith('[STYLE]'));
  assert.ok(!lines[0].includes('scene_001'));
});

test('sliceScenesByRange and splitScenesInHalf slice accurately', () => {
  const range = sliceScenesByRange(sampleScenes, 2, 3);
  assert.deepEqual(range.map((s) => s.id), [2, 3]);

  const { firstHalf, secondHalf } = splitScenesInHalf(sampleScenes);
  assert.deepEqual(firstHalf.map((s) => s.id), [1, 2]);
  assert.deepEqual(secondHalf.map((s) => s.id), [3, 4]);
});

test('selectGenerateTargetIds handles 1-50 and 1-selesai scopes accurately', () => {
  // Short list (< 50 scenes)
  assert.deepEqual(selectGenerateTargetIds(sampleScenes, 'first-50'), [1, 2, 3, 4]);
  assert.deepEqual(selectGenerateTargetIds(sampleScenes, 'all'), [1, 2, 3, 4]);

  // Long list (120 scenes, e.g. 10-min audio)
  const manyScenes: SceneItem[] = Array.from({ length: 120 }, (_, i) => ({
    id: i + 1,
    start: i * 5,
    end: (i + 1) * 5,
    text: `Kalimat adegan ${i + 1}`,
  }));

  const first50 = selectGenerateTargetIds(manyScenes, 'first-50');
  assert.equal(first50.length, 50);
  assert.equal(first50[0], 1);
  assert.equal(first50[49], 50);

  const allIds = selectGenerateTargetIds(manyScenes, 'all');
  assert.equal(allIds.length, 120);
  assert.equal(allIds[0], 1);
  assert.equal(allIds[119], 120);
});

test('VISUAL_STYLE_PRESETS includes all 6 requested new visual styles with exact [STYLE], [CHARACTER], and [CROWD] prompts', async () => {
  const { VISUAL_STYLE_PRESETS } = await import('../types/project');
  const ids = VISUAL_STYLE_PRESETS.map((p) => p.id);
  const expectedNewIds = [
    'hybrid-2d-3d-ricks',
    'noir-psikologi',
    'claymation-diorama',
    'whiteboard-rough-sketch',
    'kurzgesagt-scifi',
    'vintage-blueprint',
  ];

  for (const id of expectedNewIds) {
    const preset = VISUAL_STYLE_PRESETS.find((p) => p.id === id);
    assert.ok(preset, `Expected visual style preset "${id}" to exist`);
    assert.ok(preset.stylePrompt.length > 40);
    assert.ok(preset.characterPrompt.length > 40);
    assert.ok(preset.crowdPrompt.length > 30);
  }
  assert.ok(ids.includes('kok-bisa-watercolor'));
  assert.ok(ids.includes('satu-persen-editorial'));

  const hybrid = VISUAL_STYLE_PRESETS.find((p) => p.id === 'hybrid-2d-3d-ricks')!;
  const crowdPrompt = buildFinalSingleLinePrompt(sampleScenes[1], hybrid);
  assert.ok(crowdPrompt.includes('Flat 2D illustrated animation cels composited into a fully dimensional'));
  assert.ok(crowdPrompt.includes('solid slate-blue t-shirt (#4A78B8)'));
  assert.ok(crowdPrompt.includes('[CROWD] Background crowd made of the same flat 2D minimalist stickman style'));
});

