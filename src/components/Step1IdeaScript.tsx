import React, { useMemo, useRef, useState } from 'react';
import {
  Mic,
  MicOff,
  Sparkles,
  Lightbulb,
  Copy,
  Check,
  RefreshCw,
  ArrowRight,
  AlertCircle,
} from 'lucide-react';
import {
  NARRATION_STYLES,
  type NarrationStyleId,
  type StudioProject,
  type TitleSuggestion,
  type VideoIdeaSuggestion,
} from '../types/project';
import { copyToClipboard, fetchWithRetry } from '../utils/apiClient';

const IDEA_CATEGORIES = [
  { id: 'semua', label: 'Semua Campuran' },
  { id: 'Fakta Unik', label: 'Fakta Unik' },
  { id: 'Bagaimana Jika', label: 'Bagaimana Jika' },
  { id: 'Motivasi & Psikologi', label: 'Motivasi & Psikologi' },
  { id: 'Sains & Sejarah Unik', label: 'Sains & Sejarah' },
] as const;

interface Step1Props {
  project: StudioProject;
  onUpdate: (patch: Partial<StudioProject>) => void;
  onNext: () => void;
}

interface SpeechRecognitionInstance {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((ev: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((ev: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

export const Step1IdeaScript: React.FC<Step1Props> = ({ project, onUpdate, onNext }) => {
  const [loadingIdeas, setLoadingIdeas] = useState(false);
  const [ideaCategory, setIdeaCategory] = useState<string>('semua');
  const [loadingTitles, setLoadingTitles] = useState(false);
  const [loadingScript, setLoadingScript] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [retryAction, setRetryAction] = useState<'ideas' | 'titles' | 'script' | null>(null);
  const [scriptError, setScriptError] = useState<string | null>(null);
  const [scriptCanRetry, setScriptCanRetry] = useState(false);
  const [scriptSuccessMsg, setScriptSuccessMsg] = useState<string | null>(null);
  const [isListening, setIsListening] = useState(false);
  const [micNote, setMicNote] = useState<string | null>(null);
  const [copiedScript, setCopiedScript] = useState(false);
  const [copiedVoice, setCopiedVoice] = useState(false);

  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const scriptEditorRef = useRef<HTMLTextAreaElement | null>(null);

  const activeStyle = useMemo(
    () => NARRATION_STYLES.find((s) => s.id === project.narrationStyle) || NARRATION_STYLES[0],
    [project.narrationStyle]
  );

  const scriptStats = useMemo(() => {
    const words = project.script
      .trim()
      .split(/\s+/)
      .filter(Boolean).length;
    const totalSeconds = Math.round((words / 170) * 60);
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return { words, mins, secs };
  }, [project.script]);

  const handleToggleMic = () => {
    if (isListening && recognitionRef.current) {
      recognitionRef.current.stop();
      setIsListening(false);
      return;
    }

    const win = window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionInstance;
      webkitSpeechRecognition?: new () => SpeechRecognitionInstance;
    };
    const SpeechRec = win.SpeechRecognition || win.webkitSpeechRecognition;

    if (!SpeechRec) {
      setMicNote('Browser ini belum mendukung Web Speech API untuk input suara.');
      return;
    }

    setMicNote(null);
    const rec = new SpeechRec();
    rec.lang = 'id-ID';
    rec.continuous = false;
    rec.interimResults = false;

    rec.onresult = (event) => {
      const lastIdx = event.results.length - 1;
      const transcript = event.results[lastIdx]?.[0]?.transcript?.trim();
      if (transcript) {
        const nextTopic = project.topic.trim()
          ? `${project.topic.trim()} ${transcript}`
          : transcript;
        onUpdate({ topic: nextTopic });
      }
    };

    rec.onerror = (ev) => {
      setIsListening(false);
      if (ev.error === 'not-allowed') {
        setMicNote('Izin mikrofon ditolak. Aktifkan izin mikrofon di browser Anda.');
      } else {
        setMicNote(`Gagal menangkap suara (${ev.error}). Coba lagi atau ketik manual.`);
      }
    };

    rec.onend = () => {
      setIsListening(false);
    };

    recognitionRef.current = rec;
    setIsListening(true);
    rec.start();
  };

  const handleGenerateIdeas = async (avoidPrevious = false) => {
    setErrorMsg(null);
    setRetryAction(null);
    setLoadingIdeas(true);
    try {
      const existingIdeas = Array.isArray(project.ideaSuggestions)
        ? project.ideaSuggestions.map((i) => i.idea)
        : [];
      const data = await fetchWithRetry<{ ideas: VideoIdeaSuggestion[] }>(
        '/api/ai/ideas',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            category: ideaCategory,
            seedHint: project.topic.trim() || undefined,
            excludeIdeas: avoidPrevious ? existingIdeas : [],
          }),
        },
        { maxRetries: 2 }
      );
      const list = Array.isArray(data.ideas) ? data.ideas : [];
      if (list.length === 0) {
        throw new Error('AI belum mengembalikan daftar ide. Silakan coba lagi.');
      }
      onUpdate({ ideaSuggestions: list });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Gagal membuat 10 ide video dengan AI.');
      setRetryAction('ideas');
    } finally {
      setLoadingIdeas(false);
    }
  };

  const handleGenerateTitles = async () => {
    if (!project.topic.trim()) {
      setErrorMsg('Tuliskan topik atau ide video terlebih dahulu sebelum membuat 5 judul.');
      setRetryAction(null);
      return;
    }

    setErrorMsg(null);
    setRetryAction(null);
    setLoadingTitles(true);
    try {
      const data = await fetchWithRetry<{ titles: TitleSuggestion[] }>(
        '/api/ai/titles',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ topic: project.topic.trim() }),
        },
        { maxRetries: 2 }
      );
      const list = Array.isArray(data.titles) ? data.titles : [];
      onUpdate({
        titleSuggestions: list,
        selectedTitle: project.selectedTitle || list[0]?.title || '',
      });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Gagal membuat judul dengan AI.');
      setRetryAction('titles');
    } finally {
      setLoadingTitles(false);
    }
  };

  const handleGenerateScript = async () => {
    if (!project.topic.trim() && !project.selectedTitle.trim()) {
      setScriptError(
        'Isi topik di Bagian 1 atau tulis judul video terlebih dahulu sebelum membuat naskah narasi.'
      );
      setScriptCanRetry(false);
      setScriptSuccessMsg(null);
      return;
    }

    setErrorMsg(null);
    setRetryAction(null);
    setScriptError(null);
    setScriptCanRetry(false);
    setScriptSuccessMsg(null);
    setLoadingScript(true);
    try {
      const data = await fetchWithRetry<{ script: string }>(
        '/api/ai/script',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            topic: project.topic.trim(),
            title: project.selectedTitle.trim(),
            styleId: project.narrationStyle,
            styleDescription: activeStyle.aiDescription,
            customInstruction: project.customStyleInstruction.trim(),
            durationMinutes: project.targetDurationMinutes,
            targetWords: project.targetWordCount,
          }),
        },
        { maxRetries: 1, baseDelayMs: 1000 }
      );
      const generatedScript = (data.script || '').trim();
      if (!generatedScript) {
        throw new Error(
          'AI mengembalikan naskah kosong. Silakan klik "Buat Naskah Narasi" sekali lagi.'
        );
      }

      const shouldSyncRef =
        !project.referenceScript.trim() || project.referenceScript === project.script;

      onUpdate({
        script: generatedScript,
        ...(shouldSyncRef ? { referenceScript: generatedScript } : {}),
      });

      const generatedWords = generatedScript.split(/\s+/).filter(Boolean).length;
      setScriptSuccessMsg(
        `Naskah berhasil dibuat (${generatedWords.toLocaleString('id-ID')} kata). Lihat dan edit hasilnya di Bagian 3 di bawah.`
      );
      requestAnimationFrame(() => {
        scriptEditorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Gagal membuat naskah narasi.';
      setScriptError(message);
      setScriptCanRetry(true);
    } finally {
      setLoadingScript(false);
    }
  };

  const handleDurationChange = (minutes: number) => {
    const safeMin = Math.max(1, Math.min(30, minutes || 1));
    onUpdate({
      targetDurationMinutes: safeMin,
      targetWordCount: safeMin * 170,
    });
  };

  const handleCopyScript = async () => {
    if (!project.script.trim()) return;
    await copyToClipboard(project.script);
    setCopiedScript(true);
    setTimeout(() => setCopiedScript(false), 1800);
  };

  const handleCopyVoiceInstruction = async () => {
    await copyToClipboard(activeStyle.voiceInstruction);
    setCopiedVoice(true);
    setTimeout(() => setCopiedVoice(false), 1800);
  };

  return (
    <section className="mx-auto max-w-[1160px] space-y-8" aria-labelledby="step1-heading">
      {/* Header */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between border-b border-[#1D2230] pb-5">
        <div>
          <p className="text-xs font-medium text-[#5B9BD5]">Kotak 1 dari 6</p>
          <h1 id="step1-heading" className="mt-1 text-2xl font-bold tracking-tight text-white">
            Ide, Judul, dan Naskah Narasi
          </h1>
          <p className="mt-1 text-sm text-[#8F9BB3]">
            Tentukan topik edukasi stickman, pilih judul pemancing klik, lalu buat naskah siap baca.
          </p>
        </div>
        <button
          type="button"
          onClick={onNext}
          className="inline-flex items-center gap-2 self-start rounded-lg bg-[#5B9BD5] px-4 py-2 text-xs font-semibold text-[#0B0D12] transition-colors hover:bg-[#73ACE0] whitespace-nowrap shrink-0 sm:self-auto"
        >
          <span>Lanjut ke Kotak 2</span>
          <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>

      {/* Error Alert */}
      {errorMsg && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#7F1D1D] bg-[#251317] px-4 py-3 text-sm text-[#FCA5A5]"
        >
          <div className="flex items-center gap-2.5">
            <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{errorMsg}</span>
          </div>
          {retryAction && (
            <button
              type="button"
              onClick={
                retryAction === 'ideas'
                  ? () => handleGenerateIdeas(false)
                  : retryAction === 'titles'
                    ? handleGenerateTitles
                    : handleGenerateScript
              }
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#991B1B] bg-[#3B181F] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#4C1E27]"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Coba lagi</span>
            </button>
          )}
        </div>
      )}

      {/* 1. Topik & Ide + Mic */}
      <div className="space-y-3 rounded-xl border border-[#1E2433] bg-[#12151E] p-5">
        <div className="flex flex-col gap-0.5 sm:flex-row sm:items-center sm:justify-between sm:gap-2">
          <label htmlFor="topic-input" className="text-sm font-semibold text-white">
            1. Topik atau Ide Video
          </label>
          <span className="text-xs text-[#7C879E]">Ketik ide atau ucapkan lewat mikrofon (id-ID)</span>
        </div>

        <div className="flex flex-col gap-2.5 sm:flex-row">
          <input
            id="topic-input"
            type="text"
            value={project.topic}
            onChange={(e) => {
              if (scriptError) setScriptError(null);
              onUpdate({ topic: e.target.value });
            }}
            placeholder="Contoh: Kenapa waktu terasa makin cepat saat kita semakin dewasa?"
            className="flex-1 rounded-lg border border-[#272E40] bg-[#0C0F16] px-3.5 py-2.5 text-sm text-white placeholder-[#5C667C] focus:border-[#5B9BD5] focus:outline-none"
          />
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={handleToggleMic}
              aria-label={isListening ? 'Hentikan rekaman suara' : 'Rekam ide lewat mikrofon'}
              className={`inline-flex items-center gap-2 rounded-lg border px-3.5 py-2.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                isListening
                  ? 'border-[#DC2626] bg-[#3A151B] text-[#FCA5A5]'
                  : 'border-[#2B3347] bg-[#181D2B] text-[#D2D8E6] hover:border-[#3E4963] hover:text-white'
              }`}
            >
              {isListening ? (
                <>
                  <MicOff className="h-4 w-4" aria-hidden="true" />
                  <span>Mendengarkan...</span>
                </>
              ) : (
                <>
                  <Mic className="h-4 w-4" aria-hidden="true" />
                  <span>Mic (ID)</span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={handleGenerateTitles}
              disabled={loadingTitles}
              className="inline-flex items-center gap-2 rounded-lg bg-[#5B9BD5] px-4 py-2.5 text-xs font-semibold text-[#0B0D12] transition-colors hover:bg-[#73ACE0] disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              {loadingTitles ? (
                <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              <span>{loadingTitles ? 'Membuat Judul...' : 'Buat 5 Judul'}</span>
            </button>
          </div>
        </div>

        {micNote && <p className="text-xs text-[#F5C451]">{micNote}</p>}

        {/* Generator 10 Ide Video Viral (AI) */}
        <div className="space-y-3 rounded-lg border border-[#1E2536] bg-[#0D1017] p-3.5">
          <div className="flex flex-col gap-2.5 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter kategori ide video">
              <span className="mr-1 text-xs font-medium text-[#9AA5BC]">Inspirasi AI:</span>
              {IDEA_CATEGORIES.map((cat) => {
                const active = ideaCategory === cat.id;
                return (
                  <button
                    key={cat.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setIdeaCategory(cat.id)}
                    className={`rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors whitespace-nowrap ${
                      active
                        ? 'border-[#5B9BD5] bg-[#172336] text-white'
                        : 'border-[#232A3B] bg-[#12151E] text-[#8F9BB3] hover:border-[#343E57] hover:text-white'
                    }`}
                  >
                    {cat.label}
                  </button>
                );
              })}
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {project.ideaSuggestions && project.ideaSuggestions.length > 0 && (
                <button
                  type="button"
                  onClick={() => handleGenerateIdeas(true)}
                  disabled={loadingIdeas}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-[#2B3347] bg-[#161B27] px-3 py-1.5 text-xs font-medium text-[#D2D8E6] transition-colors hover:border-[#5B9BD5] hover:text-white disabled:opacity-50 whitespace-nowrap shrink-0"
                >
                  <RefreshCw
                    className={`h-3.5 w-3.5 ${loadingIdeas ? 'animate-spin' : ''}`}
                    aria-hidden="true"
                  />
                  <span>Acak 10 Ide Baru</span>
                </button>
              )}

              <button
                type="button"
                onClick={() => handleGenerateIdeas(false)}
                disabled={loadingIdeas}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[#3B5B85] bg-[#17273D] px-3.5 py-1.5 text-xs font-semibold text-[#CBE2F8] transition-colors hover:border-[#5B9BD5] hover:bg-[#1E3350] hover:text-white disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                {loadingIdeas ? (
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Lightbulb className="h-3.5 w-3.5 text-[#F5C451]" aria-hidden="true" />
                )}
                <span>{loadingIdeas ? 'Meracik 10 Ide Fresh...' : 'Buat 10 Ide Viral (AI)'}</span>
              </button>
            </div>
          </div>

          {project.ideaSuggestions && project.ideaSuggestions.length > 0 && (
            <div className="space-y-2 pt-1">
              <p className="text-xs text-[#8F9BB3]">
                10 ide segar &amp; tidak pasaran (klik salah satu untuk langsung mengisi kolom topik di atas):
              </p>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                {project.ideaSuggestions.map((item, idx) => {
                  const isPicked = project.topic.trim() === item.idea.trim();
                  return (
                    <button
                      key={`${item.idea}-${idx}`}
                      type="button"
                      onClick={() => onUpdate({ topic: item.idea })}
                      className={`flex flex-col justify-between gap-1.5 rounded-lg border p-3 text-left transition-colors ${
                        isPicked
                          ? 'border-[#5B9BD5] bg-[#172336]'
                          : 'border-[#1E2433] bg-[#111520] hover:border-[#34415C] hover:bg-[#151A28]'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 text-[11px] tabular-nums">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="font-mono font-bold text-[#7FB9EE]">#{idx + 1}</span>
                          <span className="truncate font-medium text-[#9EB0CC]">{item.category}</span>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="font-mono font-semibold text-[#F5C451]">
                            Viral {item.viralScore}/10
                          </span>
                          {isPicked && (
                            <span className="font-semibold text-[#68D391]">Dipakai</span>
                          )}
                        </div>
                      </div>
                      <p className="text-xs font-semibold leading-snug text-white">{item.idea}</p>
                      <p className="text-[11px] leading-relaxed text-[#8F9BB3]">{item.hook}</p>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* 5 Suggested Titles */}
        {project.titleSuggestions.length > 0 && (
          <div className="pt-3 space-y-2">
            <p className="text-xs font-medium text-[#9AA5BC]">
              Pilih salah satu rekomendasi judul (klik untuk memakai):
            </p>
            <div className="divide-y divide-[#1E2433] rounded-lg border border-[#1E2433] bg-[#0D1017]">
              {project.titleSuggestions.map((item, idx) => {
                const isSelected = project.selectedTitle === item.title;
                return (
                  <button
                    key={`${item.title}-${idx}`}
                    type="button"
                    onClick={() => onUpdate({ selectedTitle: item.title })}
                    className={`flex w-full items-start justify-between gap-4 px-4 py-3 text-left transition-colors ${
                      isSelected ? 'bg-[#172336]' : 'hover:bg-[#141824]'
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-white">{item.title}</p>
                      <p className="mt-0.5 text-xs leading-relaxed text-[#8F9BB3]">{item.reason}</p>
                    </div>
                    <div className="shrink-0 text-right tabular-nums">
                      <span className="text-xs font-semibold text-[#5B9BD5]">
                        Skor {item.score}/10
                      </span>
                      {isSelected && (
                        <span className="block text-[11px] font-medium text-[#68D391]">Dipilih</span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Editable Selected/Custom Title */}
        <div className="pt-2">
          <label htmlFor="selected-title-input" className="block text-xs font-medium text-[#9AA5BC]">
            Judul Video Terpilih (bisa diketik atau diubah sendiri)
          </label>
          <input
            id="selected-title-input"
            type="text"
            value={project.selectedTitle}
            onChange={(e) => {
              if (scriptError) setScriptError(null);
              onUpdate({ selectedTitle: e.target.value });
            }}
            placeholder="Tulis judul video final Anda di sini..."
            className="mt-1.5 w-full rounded-lg border border-[#272E40] bg-[#0C0F16] px-3.5 py-2 text-sm font-medium text-white placeholder-[#5C667C] focus:border-[#5B9BD5] focus:outline-none"
          />
        </div>
      </div>

      {/* 2. Gaya Narasi + Pengaturan Durasi */}
      <div className="space-y-4 rounded-xl border border-[#1E2433] bg-[#12151E] p-5">
        <div>
          <h2 className="text-sm font-semibold text-white">2. Gaya Narasi &amp; Target Durasi</h2>
          <p className="mt-0.5 text-xs text-[#8F9BB3]">
            Pilih karakter penyampaian naskah agar cocok dengan audiens channel Anda.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-5">
          {NARRATION_STYLES.map((style) => {
            const active = project.narrationStyle === style.id;
            return (
              <button
                key={style.id}
                type="button"
                onClick={() => onUpdate({ narrationStyle: style.id as NarrationStyleId })}
                aria-pressed={active}
                className={`rounded-lg border p-3.5 text-left transition-colors ${
                  active
                    ? 'border-[#5B9BD5] bg-[#172233] text-white'
                    : 'border-[#232A3B] bg-[#0E1118] text-[#B6C0D4] hover:border-[#343E57] hover:text-white'
                }`}
              >
                <span className="block text-sm font-semibold">{style.label}</span>
                <span className="mt-1 block text-xs leading-relaxed text-[#8F9BB3]">
                  {style.summary}
                </span>
              </button>
            );
          })}
        </div>

        {project.narrationStyle === 'custom' && (
          <div>
            <label htmlFor="custom-style-input" className="block text-xs font-medium text-[#9AA5BC]">
              Instruksi Gaya Narasi Custom
            </label>
            <textarea
              id="custom-style-input"
              rows={2}
              value={project.customStyleInstruction}
              onChange={(e) => onUpdate({ customStyleInstruction: e.target.value })}
              placeholder="Contoh: Gaya guru sejarah yang humoris, banyak referensi budaya pop Indonesia, bahasa semi-formal..."
              className="mt-1.5 w-full rounded-lg border border-[#272E40] bg-[#0C0F16] px-3.5 py-2 text-sm text-white placeholder-[#5C667C] focus:border-[#5B9BD5] focus:outline-none"
            />
          </div>
        )}

        {/* Duration & Word count + CTA */}
        <div className="flex flex-col gap-4 border-t border-[#1E2433] pt-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="grid grid-cols-2 gap-4 sm:flex sm:items-end sm:gap-5">
            <div>
              <label htmlFor="duration-minutes" className="block text-xs font-medium text-[#9AA5BC]">
                Durasi Target (menit)
              </label>
              <input
                id="duration-minutes"
                type="number"
                min={1}
                max={30}
                value={project.targetDurationMinutes}
                onChange={(e) => handleDurationChange(Number(e.target.value))}
                className="mt-1.5 w-full sm:w-28 rounded-lg border border-[#272E40] bg-[#0C0F16] px-3 py-2 text-sm font-mono tabular-nums text-white focus:border-[#5B9BD5] focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="target-words" className="block text-xs font-medium text-[#9AA5BC]">
                Perkiraan Kata (±170 kata/menit)
              </label>
              <input
                id="target-words"
                type="number"
                min={100}
                max={6000}
                step={50}
                value={project.targetWordCount}
                onChange={(e) =>
                  onUpdate({ targetWordCount: Math.max(100, Number(e.target.value) || 170) })
                }
                className="mt-1.5 w-full sm:w-36 rounded-lg border border-[#272E40] bg-[#0C0F16] px-3 py-2 text-sm font-mono tabular-nums text-white focus:border-[#5B9BD5] focus:outline-none"
              />
            </div>
          </div>

          <button
            type="button"
            onClick={handleGenerateScript}
            disabled={loadingScript}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#5B9BD5] px-5 py-2.5 text-sm font-semibold text-[#0B0D12] transition-colors hover:bg-[#73ACE0] disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            {loadingScript ? (
              <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Sparkles className="h-4 w-4" aria-hidden="true" />
            )}
            <span>{loadingScript ? 'Menulis Naskah...' : 'Buat Naskah Narasi'}</span>
          </button>
        </div>

        {scriptError && (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[#7F1D1D] bg-[#251317] px-3.5 py-2.5 text-xs text-[#FCA5A5]"
          >
            <div className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{scriptError}</span>
            </div>
            {scriptCanRetry && (
              <button
                type="button"
                onClick={handleGenerateScript}
                disabled={loadingScript}
                className="inline-flex items-center gap-1.5 rounded-md border border-[#991B1B] bg-[#3B181F] px-3 py-1 text-xs font-medium text-white hover:bg-[#4C1E27] disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Coba lagi</span>
              </button>
            )}
          </div>
        )}

        {scriptSuccessMsg && !scriptError && (
          <div
            role="status"
            className="flex items-center gap-2 rounded-lg border border-[#1E4631] bg-[#10241A] px-3.5 py-2.5 text-xs text-[#86EFAC]"
          >
            <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{scriptSuccessMsg}</span>
          </div>
        )}
      </div>

      {/* 3. Editor Naskah & Instruksi Gaya Suara */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="space-y-3 rounded-xl border border-[#1E2433] bg-[#12151E] p-5 lg:col-span-8">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label htmlFor="script-editor" className="text-sm font-semibold text-white">
              3. Editor Naskah Narasi
            </label>
            <div className="flex items-center gap-3 text-xs text-[#8F9BB3] tabular-nums">
              <span>{scriptStats.words.toLocaleString('id-ID')} kata</span>
              <span aria-hidden="true">·</span>
              <span>
                Estimasi {scriptStats.mins} mnt {scriptStats.secs} dtk
              </span>
              <button
                type="button"
                onClick={handleCopyScript}
                disabled={!project.script.trim()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[#2A3142] bg-[#181D2B] px-3 py-1.5 text-xs font-medium text-[#E6EAF2] transition-colors hover:border-[#3E4963] hover:text-white disabled:opacity-40 whitespace-nowrap shrink-0"
              >
                {copiedScript ? (
                  <>
                    <Check className="h-3.5 w-3.5 text-[#68D391]" aria-hidden="true" />
                    <span>Tersalin</span>
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Salin Naskah</span>
                  </>
                )}
              </button>
            </div>
          </div>

          <textarea
            ref={scriptEditorRef}
            id="script-editor"
            rows={14}
            value={project.script}
            onChange={(e) => onUpdate({ script: e.target.value })}
            placeholder="Naskah narasi Bahasa Indonesia akan muncul di sini. Anda juga bisa mengetik atau mengedit langsung..."
            className="w-full rounded-lg border border-[#272E40] bg-[#0C0F16] p-4 text-sm leading-7 text-[#E6EAF2] placeholder-[#556076] focus:border-[#5B9BD5] focus:outline-none"
          />
        </div>

        {/* Panel Kecil: Instruksi Gaya Suara */}
        <aside className="flex flex-col justify-between space-y-4 rounded-xl border border-[#1E2433] bg-[#12151E] p-5 lg:col-span-4">
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-white">Instruksi Gaya Suara</h2>
              <span className="text-xs text-[#7C879E]">{activeStyle.label}</span>
            </div>
            <p className="text-xs leading-relaxed text-[#8F9BB3]">
              Salin arahan ini untuk ditempel ke layanan text-to-speech (TTS) eksternal atau panduan voice-over talent Anda.
            </p>
            <div className="rounded-lg border border-[#232A3B] bg-[#0C0F16] p-3.5 text-xs leading-relaxed text-[#D2D8E6]">
              {activeStyle.voiceInstruction}
            </div>
          </div>

          <button
            type="button"
            onClick={handleCopyVoiceInstruction}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-[#2B3347] bg-[#181D2B] px-4 py-2 text-xs font-medium text-[#E6EAF2] transition-colors hover:border-[#5B9BD5] hover:text-white"
          >
            {copiedVoice ? (
              <>
                <Check className="h-3.5 w-3.5 text-[#68D391]" aria-hidden="true" />
                <span>Instruksi Suara Tersalin</span>
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Salin Instruksi Gaya Suara</span>
              </>
            )}
          </button>
        </aside>
      </div>
    </section>
  );
};
