import React, { useRef, useState } from 'react';
import { Download, Upload, FilePlus2, Check } from 'lucide-react';
import type { WizardStep } from '../types/project';

interface WizardHeaderProps {
  activeStep: WizardStep;
  onSelectStep: (step: WizardStep) => void;
  stepCompletion: Record<WizardStep, boolean>;
  onExportProject: () => void;
  onImportProject: (file: File) => void;
  onResetProject: () => void;
}

const STEPS: Array<{ step: WizardStep; shortTitle: string; label: string }> = [
  { step: 1, shortTitle: 'Kotak 1', label: 'Ide & Naskah' },
  { step: 2, shortTitle: 'Kotak 2', label: 'Upload Audio' },
  { step: 3, shortTitle: 'Kotak 3', label: 'Timestamp' },
  { step: 4, shortTitle: 'Kotak 4', label: 'Prompt Gambar' },
  { step: 5, shortTitle: 'Kotak 5', label: 'Studio Video' },
  { step: 6, shortTitle: 'Kotak 6', label: 'Paket YouTube' },
];

export const WizardHeader: React.FC<WizardHeaderProps> = ({
  activeStep,
  onSelectStep,
  stepCompletion,
  onExportProject,
  onImportProject,
  onResetProject,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onImportProject(file);
      e.target.value = '';
    }
  };

  return (
    <header className="sticky top-0 z-30 border-b border-[#1F2433] bg-[#0B0D12]/95 backdrop-blur-sm">
      {/* Top Bar */}
      <div className="mx-auto flex max-w-[1400px] items-center justify-between gap-2 px-4 py-2.5 sm:gap-4 sm:px-6 sm:py-3">
        <div className="min-w-0 flex-1">
          <span className="block truncate text-sm font-bold tracking-tight text-white sm:text-lg">
            Stickman Video Studio
          </span>
        </div>

        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            onChange={handleFileChange}
            className="hidden"
            aria-label="Import file proyek JSON"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            aria-label="Import Proyek JSON"
            title="Import Proyek (.json)"
            className="inline-flex items-center gap-1.5 rounded-lg border border-[#262C3D] bg-[#131722] px-2.5 py-1.5 text-xs font-medium text-[#D2D8E6] transition-colors hover:border-[#3A435C] hover:text-white whitespace-nowrap shrink-0 sm:px-3"
          >
            <Upload className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="hidden sm:inline">Import Proyek</span>
          </button>

          <button
            type="button"
            onClick={onExportProject}
            aria-label="Export Proyek JSON"
            title="Export Proyek (.json)"
            className="inline-flex items-center gap-1.5 rounded-lg border border-[#262C3D] bg-[#131722] px-2.5 py-1.5 text-xs font-medium text-[#D2D8E6] transition-colors hover:border-[#3A435C] hover:text-white whitespace-nowrap shrink-0 sm:px-3"
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="hidden sm:inline">Export (.json)</span>
          </button>

          <button
            type="button"
            onClick={() => setConfirmReset(true)}
            aria-label="Proyek Baru"
            className="inline-flex items-center gap-1.5 rounded-lg border border-[#2E3548] bg-[#181D2A] px-2.5 py-1.5 text-xs font-medium text-[#E6EAF2] transition-colors hover:border-[#5B9BD5]/60 hover:text-white whitespace-nowrap shrink-0 sm:px-3"
          >
            <FilePlus2 className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="hidden sm:inline">Proyek Baru</span>
            <span className="sm:hidden">Baru</span>
          </button>
        </div>
      </div>

      {/* 6-Box Clickable Wizard Stepper */}
      <nav
        aria-label="Langkah Wizard Produksi Video"
        className="border-t border-[#181C27] bg-[#0F1219]"
      >
        <div className="mx-auto max-w-[1400px] overflow-x-auto px-4 sm:px-6">
          <ol className="flex items-stretch gap-1 py-2 min-w-max sm:grid sm:grid-cols-6 sm:min-w-0 sm:gap-2">
            {STEPS.map(({ step, shortTitle, label }) => {
              const isActive = activeStep === step;
              const isDone = stepCompletion[step];
              return (
                <li key={step} className="flex">
                  <button
                    type="button"
                    onClick={() => onSelectStep(step)}
                    aria-current={isActive ? 'step' : undefined}
                    className={`flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors whitespace-nowrap shrink-0 ${
                      isActive
                        ? 'border-[#5B9BD5] bg-[#172233] text-white'
                        : 'border-transparent bg-transparent text-[#8F9BB3] hover:border-[#242B3D] hover:bg-[#151924] hover:text-[#DCE2EE]'
                    }`}
                  >
                    <span
                      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-xs font-semibold tabular-nums ${
                        isActive
                          ? 'bg-[#5B9BD5] text-[#0B0D12]'
                          : isDone
                            ? 'bg-[#1D3228] text-[#68D391]'
                            : 'bg-[#1B2030] text-[#8F9BB3]'
                      }`}
                    >
                      {isDone && !isActive ? (
                        <Check className="h-3.5 w-3.5" aria-hidden="true" />
                      ) : (
                        step
                      )}
                    </span>
                    <span className="min-w-0 truncate">
                      <span className="block text-[11px] font-medium text-[#7C879E] leading-tight">
                        {shortTitle}
                      </span>
                      <span className="block text-xs font-semibold leading-tight truncate">
                        {label}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      </nav>

      {/* Accessible Confirmation Modal for Proyek Baru (no window.confirm) */}
      {confirmReset && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="reset-dialog-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
        >
          <div className="w-full max-w-md rounded-xl border border-[#2A3142] bg-[#131722] p-6 shadow-2xl">
            <h2 id="reset-dialog-title" className="text-base font-semibold text-white">
              Mulai Proyek Baru?
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-[#9AA5BC]">
              Semua teks naskah, timestamp adegan, prompt gambar, audio, dan gambar yang tersimpan di browser akan dihapus. Export proyek (.json) terlebih dahulu jika Anda ingin menyimpan cadangan.
            </p>
            <div className="mt-6 flex items-center justify-end gap-2.5">
              <button
                type="button"
                onClick={() => setConfirmReset(false)}
                className="rounded-lg border border-[#2B3245] bg-[#191E2C] px-4 py-2 text-xs font-medium text-[#D2D8E6] hover:text-white"
              >
                Batal
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmReset(false);
                  onResetProject();
                }}
                className="rounded-lg bg-[#DC2626] px-4 py-2 text-xs font-semibold text-white hover:bg-[#B91C1C]"
              >
                Ya, Hapus &amp; Mulai Baru
              </button>
            </div>
          </div>
        </div>
      )}
    </header>
  );
};
