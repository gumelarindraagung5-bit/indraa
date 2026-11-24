import React, { useEffect, useMemo, useState } from 'react';
import {
  Sparkles,
  Copy,
  Check,
  RefreshCw,
  Download,
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Users,
  CheckSquare,
  Square,
} from 'lucide-react';
import {
  VISUAL_STYLE_PRESETS,
  type SceneItem,
  type StudioProject,
  type VisualStyleId,
} from '../types/project';
import { copyToClipboard, fetchWithRetry } from '../utils/apiClient';
import {
  buildFinalSingleLinePrompt,
  findMissingPromptIds,
  formatPromptsForCopy,
  selectGenerateTargetIds,
  sliceScenesByRange,
  splitScenesInHalf,
  type PromptCopyFormat,
} from '../utils/promptUtils';
import { triggerTextDownload } from '../utils/storage';
import { detectCrowdInText, formatSceneCode, formatTimePrecise } from '../utils/timelineMath';

interface Step4Props {
  project: StudioProject;
  onUpdate: (patch: Partial<StudioProject>) => void;
  onPrev: () => void;
  onNext: () => void;
}

const PAGE_SIZE = 12;
const AI_BATCH_SIZE = 15;
const RETRY_SUB_BATCH_SIZE = 6;
const COPY_BATCH_SIZE = 24;
const MAX_MISSING_RETRIES = 3;
const RETRY_DELAYS_MS = [1200, 2500, 4000];

interface AiPromptReturnItem {
  id: number | string;
  scene?: string;
  scenePrompt?: string;
  shotType?: string;
}

