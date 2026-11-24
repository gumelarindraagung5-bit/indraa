import React, { useState } from 'react';
import {
  Sparkles,
  Copy,
  Check,
  RefreshCw,
  AlertCircle,
  ArrowLeft,
} from 'lucide-react';
import type { StudioProject, YouTubePackage } from '../types/project';
import { copyToClipboard, fetchWithRetry } from '../utils/apiClient';
import { buildChaptersFromScenes } from '../utils/timelineMath';

interface Step6Props {
  project: StudioProject;
  onUpdate: (patch: Partial<StudioProject>) => void;
  onPrev: () => void;
}

interface RawYouTubeResponse {
  packageData: {
    thumbnailPrompts: Array<{ concept: string; overlayText: string; prompt: string }>;
    titleVariants: Array<{ title: string; ctrReason: string }>;
    description: string;
    chapterPicks: Array<{ sceneId: number; title: string }>;
    tags: string[];
    hashtags: string[];
    pinnedComment: string;
  };
}

export const Step6YouTubePackage: React.FC<Step6Props> = ({
  project,
  onUpdate,
  onPrev,
}) => {
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const pkg = project.youtubePackage;

  const markCopied = (key: string) => {
    setCopiedKey(key);
    setTimeout(() => setCopiedKey((curr) => (curr === key ? null : curr)), 1800);
  };

  const handleCopy = async (key: string, text: string) => {
    await copyToClipboard(text);
    markCopied(key);
  };

  const handleGeneratePackage = async () => {
    if (!project.topic.trim() && !project.selectedTitle.trim() && !project.script.trim()) {
      setErrorMsg('Isi topik, judul, atau naskah di Kotak 1 terlebih dahulu sebelum membuat Paket YouTube.');
      return;
    }

    setErrorMsg(null);
    setLoading(true);
    try {
      const data = await fetchWithRetry<RawYouTubeResponse>(
        '/api/ai/youtube-package',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            topic: project.topic,
            title: project.selectedTitle,
            script: project.script || project.referenceScript,
            scenes: project.scenes.map((s) => ({
              id: s.id,
              start: s.start,
              end: s.end,
              text: s.text,
            })),
            styleText: project.stylePrompt,
            characterText: project.characterPrompt,
          }),
        },
        { maxRetries: 2 }
      );

      const raw = data.packageData;
      // Format chapters deterministically from real Kotak 3 timestamps (first chapter 00:00)
      const chapters = buildChaptersFromScenes(raw.chapterPicks || [], project.scenes);

      const nextPkg: YouTubePackage = {
        thumbnailPrompts: (raw.thumbnailPrompts || []).slice(0, 3),
        titleVariants: (raw.titleVariants || []).slice(0, 5),
        description: raw.description || '',
        chapters,
        tags: raw.tags || [],
        hashtags: raw.hashtags || [],
        pinnedComment: raw.pinnedComment || '',
      };

      onUpdate({ youtubePackage: nextPkg });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Gagal membuat Paket YouTube.');
    } finally {
      setLoading(false);
    }
  };

  const formattedChaptersText = pkg
    ? pkg.chapters.map((c) => `${c.timeFormatted} ${c.title}`).join('\n')
    : '';

  return (
    <section className="mx-auto max-w-[1160px] space-y-6" aria-labelledby="step6-heading">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between border-b border-[#1D2230] pb-5">
        <div>
          <p className="text-xs font-medium text-[#5B9BD5]">Kotak 6 dari 6</p>
          <h1 id="step6-heading" className="mt-1 text-2xl font-bold tracking-tight text-white">
            Thumbnail, Judul, dan Deskripsi YouTube
          </h1>
          <p className="mt-1 text-sm text-[#8F9BB3]">
            Buat seluruh kelengkapan publikasi YouTube klik-tinggi beserta chapter otomatis dari timestamp asli Kotak 3.
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={onPrev}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[#2A3142] bg-[#141824] px-3.5 py-2 text-xs font-medium text-[#D2D8E6] hover:text-white whitespace-nowrap shrink-0"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Kotak 5</span>
          </button>

          <button
            type="button"
            onClick={handleGeneratePackage}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-lg bg-[#5B9BD5] px-5 py-2.5 text-xs font-semibold text-[#0B0D12] transition-colors hover:bg-[#73ACE0] disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            {loading ? (
              <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Sparkles className="h-4 w-4" aria-hidden="true" />
            )}
            <span>{loading ? 'Menyusun Paket YouTube...' : 'Buat Paket YouTube'}</span>
          </button>
        </div>
      </div>

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
            onClick={handleGeneratePackage}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[#991B1B] bg-[#3B181F] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#4C1E27]"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Coba lagi</span>
          </button>
        </div>
      )}

      {pkg ? (
        <div className="space-y-6">
          {/* 1. 3 Prompt Thumbnail 16:9 */}
          <div className="space-y-3 rounded-xl border border-[#1E2433] bg-[#12151E] p-5">
            <h2 className="text-base font-semibold text-white">
              1. 3 Prompt Thumbnail 16:9 Klik-Tinggi
            </h2>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              {pkg.thumbnailPrompts.map((item, idx) => {
                const key = `thumb-${idx}`;
                return (
                  <div
                    key={key}
                    className="flex flex-col justify-between rounded-lg border border-[#232A3B] bg-[#0D1017] p-4"
                  >
                    <div>
                      <div className="flex items-start justify-between gap-2">
                        <h3 className="text-sm font-semibold text-white">{item.concept}</h3>
                        <button
                          type="button"
                          aria-label={`Salin prompt thumbnail ${idx + 1}`}
                          onClick={() => handleCopy(key, item.prompt)}
                          className="inline-flex items-center gap-1 rounded-md border border-[#2B3347] bg-[#171C28] px-2.5 py-1 text-[11px] font-medium text-[#D2D8E6] hover:border-[#5B9BD5] hover:text-white shrink-0"
                        >
                          {copiedKey === key ? (
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
                      <p className="mt-1.5 text-xs text-[#F5C451] font-medium">
                        Teks di thumbnail: &ldquo;{item.overlayText}&rdquo;
                      </p>
                      <p className="mt-2.5 font-mono text-[11px] leading-relaxed text-[#A8B2C7]">
                        {item.prompt}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* 2. 5 Varian Judul & Alasan CTR */}
          <div className="space-y-3 rounded-xl border border-[#1E2433] bg-[#12151E] p-5">
            <h2 className="text-base font-semibold text-white">
              2. 5 Varian Judul &amp; Alasan CTR
            </h2>
            <div className="divide-y divide-[#1E2433] rounded-lg border border-[#1E2433] bg-[#0D1017]">
              {pkg.titleVariants.map((item, idx) => {
                const key = `title-${idx}`;
                return (
                  <div
                    key={key}
                    className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-white">{item.title}</p>
                      <p className="mt-0.5 text-xs text-[#8F9BB3]">{item.ctrReason}</p>
                    </div>
                    <button
                      type="button"
                      aria-label={`Salin varian judul ${idx + 1}`}
                      onClick={() => handleCopy(key, item.title)}
                      className="inline-flex items-center gap-1.5 self-start rounded-md border border-[#2B3347] bg-[#171C28] px-3 py-1.5 text-xs font-medium text-[#D2D8E6] hover:border-[#5B9BD5] hover:text-white shrink-0 sm:self-auto"
                    >
                      {copiedKey === key ? (
                        <>
                          <Check className="h-3.5 w-3.5 text-[#68D391]" aria-hidden="true" />
                          <span>Tersalin</span>
                        </>
                      ) : (
                        <>
                          <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>Salin</span>
                        </>
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          {/* 3 & 4. Deskripsi YouTube + Chapter Timestamp */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
            <div className="space-y-3 rounded-xl border border-[#1E2433] bg-[#12151E] p-5 lg:col-span-7">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-base font-semibold text-white">3. Deskripsi YouTube (SEO)</h2>
                <button
                  type="button"
                  onClick={() => handleCopy('description', pkg.description)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-[#2B3347] bg-[#171C28] px-3 py-1.5 text-xs font-medium text-[#D2D8E6] hover:border-[#5B9BD5] hover:text-white shrink-0"
                >
                  {copiedKey === 'description' ? (
                    <>
                      <Check className="h-3.5 w-3.5 text-[#68D391]" aria-hidden="true" />
                      <span>Tersalin</span>
                    </>
                  ) : (
                    <>
                      <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>Salin Deskripsi</span>
                    </>
                  )}
                </button>
              </div>
              <div className="whitespace-pre-wrap rounded-lg border border-[#232A3B] bg-[#0D1017] p-4 text-sm leading-relaxed text-[#D8DFEE]">
                {pkg.description}
              </div>
            </div>

            <div className="space-y-3 rounded-xl border border-[#1E2433] bg-[#12151E] p-5 lg:col-span-5">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-base font-semibold text-white">
                  4. Chapter Timestamp
                </h2>
                <button
                  type="button"
                  disabled={!formattedChaptersText}
                  onClick={() => handleCopy('chapters', formattedChaptersText)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-[#2B3347] bg-[#171C28] px-3 py-1.5 text-xs font-medium text-[#D2D8E6] hover:border-[#5B9BD5] hover:text-white disabled:opacity-40 shrink-0"
                >
                  {copiedKey === 'chapters' ? (
                    <>
                      <Check className="h-3.5 w-3.5 text-[#68D391]" aria-hidden="true" />
                      <span>Tersalin</span>
                    </>
                  ) : (
                    <>
                      <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>Salin Chapter</span>
                    </>
                  )}
                </button>
              </div>
              {pkg.chapters.length > 0 ? (
                <div className="rounded-lg border border-[#232A3B] bg-[#0D1017] p-4 font-mono text-xs leading-7 text-[#D8DFEE] tabular-nums">
                  {pkg.chapters.map((ch) => (
                    <div key={`${ch.sceneId}-${ch.timeFormatted}`} className="flex gap-3">
                      <span className="font-semibold text-[#5B9BD5] shrink-0">
                        {ch.timeFormatted}
                      </span>
                      <span className="font-sans text-[#E6EAF2]">{ch.title}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-[#8F9BB3]">
                  Belum ada data adegan di Kotak 3 untuk memformat chapter timestamp.
                </p>
              )}
            </div>
          </div>

          {/* 5. Tag, Hashtag, dan Komentar Disematkan */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <div className="space-y-4 rounded-xl border border-[#1E2433] bg-[#12151E] p-5">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-base font-semibold text-white">5. Tag &amp; Hashtag</h2>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleCopy('tags', pkg.tags.join(', '))}
                    className="inline-flex items-center gap-1 rounded-md border border-[#2B3347] bg-[#171C28] px-2.5 py-1 text-xs font-medium text-[#D2D8E6] hover:border-[#5B9BD5] hover:text-white"
                  >
                    {copiedKey === 'tags' ? (
                      <Check className="h-3 w-3 text-[#68D391]" aria-hidden="true" />
                    ) : (
                      <Copy className="h-3 w-3" aria-hidden="true" />
                    )}
                    <span>Salin Tag</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleCopy('hashtags', pkg.hashtags.join(' '))}
                    className="inline-flex items-center gap-1 rounded-md border border-[#2B3347] bg-[#171C28] px-2.5 py-1 text-xs font-medium text-[#D2D8E6] hover:border-[#5B9BD5] hover:text-white"
                  >
                    {copiedKey === 'hashtags' ? (
                      <Check className="h-3 w-3 text-[#68D391]" aria-hidden="true" />
                    ) : (
                      <Copy className="h-3 w-3" aria-hidden="true" />
                    )}
                    <span>Salin Hashtag</span>
                  </button>
                </div>
              </div>

              <div className="space-y-3">
                <div>
                  <p className="text-xs font-medium text-[#8F9BB3]">Tag YouTube (pisahkan koma):</p>
                  <p className="mt-1 rounded-lg border border-[#232A3B] bg-[#0D1017] p-3 text-xs leading-relaxed text-[#D8DFEE]">
                    {pkg.tags.join(', ')}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-medium text-[#8F9BB3]">Hashtag:</p>
                  <p className="mt-1 rounded-lg border border-[#232A3B] bg-[#0D1017] p-3 font-mono text-xs text-[#5B9BD5]">
                    {pkg.hashtags.join(' ')}
                  </p>
                </div>
              </div>
            </div>

            <div className="flex flex-col justify-between space-y-4 rounded-xl border border-[#1E2433] bg-[#12151E] p-5">
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-base font-semibold text-white">Ide Komentar Disematkan</h2>
                  <button
                    type="button"
                    onClick={() => handleCopy('pinned', pkg.pinnedComment)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-[#2B3347] bg-[#171C28] px-3 py-1.5 text-xs font-medium text-[#D2D8E6] hover:border-[#5B9BD5] hover:text-white"
                  >
                    {copiedKey === 'pinned' ? (
                      <>
                        <Check className="h-3.5 w-3.5 text-[#68D391]" aria-hidden="true" />
                        <span>Tersalin</span>
                      </>
                    ) : (
                      <>
                        <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>Salin Komentar</span>
                      </>
                    )}
                  </button>
                </div>
                <div className="rounded-lg border border-[#232A3B] bg-[#0D1017] p-4 text-sm leading-relaxed text-[#E6EAF2]">
                  {pkg.pinnedComment}
                </div>
              </div>
              <p className="text-xs text-[#7C879E]">
                Sematkan komentar pertanyaan terbuka ini segera setelah video tayang untuk memicu interaksi awal.
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-[#1E2433] bg-[#12151E] p-12 text-center">
          <p className="text-base font-semibold text-white">Siap untuk publikasi YouTube?</p>
          <p className="mx-auto mt-1.5 max-w-lg text-xs leading-relaxed text-[#8F9BB3]">
            Klik tombol &ldquo;Buat Paket YouTube&rdquo; di atas untuk menghasilkan 3 prompt thumbnail 16:9, 5 varian judul CTR tinggi, deskripsi SEO, chapter timestamp dari Kotak 3, tag, hashtag, dan ide komentar disematkan sekaligus.
          </p>
        </div>
      )}
    </section>
  );
};
