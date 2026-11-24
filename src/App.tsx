import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createDefaultProject, type StudioProject, type WizardStep } from './types/project';
import { clearAllMediaDb } from './utils/mediaDb';
import {
  clearProjectLocalStorage,
  createSeededDemoProject,
  loadProjectFromLocalStorage,
  parseImportedProject,
  saveProjectToLocalStorage,
  serializeProjectForExport,
  triggerTextDownload,
} from './utils/storage';
import { WizardHeader } from './components/WizardHeader';
import { Step1IdeaScript } from './components/Step1IdeaScript';
import { Step2UploadAudio } from './components/Step2UploadAudio';
import { Step3Timestamps } from './components/Step3Timestamps';
import { Step4ImagePrompts } from './components/Step4ImagePrompts';
import { Step5VideoStudio } from './components/Step5VideoStudio';
import { Step6YouTubePackage } from './components/Step6YouTubePackage';

export default function App() {
  const [project, setProject] = useState<StudioProject>(() => loadProjectFromLocalStorage());
  const [notice, setNotice] = useState<{ type: 'ok' | 'error'; text: string } | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const demoSeededRef = useRef(false);

  // Optional ?demo=1 deterministic seeding for QA/verification without cluttering UI
  useEffect(() => {
    if (demoSeededRef.current) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('demo') === '1') {
      demoSeededRef.current = true;
      createSeededDemoProject().then((seeded) => {
        const stepParam = Number(params.get('step'));
        const activeStep: WizardStep =
          stepParam >= 1 && stepParam <= 6 ? (stepParam as WizardStep) : 1;
        const withStep = { ...seeded, activeStep };
        setProject(withStep);
        saveProjectToLocalStorage(withStep);
      });
    }
  }, []);

  // Debounced auto-save (2 seconds) to localStorage (text/JSON only, never blobs/base64)
  useEffect(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveProjectToLocalStorage(project);
    }, 2000);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [project]);

  const handleUpdate = useCallback((patch: Partial<StudioProject>) => {
    setProject((prev) => ({ ...prev, ...patch }));
  }, []);

  const handleSelectStep = useCallback((step: WizardStep) => {
    setProject((prev) => ({ ...prev, activeStep: step }));
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  }, []);

  const showNotice = useCallback((type: 'ok' | 'error', text: string) => {
    setNotice({ type, text });
    setTimeout(() => setNotice((curr) => (curr?.text === text ? null : curr)), 3500);
  }, []);

  const handleExportProject = useCallback(() => {
    const json = serializeProjectForExport(project);
    const slug = (project.selectedTitle || 'stickman-studio-proyek')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);
    triggerTextDownload(`${slug || 'proyek'}.json`, json, 'application/json');
    showNotice('ok', 'File proyek (.json) berhasil diunduh (tanpa file media besar).');
  }, [project, showNotice]);

  const handleImportProject = useCallback(
    async (file: File) => {
      try {
        const text = await file.text();
        const imported = parseImportedProject(text);
        setProject(imported);
        saveProjectToLocalStorage(imported);
        showNotice('ok', `Proyek "${imported.selectedTitle || file.name}" berhasil dimuat.`);
      } catch (err) {
        showNotice(
          'error',
          err instanceof Error ? err.message : 'Gagal membaca file proyek JSON.'
        );
      }
    },
    [showNotice]
  );

  const handleResetProject = useCallback(async () => {
    await clearAllMediaDb().catch(() => {});
    clearProjectLocalStorage();
    const fresh = createDefaultProject();
    setProject(fresh);
    showNotice('ok', 'Proyek baru dimulai. Data proyek sebelumnya telah dibersihkan.');
  }, [showNotice]);

  const stepCompletion = useMemo<Record<WizardStep, boolean>>(
    () => ({
      1: Boolean(project.script.trim()),
      2: Boolean(project.audioMeta),
      3: project.scenes.length > 0,
      4: project.scenes.length > 0 && project.scenes.some((s) => Boolean(s.scenePrompt?.trim())),
      5: project.scenes.length > 0 && project.scenes.some((s) => Boolean(s.imageId)),
      6: Boolean(project.youtubePackage),
    }),
    [project]
  );

  return (
    <div className="min-h-screen bg-[#0B0D12] text-[#E6EAF2] flex flex-col">
      <WizardHeader
        activeStep={project.activeStep}
        onSelectStep={handleSelectStep}
        stepCompletion={stepCompletion}
        onExportProject={handleExportProject}
        onImportProject={handleImportProject}
        onResetProject={handleResetProject}
      />

      {notice && (
        <div
          role="status"
          className={`mx-auto mt-4 w-full max-w-[1380px] px-4 sm:px-6`}
        >
          <div
            className={`rounded-lg border px-4 py-2.5 text-xs font-medium ${
              notice.type === 'ok'
                ? 'border-[#1E4631] bg-[#10241A] text-[#86EFAC]'
                : 'border-[#7F1D1D] bg-[#251317] text-[#FCA5A5]'
            }`}
          >
            {notice.text}
          </div>
        </div>
      )}

      {/* STRICT PERFORMANCE RULE: Render ONLY the active wizard box */}
      <main className="flex-1 px-4 py-6 sm:px-6 sm:py-8">
        {project.activeStep === 1 && (
          <Step1IdeaScript
            project={project}
            onUpdate={handleUpdate}
            onNext={() => handleSelectStep(2)}
          />
        )}
        {project.activeStep === 2 && (
          <Step2UploadAudio
            project={project}
            onUpdate={handleUpdate}
            onPrev={() => handleSelectStep(1)}
            onNext={() => handleSelectStep(3)}
          />
        )}
        {project.activeStep === 3 && (
          <Step3Timestamps
            project={project}
            onUpdate={handleUpdate}
            onPrev={() => handleSelectStep(2)}
            onNext={() => handleSelectStep(4)}
          />
        )}
        {project.activeStep === 4 && (
          <Step4ImagePrompts
            project={project}
            onUpdate={handleUpdate}
            onPrev={() => handleSelectStep(3)}
            onNext={() => handleSelectStep(5)}
          />
        )}
        {project.activeStep === 5 && (
          <Step5VideoStudio
            project={project}
            onUpdate={handleUpdate}
            onPrev={() => handleSelectStep(4)}
            onNext={() => handleSelectStep(6)}
          />
        )}
        {project.activeStep === 6 && (
          <Step6YouTubePackage
            project={project}
            onUpdate={handleUpdate}
            onPrev={() => handleSelectStep(5)}
          />
        )}
      </main>
    </div>
  );
}