export const Step4ImagePrompts: React.FC<Step4Props> = ({
  project,
  onUpdate,
  onPrev,
  onNext,
}) => {
  const [page, setPage] = useState(1);
  const [generating, setGenerating] = useState(false);
  const [activeGenLabel, setActiveGenLabel] = useState<string>('');
  const [progress, setProgress] = useState({ currentBatch: 0, totalBatches: 0, message: '' });
  const [missingIdsAfterRun, setMissingIdsAfterRun] = useState<number[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [regeneratingId, setRegeneratingId] = useState<number | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [copyToast, setCopyToast] = useState<string | null>(null);

  // Copy format & selection controls
  const [copyFormat, setCopyFormat] = useState<PromptCopyFormat>('numbered-paragraph');
  const [rangeFrom, setRangeFrom] = useState<number>(1);
  const [rangeTo, setRangeTo] = useState<number>(Math.max(1, project.scenes.length));
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  useEffect(() => {
    setRangeTo((prev) => {
      if (project.scenes.length === 0) return 1;
      if (prev <= 1 || prev > project.scenes.length) return project.scenes.length;
      return prev;
    });
  }, [project.scenes.length]);

  const totalPages = Math.max(1, Math.ceil(project.scenes.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);

  const pagedScenes = useMemo(() => {
    const startIdx = (safePage - 1) * PAGE_SIZE;
    return project.scenes.slice(startIdx, startIdx + PAGE_SIZE);
  }, [project.scenes, safePage]);

  const copyBatches = useMemo(() => {
    const batches: Array<{ index: number; start: number; end: number }> = [];
    for (let i = 0; i < project.scenes.length; i += COPY_BATCH_SIZE) {
      batches.push({
        index: batches.length + 1,
        start: i + 1,
        end: Math.min(project.scenes.length, i + COPY_BATCH_SIZE),
      });
    }
    return batches;
  }, [project.scenes.length]);

  const generatedCount = useMemo(
    () => project.scenes.filter((s) => Boolean(s.scenePrompt?.trim())).length,
    [project.scenes]
  );

  const missingSceneIds = useMemo(
    () => project.scenes.filter((s) => !s.scenePrompt?.trim()).map((s) => s.id),
    [project.scenes]
  );

  const scriptSummary = useMemo(() => {
    const base = project.script.trim() || project.scenes.map((s) => s.text).join(' ');
    const titlePart = project.selectedTitle ? `Judul: ${project.selectedTitle}. ` : '';
    return `${titlePart}${base}`.slice(0, 1400);
  }, [project.script, project.scenes, project.selectedTitle]);

  const assemblyConfig = useMemo(
    () => ({
      stylePrompt: project.stylePrompt || '',
      characterPrompt: project.characterPrompt || '',
      crowdPrompt: project.crowdPrompt || '',
    }),
    [project.stylePrompt, project.characterPrompt, project.crowdPrompt]
  );

  const showCopyFeedback = (key: string, count: number) => {
    setCopiedKey(key);
    const msg = `Berhasil menyalin ${count} prompt`;
    setCopyToast(msg);
    setTimeout(() => setCopiedKey((curr) => (curr === key ? null : curr)), 1800);
    setTimeout(() => setCopyToast((curr) => (curr === msg ? null : curr)), 2600);
  };

  const handleSelectVisualStyle = (id: VisualStyleId) => {
    const preset = VISUAL_STYLE_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    onUpdate({
      visualStyle: id,
      stylePrompt: preset.stylePrompt,
      characterPrompt: preset.characterPrompt,
      crowdPrompt: preset.crowdPrompt,
    });
  };

  const requestBatchFromApi = async (
    batchScenes: SceneItem[],
    previousSceneHint: string
  ): Promise<AiPromptReturnItem[]> => {
    const data = await fetchWithRetry<{ prompts: AiPromptReturnItem[] }>(
      '/api/ai/prompts',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scenes: batchScenes.map((s) => ({
            id: Number(s.id),
            start: Number(s.start) || 0,
            end: Number(s.end) || 0,
            text: s.text || '',
          })),
          scriptSummary,
          styleText: project.stylePrompt || '',
          characterText: project.characterPrompt || '',
          previousSceneHint,
        }),
      },
      { maxRetries: 1, baseDelayMs: 1000 }
    );
    return Array.isArray(data.prompts) ? data.prompts : [];
  };

  /**
   * Generates prompts in batches of 15 scenes.
   * After EVERY batch, validates by ID: if any IDs are missing or blank,
   * automatically retries ONLY those missing IDs (splitting into smaller 6-scene sub-batches on retry) up to 3 times.
   */
  const runGenerationForScenes = async (targetSceneIds?: number[], scopeLabel = '1–Selesai') => {
    if (project.scenes.length === 0) {
      setErrorMsg('Belum ada daftar adegan. Buat timestamp adegan di Kotak 3 terlebih dahulu.');
      return;
    }

    setErrorMsg(null);
    setMissingIdsAfterRun([]);
    setGenerating(true);
    setActiveGenLabel(scopeLabel);

    const workingScenes = project.scenes.slice();
    const sceneIndexById = new Map<number, number>();
    workingScenes.forEach((s, idx) => sceneIndexById.set(s.id, idx));

    const targetScenes = targetSceneIds
      ? workingScenes.filter((s) => targetSceneIds.includes(s.id))
      : workingScenes;

    const totalBatches = Math.max(1, Math.ceil(targetScenes.length / AI_BATCH_SIZE));
    const unresolvedIds: number[] = [];
    let lastBatchErrorMsg: string | null = null;

    try {
      let previousSceneHint = '';

      for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
        const batchNum = batchIdx + 1;
        const batchSlice = targetScenes.slice(
          batchIdx * AI_BATCH_SIZE,
          (batchIdx + 1) * AI_BATCH_SIZE
        );
        const requestedIds = batchSlice.map((s) => s.id);
        const batchCollected = new Map<number, { scene: string; shotType?: string }>();

        setProgress({
          currentBatch: batchNum,
          totalBatches,
          message: `Generate ${scopeLabel} · Batch ${batchNum} dari ${totalBatches} (adegan ${batchSlice[0].id}–${batchSlice[batchSlice.length - 1].id})...`,
        });

        let pendingIds = requestedIds.slice();

        for (let attempt = 0; attempt <= MAX_MISSING_RETRIES; attempt++) {
          if (pendingIds.length === 0) break;

          if (attempt > 0) {
            const delayMs = RETRY_DELAYS_MS[attempt - 1] ?? 4000;
            setProgress({
              currentBatch: batchNum,
              totalBatches,
              message: `Batch ${batchNum} dari ${totalBatches} — melengkapi ${pendingIds.length} adegan yang kurang (percobaan ${attempt}/${MAX_MISSING_RETRIES})...`,
            });
            await new Promise((r) => setTimeout(r, delayMs));
          }

          const toRequestAll = batchSlice.filter((s) => pendingIds.includes(s.id));
          // On retries, split larger pending groups into compact sub-batches so partial failures recover fast
          const subBatchSize =
            attempt > 0 && toRequestAll.length > RETRY_SUB_BATCH_SIZE
              ? RETRY_SUB_BATCH_SIZE
              : toRequestAll.length;

          for (let subStart = 0; subStart < toRequestAll.length; subStart += subBatchSize) {
            const toRequest = toRequestAll.slice(subStart, subStart + subBatchSize);
            try {
              const returned = await requestBatchFromApi(toRequest, previousSceneHint);

              for (const item of returned) {
                const numericId = Number(item.id);
                const sceneText = (item.scene ?? item.scenePrompt ?? '').trim();
                if (
                  Number.isFinite(numericId) &&
                  sceneText.length >= 6 &&
                  pendingIds.includes(numericId)
                ) {
                  batchCollected.set(numericId, {
                    scene: sceneText,
                    shotType: item.shotType,
                  });
                }
              }

              // Fallback positional mapping ONLY when exact count matches and IDs weren't matched
              if (batchCollected.size < requestedIds.length && returned.length === toRequest.length) {
                for (let k = 0; k < toRequest.length; k++) {
                  const targetId = toRequest[k].id;
                  if (batchCollected.has(targetId)) continue;
                  const sceneText = (returned[k]?.scene ?? returned[k]?.scenePrompt ?? '').trim();
                  if (sceneText.length >= 6) {
                    batchCollected.set(targetId, {
                      scene: sceneText,
                      shotType: returned[k]?.shotType,
                    });
                  }
                }
              }
            } catch (batchErr) {
              lastBatchErrorMsg =
                batchErr instanceof Error
                  ? batchErr.message
                  : `Gagal memproses Batch ${batchNum} dari ${totalBatches}.`;
            }
          }

          const collectedArray = Array.from(batchCollected.entries()).map(([id, val]) => ({
            id,
            scene: val.scene,
          }));
          pendingIds = findMissingPromptIds(requestedIds, collectedArray);
        }

        // Apply all collected prompts from this batch immediately
        for (const [id, val] of batchCollected.entries()) {
          const idx = sceneIndexById.get(id);
          if (idx !== undefined) {
            workingScenes[idx] = {
              ...workingScenes[idx],
              scenePrompt: val.scene,
              hasCrowd: detectCrowdInText(workingScenes[idx].text || ''),
              shotType: val.shotType || workingScenes[idx].shotType || 'Medium shot',
            };
          }
        }

        if (pendingIds.length > 0) {
          unresolvedIds.push(...pendingIds);
        }

        const lastInBatch = batchSlice[batchSlice.length - 1];
        previousSceneHint =
          batchCollected.get(lastInBatch.id)?.scene || previousSceneHint;

        onUpdate({ scenes: workingScenes.slice() });
      }

      if (unresolvedIds.length > 0) {
        setMissingIdsAfterRun(unresolvedIds);
        const detailReason = lastBatchErrorMsg ? ` Penyebab: ${lastBatchErrorMsg}` : '';
        setErrorMsg(
          `${unresolvedIds.length} adegan belum mendapatkan prompt (ID: ${unresolvedIds.slice(0, 10).join(', ')}${unresolvedIds.length > 10 ? ', ...' : ''}).${detailReason} Klik "Lengkapi Adegan Kurang" untuk mencoba ulang.`
        );
      }
    } finally {
      setGenerating(false);
      setActiveGenLabel('');
    }
  };

  const handleRegenerateSingle = async (scene: SceneItem) => {
    setErrorMsg(null);
    setRegeneratingId(scene.id);
    try {
      const idx = project.scenes.findIndex((s) => s.id === scene.id);
      const prevHint = idx > 0 ? project.scenes[idx - 1]?.scenePrompt || '' : '';
      const returned = await requestBatchFromApi([scene], prevHint);
      const result = returned.find((r) => Number(r.id) === scene.id) || returned[0];
      const sceneText = (result?.scene ?? result?.scenePrompt ?? '').trim();

      if (sceneText) {
        const updated = project.scenes.map((s) =>
          s.id === scene.id
            ? {
                ...s,
                scenePrompt: sceneText,
                hasCrowd: detectCrowdInText(s.text || ''),
                shotType: result?.shotType || s.shotType,
              }
            : s
        );
        onUpdate({ scenes: updated });
      } else {
        setErrorMsg(`AI belum mengembalikan deskripsi prompt untuk adegan #${scene.id}. Silakan coba lagi.`);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : `Gagal regenerate adegan ${scene.id}.`);
    } finally {
      setRegeneratingId(null);
    }
  };

  // Copy & Download Handlers (all obey `copyFormat` and show "Berhasil menyalin X prompt" toast)
  const copyScenesList = async (scenesToCopy: SceneItem[], key: string, includeHeader = false) => {
    if (scenesToCopy.length === 0) return;
    const text = formatPromptsForCopy(
      scenesToCopy,
      assemblyConfig,
      copyFormat,
      includeHeader ? project.batchHeader : undefined
    );
    await copyToClipboard(text);
    showCopyFeedback(key, scenesToCopy.length);
  };

  const handleCopyAll = () => copyScenesList(project.scenes, 'all', false);

  const handleCopyRange = () => {
    const slice = sliceScenesByRange(project.scenes, rangeFrom, rangeTo);
    copyScenesList(slice, 'range', false);
  };

  const handleCopyFirstHalf = () => {
    const { firstHalf } = splitScenesInHalf(project.scenes);
    copyScenesList(firstHalf, 'first-half', false);
  };

  const handleCopySecondHalf = () => {
    const { secondHalf } = splitScenesInHalf(project.scenes);
    copyScenesList(secondHalf, 'second-half', false);
  };

  const handleCopyBatch = (batchIndex: number, start: number, end: number) => {
    const slice = project.scenes.slice(start - 1, end);
    copyScenesList(slice, `batch-${batchIndex}`, true);
  };

  const handleCopySelected = () => {
    const chosen = project.scenes.filter((s) => selectedIds.has(s.id));
    copyScenesList(chosen, 'selected', false);
  };

  const handleCopySingle = (scene: SceneItem) => {
    copyScenesList([scene], `scene-${scene.id}`, false);
  };

  const handleDownloadTxt = () => {
    const content = formatPromptsForCopy(project.scenes, assemblyConfig, copyFormat);
    const slug = (project.selectedTitle || 'stickman-prompts')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);
    triggerTextDownload(`${slug || 'prompts'}-gambar.txt`, content);
  };

  const toggleSelectScene = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allOnPageSelected =
    pagedScenes.length > 0 && pagedScenes.every((s) => selectedIds.has(s.id));

  const handleToggleSelectPage = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) {
        pagedScenes.forEach((s) => next.delete(s.id));
      } else {
        pagedScenes.forEach((s) => next.add(s.id));
      }
      return next;
    });
  };

  const { firstHalf, secondHalf } = useMemo(
    () => splitScenesInHalf(project.scenes),
    [project.scenes]
  );

  const progressPct =
    progress.totalBatches > 0
      ? Math.round((progress.currentBatch / progress.totalBatches) * 100)
      : 0;

  return (
    <section className="mx-auto max-w-[1200px] space-y-6" aria-labelledby="step4-heading">
      {/* Copy Success Toast */}
      {copyToast && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-xl border border-[#1E4631] bg-[#10241A] px-4 py-3 text-xs font-semibold text-[#86EFAC] shadow-2xl"
        >
          <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{copyToast}</span>
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between border-b border-[#1D2230] pb-5">
        <div>
          <p className="text-xs font-medium text-[#5B9BD5]">Kotak 4 dari 6</p>
          <h1 id="step4-heading" className="mt-1 text-2xl font-bold tracking-tight text-white">
            Hasil Timestamp &amp; Prompt Gambar
          </h1>
          <p className="mt-1 text-sm text-[#8F9BB3]">
            Menampilkan hasil timestamp dari Kotak 3 beserta prompt gambar langsung di bawah setiap timestamp. Pilih generate 1–50 atau 1–selesai.
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={onPrev}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[#2A3142] bg-[#141824] px-3.5 py-2 text-xs font-medium text-[#D2D8E6] hover:text-white whitespace-nowrap shrink-0"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Kotak 3</span>
          </button>
          <button
            type="button"
            onClick={onNext}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[#5B9BD5] px-4 py-2 text-xs font-semibold text-[#0B0D12] hover:bg-[#73ACE0] whitespace-nowrap shrink-0"
          >
            <span>Lanjut ke Kotak 5</span>
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Visual Style Cards + Locked STYLE / CHARACTER textboxes */}
      <div className="space-y-5 rounded-xl border border-[#1E2433] bg-[#12151E] p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-white">1. Pilih Gaya Visual &amp; Kunci Karakter</h2>
            <p className="mt-0.5 text-xs text-[#8F9BB3]">
              [STYLE] dan [CHARACTER] terkunci identik di setiap adegan. [CROWD] disisipkan otomatis hanya jika narasi menyebut banyak orang.
            </p>
          </div>
          {project.scenes.length > 0 && (
            <span className="rounded-md border border-[#2C3E5A] bg-[#162235] px-2.5 py-1 font-mono text-xs font-semibold text-[#8EC5F3] tabular-nums">
              {project.scenes.length} Timestamp = {project.scenes.length} Prompt
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
          {VISUAL_STYLE_PRESETS.map((preset) => {
            const active = project.visualStyle === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                aria-pressed={active}
                onClick={() => handleSelectVisualStyle(preset.id)}
                className={`rounded-lg border p-3 text-left transition-colors ${
                  active
                    ? 'border-[#5B9BD5] bg-[#172233] text-white'
                    : 'border-[#232A3B] bg-[#0E1118] text-[#B6C0D4] hover:border-[#343E57] hover:text-white'
                }`}
              >
                <span className="block text-xs font-semibold leading-snug">{preset.label}</span>
                <span className="mt-1 block text-[11px] leading-relaxed text-[#8F9BB3]">
                  {preset.summary}
                </span>
              </button>
            );
          })}
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div>
            <label htmlFor="locked-style" className="block text-xs font-semibold text-[#D2D8E6]">
              [STYLE] (Terkunci untuk semua adegan)
            </label>
            <textarea
              id="locked-style"
              rows={3}
              value={project.stylePrompt}
              onChange={(e) => onUpdate({ stylePrompt: e.target.value })}
              className="mt-1.5 w-full rounded-lg border border-[#272E40] bg-[#0C0F16] p-3 font-mono text-xs leading-relaxed text-[#E6EAF2] focus:border-[#5B9BD5] focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="locked-character" className="block text-xs font-semibold text-[#D2D8E6]">
              [CHARACTER] (Terkunci untuk semua adegan)
            </label>
            <textarea
              id="locked-character"
              rows={3}
              value={project.characterPrompt}
              onChange={(e) => onUpdate({ characterPrompt: e.target.value })}
              className="mt-1.5 w-full rounded-lg border border-[#272E40] bg-[#0C0F16] p-3 font-mono text-xs leading-relaxed text-[#E6EAF2] focus:border-[#5B9BD5] focus:outline-none"
            />
          </div>
        </div>

        <div className="flex flex-col gap-3 border-t border-[#1E2433] pt-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="space-y-0.5 tabular-nums">
            <p className="text-sm font-semibold text-white">
              Total mengikuti timestamp Kotak 3: {project.scenes.length} adegan
            </p>
            <p className="text-xs text-[#8F9BB3]">
              Prompt terisi: <strong className="text-white">{generatedCount}</strong> dari{' '}
              <strong className="text-white">{project.scenes.length}</strong> (batch {AI_BATCH_SIZE} adegan per panggilan)
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {missingSceneIds.length > 0 && generatedCount > 0 && (
              <button
                type="button"
                disabled={generating}
                onClick={() => runGenerationForScenes(missingSceneIds, 'Sisa')}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[#364A6B] bg-[#1A263A] px-3.5 py-2.5 text-xs font-medium text-[#E6EAF2] hover:border-[#5B9BD5] hover:text-white disabled:opacity-40 whitespace-nowrap shrink-0"
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Lanjutkan Sisa ({missingSceneIds.length})</span>
              </button>
            )}

            <button
              type="button"
              disabled={generating || project.scenes.length === 0}
              onClick={() =>
                runGenerationForScenes(
                  selectGenerateTargetIds(project.scenes, 'first-50'),
                  '1–50'
                )
              }
              title={`Generate prompt untuk adegan nomor 1 sampai ${Math.min(50, project.scenes.length)}`}
              className="inline-flex items-center gap-2 rounded-lg border border-[#5B9BD5] bg-[#16253A] px-4 py-2.5 text-xs font-semibold text-[#CBE2F8] transition-colors hover:bg-[#1E3350] hover:text-white disabled:opacity-50 whitespace-nowrap shrink-0 tabular-nums"
            >
              {generating && activeGenLabel === '1–50' ? (
                <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              <span>
                {generating && activeGenLabel === '1–50'
                  ? `Batch ${progress.currentBatch} dari ${progress.totalBatches}`
                  : `Generate 1–50${project.scenes.length > 0 && project.scenes.length < 50 ? ` (1–${project.scenes.length})` : ''}`}
              </span>
            </button>

            <button
              type="button"
              disabled={generating || project.scenes.length === 0}
              onClick={() =>
                runGenerationForScenes(
                  selectGenerateTargetIds(project.scenes, 'all'),
                  '1–Selesai'
                )
              }
              title={`Generate seluruh prompt dari adegan 1 sampai ${project.scenes.length}`}
              className="inline-flex items-center gap-2 rounded-lg bg-[#5B9BD5] px-5 py-2.5 text-xs font-semibold text-[#0B0D12] transition-colors hover:bg-[#73ACE0] disabled:opacity-50 whitespace-nowrap shrink-0 tabular-nums"
            >
              {generating && activeGenLabel === '1–Selesai' ? (
                <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              <span>
                {generating && activeGenLabel === '1–Selesai'
                  ? `Batch ${progress.currentBatch} dari ${progress.totalBatches}`
                  : `Generate 1–Selesai (${project.scenes.length} Prompt)`}
              </span>
            </button>
          </div>
        </div>

        {generating && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs text-[#B9CBE6] tabular-nums">
              <span>{progress.message || `Batch ${progress.currentBatch} dari ${progress.totalBatches}`}</span>
              <span>{progressPct}%</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-[#1C2233]">
              <div
                className="h-full rounded-full bg-[#5B9BD5] transition-all duration-300"
                style={{ width: `${Math.max(8, progressPct)}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {/* Error with Missing-IDs Retry */}
      {errorMsg && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#7F1D1D] bg-[#251317] px-4 py-3 text-sm text-[#FCA5A5]"
        >
          <div className="flex items-center gap-2.5">
            <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{errorMsg}</span>
          </div>
          <button
            type="button"
            disabled={generating}
            onClick={() =>
              runGenerationForScenes(
                missingIdsAfterRun.length > 0
                  ? missingIdsAfterRun
                  : missingSceneIds.length > 0
                    ? missingSceneIds
                    : undefined,
                'Sisa'
              )
            }
            className="inline-flex items-center gap-1.5 rounded-lg border border-[#991B1B] bg-[#3B181F] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#4C1E27] disabled:opacity-40 whitespace-nowrap shrink-0"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            <span>
              {missingIdsAfterRun.length > 0 || missingSceneIds.length > 0
                ? 'Lengkapi Adegan Kurang'
                : 'Coba lagi'}
            </span>
          </button>
        </div>
      )}

      {/* Fitur Salin & Download .txt Lengkap */}
      {project.scenes.length > 0 && (
        <div className="space-y-4 rounded-xl border border-[#1E2433] bg-[#12151E] p-5">
          {/* Format Salin Selector */}
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between border-b border-[#1D2230] pb-4">
            <div>
              <h2 className="text-sm font-semibold text-white">2. Alat Salin &amp; Download Prompt</h2>
              <p className="mt-0.5 text-xs text-[#8F9BB3]">
                Format yang dipilih berlaku untuk semua tombol Salin dan file Download .txt.
              </p>
            </div>

            <div
              role="radiogroup"
              aria-label="Format salin dan download prompt"
              className="flex flex-wrap items-center gap-1 rounded-lg border border-[#232A3B] bg-[#0C0F16] p-1"
            >
              <button
                type="button"
                role="radio"
                aria-checked={copyFormat === 'numbered-paragraph'}
                onClick={() => setCopyFormat('numbered-paragraph')}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                  copyFormat === 'numbered-paragraph'
                    ? 'bg-[#1D273B] text-white'
                    : 'text-[#8F9BB3] hover:text-white'
                }`}
              >
                Bernomor (1 paragraf + baris kosong)
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={copyFormat === 'plain-single-line'}
                onClick={() => setCopyFormat('plain-single-line')}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                  copyFormat === 'plain-single-line'
                    ? 'bg-[#1D273B] text-white'
                    : 'text-[#8F9BB3] hover:text-white'
                }`}
              >
                Tanpa Nomor (1 prompt per baris)
              </button>
            </div>
          </div>

          {/* Primary Copy Actions: Salin Semua, Separuh Pertama, Separuh Kedua, Terpilih, Download .txt */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleCopyAll}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#1D283A] border border-[#364A6B] px-3.5 py-2 text-xs font-semibold text-white hover:border-[#5B9BD5] whitespace-nowrap shrink-0 tabular-nums"
            >
              {copiedKey === 'all' ? (
                <Check className="h-3.5 w-3.5 text-[#68D391]" aria-hidden="true" />
              ) : (
                <Copy className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              <span>Salin Semua ({project.scenes.length})</span>
            </button>

            <button
              type="button"
              disabled={firstHalf.length === 0}
              onClick={handleCopyFirstHalf}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#272E40] bg-[#161B27] px-3 py-2 text-xs font-medium text-[#D2D8E6] hover:border-[#5B9BD5] hover:text-white disabled:opacity-40 whitespace-nowrap shrink-0 tabular-nums"
            >
              {copiedKey === 'first-half' ? (
                <Check className="h-3.5 w-3.5 text-[#68D391]" aria-hidden="true" />
              ) : (
                <Copy className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              <span>
                Salin Separuh Pertama (1–{firstHalf.length})
              </span>
            </button>

            <button
              type="button"
              disabled={secondHalf.length === 0}
              onClick={handleCopySecondHalf}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#272E40] bg-[#161B27] px-3 py-2 text-xs font-medium text-[#D2D8E6] hover:border-[#5B9BD5] hover:text-white disabled:opacity-40 whitespace-nowrap shrink-0 tabular-nums"
            >
              {copiedKey === 'second-half' ? (
                <Check className="h-3.5 w-3.5 text-[#68D391]" aria-hidden="true" />
              ) : (
                <Copy className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              <span>
                Salin Separuh Kedua ({firstHalf.length + 1}–{project.scenes.length})
              </span>
            </button>

            <button
              type="button"
              disabled={selectedIds.size === 0}
              onClick={handleCopySelected}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#272E40] bg-[#161B27] px-3 py-2 text-xs font-medium text-[#D2D8E6] hover:border-[#5B9BD5] hover:text-white disabled:opacity-40 whitespace-nowrap shrink-0 tabular-nums"
            >
              {copiedKey === 'selected' ? (
                <Check className="h-3.5 w-3.5 text-[#68D391]" aria-hidden="true" />
              ) : (
                <Copy className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              <span>Salin yang dipilih ({selectedIds.size})</span>
            </button>

            <button
              type="button"
              onClick={handleDownloadTxt}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#2A3142] bg-[#181D2B] px-3.5 py-2 text-xs font-medium text-[#E6EAF2] hover:border-[#5B9BD5] hover:text-white whitespace-nowrap shrink-0"
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Download .txt</span>
            </button>
          </div>

          {/* Salin Rentang (dari adegan ... sampai ...) */}
          <div className="flex flex-wrap items-center gap-2.5 border-t border-[#1D2230] pt-3 text-xs">
            <span className="font-medium text-[#D2D8E6]">Salin Rentang:</span>
            <label htmlFor="range-from" className="text-[#8F9BB3]">
              dari adegan
            </label>
            <input
              id="range-from"
              type="number"
              min={1}
              max={project.scenes.length}
              value={rangeFrom}
              onChange={(e) => setRangeFrom(Math.max(1, Number(e.target.value) || 1))}
              className="w-20 rounded-lg border border-[#272E40] bg-[#0C0F16] px-2.5 py-1.5 font-mono text-xs text-white tabular-nums focus:border-[#5B9BD5] focus:outline-none"
            />
            <label htmlFor="range-to" className="text-[#8F9BB3]">
              sampai
            </label>
            <input
              id="range-to"
              type="number"
              min={1}
              max={project.scenes.length}
              value={rangeTo}
              onChange={(e) =>
                setRangeTo(Math.max(1, Math.min(project.scenes.length, Number(e.target.value) || 1)))
              }
              className="w-20 rounded-lg border border-[#272E40] bg-[#0C0F16] px-2.5 py-1.5 font-mono text-xs text-white tabular-nums focus:border-[#5B9BD5] focus:outline-none"
            />
            <button
              type="button"
              onClick={handleCopyRange}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#2B3449] bg-[#181E2D] px-3 py-1.5 text-xs font-medium text-white hover:border-[#5B9BD5] whitespace-nowrap shrink-0"
            >
              {copiedKey === 'range' ? (
                <Check className="h-3.5 w-3.5 text-[#68D391]" aria-hidden="true" />
              ) : (
                <Copy className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              <span>Salin Rentang</span>
            </button>
          </div>

          {/* Batch Header + Salin Batch per 24 Prompt */}
          <div className="space-y-3 border-t border-[#1D2230] pt-3">
            <div>
              <label htmlFor="batch-header-input" className="block text-xs font-medium text-[#9AA5BC]">
                Header Salin Batch (opsional, disertakan di atas setiap Salin Batch 24 prompt)
              </label>
              <input
                id="batch-header-input"
                type="text"
                value={project.batchHeader}
                onChange={(e) => onUpdate({ batchHeader: e.target.value })}
                className="mt-1.5 w-full rounded-lg border border-[#272E40] bg-[#0C0F16] px-3 py-2 text-xs text-white focus:border-[#5B9BD5] focus:outline-none"
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-[#8F9BB3] mr-1">Salin Batch (per 24 prompt):</span>
              {copyBatches.map((b) => {
                const key = `batch-${b.index}`;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => handleCopyBatch(b.index, b.start, b.end)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-[#272E40] bg-[#0E121B] px-3 py-1.5 text-xs font-medium text-[#D2D8E6] hover:border-[#5B9BD5] hover:text-white tabular-nums whitespace-nowrap shrink-0"
                  >
                    {copiedKey === key ? (
                      <Check className="h-3.5 w-3.5 text-[#68D391]" aria-hidden="true" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                    <span>
                      Salin Batch {b.index} ({b.start}–{b.end})
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Paginated Prompt List (12 items per page) with Checkboxes */}
      {project.scenes.length > 0 ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[#8F9BB3]">
            <button
              type="button"
              onClick={handleToggleSelectPage}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#242B3D] bg-[#121622] px-3 py-1.5 text-xs font-medium text-[#D2D8E6] hover:border-[#5B9BD5] hover:text-white"
            >
              {allOnPageSelected ? (
                <CheckSquare className="h-3.5 w-3.5 text-[#5B9BD5]" aria-hidden="true" />
              ) : (
                <Square className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              <span>
                {allOnPageSelected ? 'Batal Pilih Halaman Ini' : 'Pilih Semua di Halaman Ini'}
              </span>
            </button>

            {selectedIds.size > 0 && (
              <div className="flex items-center gap-2">
                <span className="tabular-nums text-white font-medium">
                  {selectedIds.size} adegan dipilih
                </span>
                <button
                  type="button"
                  onClick={() => setSelectedIds(new Set())}
                  className="text-xs text-[#8F9BB3] underline hover:text-white"
                >
                  Hapus pilihan
                </button>
              </div>
            )}
          </div>

          <div className="space-y-4">
            {pagedScenes.map((scene) => {
              const code = formatSceneCode(scene.id);
              const fullPrompt = buildFinalSingleLinePrompt(scene, assemblyConfig);
              const showCrowd = detectCrowdInText(scene.text);
              const isRegen = regeneratingId === scene.id;
              const isChecked = selectedIds.has(scene.id);
              const hasPrompt = Boolean(scene.scenePrompt?.trim());
              const dur = Math.max(0, scene.end - scene.start);

              return (
                <article
                  key={scene.id}
                  className={`overflow-hidden rounded-xl border transition-colors ${
                    isChecked
                      ? 'border-[#5B9BD5] bg-[#141C2B]'
                      : 'border-[#1E2433] bg-[#12151E]'
                  }`}
                >
                  {/* BAGIAN ATAS: Hasil Timestamp dari Kotak 3 */}
                  <div className="p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2.5 text-xs tabular-nums">
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => toggleSelectScene(scene.id)}
                          aria-label={`Pilih ${code}`}
                          className="h-4 w-4 shrink-0 rounded accent-[#5B9BD5] cursor-pointer"
                        />
                        <span className="inline-flex h-6 min-w-[28px] items-center justify-center rounded-md bg-[#1B2B42] px-2 font-mono text-xs font-bold text-[#7FB9EE]">
                          #{scene.id}
                        </span>
                        <span className="font-mono text-xs font-semibold text-white">
                          {formatTimePrecise(scene.start)} – {formatTimePrecise(scene.end)}
                        </span>
                        <span className="font-mono text-[11px] text-[#8F9BB3]">
                          ({dur.toFixed(1)} dtk)
                        </span>
                        <span aria-hidden="true" className="text-[#4B556B]">
                          ·
                        </span>
                        <span className="font-mono text-[11px] text-[#7D88A1]">
                          Batch {Math.floor((scene.id - 1) / COPY_BATCH_SIZE) + 1}
                        </span>
                        {scene.shotType && (
                          <>
                            <span aria-hidden="true" className="text-[#4B556B]">
                              ·
                            </span>
                            <span className="text-[#B6C0D4]">{scene.shotType}</span>
                          </>
                        )}
                        <span aria-hidden="true" className="text-[#4B556B]">
                          ·
                        </span>
                        {showCrowd ? (
                          <span className="inline-flex items-center gap-1 font-medium text-[#F5C451]">
                            <Users className="h-3 w-3" aria-hidden="true" />
                            CROWD
                          </span>
                        ) : (
                          <span className="font-medium text-[#68D391]">Solo (Tanpa [CROWD])</span>
                        )}
                      </div>

                      <span
                        className={`text-[11px] font-medium ${
                          hasPrompt ? 'text-[#68D391]' : 'text-[#8F9BB3]'
                        }`}
                      >
                        {hasPrompt ? 'Prompt siap' : 'Belum digenerate'}
                      </span>
                    </div>

                    <p className="mt-2.5 pl-6 text-sm leading-relaxed text-[#E6EAF2]">
                      &ldquo;{scene.text || '—'}&rdquo;
                    </p>
                  </div>

                  {/* BAGIAN BAWAH: Prompt Generate */}
                  <div className="border-t border-[#1D2433] bg-[#0D1018] p-4 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <label
                        htmlFor={`scene-prompt-edit-${scene.id}`}
                        className="text-xs font-semibold text-[#9EC5EA]"
                      >
                        Prompt Generate #{scene.id}
                      </label>

                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          onClick={() => handleRegenerateSingle(scene)}
                          disabled={isRegen || generating}
                          aria-label={`Regenerate prompt ${code}`}
                          className="inline-flex items-center gap-1 rounded-md border border-[#272E40] bg-[#171C28] px-2.5 py-1 text-[11px] font-medium text-[#D2D8E6] hover:border-[#5B9BD5] hover:text-white disabled:opacity-40"
                        >
                          <RefreshCw
                            className={`h-3 w-3 ${isRegen ? 'animate-spin' : ''}`}
                            aria-hidden="true"
                          />
                          <span>Regenerate</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleCopySingle(scene)}
                          aria-label={`Salin prompt ${code}`}
                          className="inline-flex items-center gap-1 rounded-md border border-[#272E40] bg-[#171C28] px-2.5 py-1 text-[11px] font-medium text-[#D2D8E6] hover:border-[#5B9BD5] hover:text-white"
                        >
                          {copiedKey === `scene-${scene.id}` ? (
                            <>
                              <Check className="h-3 w-3 text-[#68D391]" aria-hidden="true" />
                              <span>Tersalin</span>
                            </>
                          ) : (
                            <>
                              <Copy className="h-3 w-3" aria-hidden="true" />
                              <span>Salin</span>
                            </>
                          )}
                        </button>
                      </div>
                    </div>

                    <textarea
                      id={`scene-prompt-edit-${scene.id}`}
                      rows={2}
                      value={scene.scenePrompt || ''}
                      onChange={(e) => {
                        const updated = project.scenes.map((s) =>
                          s.id === scene.id ? { ...s, scenePrompt: e.target.value } : s
                        );
                        onUpdate({ scenes: updated });
                      }}
                      placeholder="Klik 'Generate 1–50' atau 'Generate 1–Selesai' di atas, atau ketik deskripsi [SCENE] bahasa Inggris..."
                      className="w-full rounded-lg border border-[#232A3B] bg-[#0A0D13] p-2.5 text-xs leading-relaxed text-white placeholder-[#545F75] focus:border-[#5B9BD5] focus:outline-none"
                    />

                    <pre className="max-h-28 overflow-y-auto whitespace-pre-wrap rounded-lg border border-[#1B202E] bg-[#080A0F] p-2.5 font-mono text-[11px] leading-relaxed text-[#9DA9C0]">
                      {fullPrompt}
                    </pre>
                  </div>
                </article>
              );
            })}
          </div>

          {/* Pagination Controls */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#1E2433] bg-[#0F121A] px-4 py-3 text-xs text-[#8F9BB3] tabular-nums">
            <span>
              Menampilkan {(safePage - 1) * PAGE_SIZE + 1}–
              {Math.min(safePage * PAGE_SIZE, project.scenes.length)} dari {project.scenes.length}{' '}
              prompt (12 per halaman)
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={safePage <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="inline-flex items-center gap-1 rounded-lg border border-[#272E40] bg-[#151A26] px-2.5 py-1.5 text-xs font-medium text-[#D2D8E6] hover:text-white disabled:opacity-40"
              >
                <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Sebelumnya</span>
              </button>
              <span className="px-2 font-medium text-white">
                Halaman {safePage} / {totalPages}
              </span>
              <button
                type="button"
                disabled={safePage >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                className="inline-flex items-center gap-1 rounded-lg border border-[#272E40] bg-[#151A26] px-2.5 py-1.5 text-xs font-medium text-[#D2D8E6] hover:text-white disabled:opacity-40"
              >
                <span>Berikutnya</span>
                <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-[#1E2433] bg-[#12151E] p-10 text-center">
          <p className="text-sm font-medium text-white">Belum ada adegan dari Kotak 3.</p>
          <p className="mt-1 text-xs text-[#8F9BB3]">
            Buat timestamp adegan terlebih dahulu di Kotak 3 agar prompt gambar bisa dibuat.
          </p>
        </div>
      )}
    </section>
  );
};
