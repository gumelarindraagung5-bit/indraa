import React, { useEffect, useRef, useState } from 'react';
import { ZoomIn, ZoomOut, AudioLines } from 'lucide-react';
import type { SceneItem } from '../types/project';
import {
  adjustCutBoundary,
  formatSceneCode,
  formatTimeMMSS,
  formatTimePrecise,
} from '../utils/timelineMath';

interface TimelineTrackProps {
  scenes: SceneItem[];
  totalDuration: number;
  currentTime: number;
  selectedSceneId: number | null;
  thumbUrls: Map<string, string>;
  waveformPeaks: number[];
  onSeek: (time: number) => void;
  onSelectScene: (sceneId: number) => void;
  onScenesChange: (scenes: SceneItem[]) => void;
  onSnapCutsToVoicePauses?: () => void;
  syncingVoicePauses?: boolean;
}

export const TimelineTrack: React.FC<TimelineTrackProps> = ({
  scenes,
  totalDuration,
  currentTime,
  selectedSceneId,
  thumbUrls,
  waveformPeaks,
  onSeek,
  onSelectScene,
  onScenesChange,
  onSnapCutsToVoicePauses,
  syncingVoicePauses = false,
}) => {
  const [pxPerSec, setPxPerSec] = useState(32);
  const trackContainerRef = useRef<HTMLDivElement | null>(null);
  const waveformCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragStateRef = useRef<{
    leftIndex: number;
    startClientX: number;
    initialBoundary: number;
  } | null>(null);

  const safeDuration = Math.max(1, totalDuration || scenes[scenes.length - 1]?.end || 10);
  const totalWidth = Math.max(760, Math.round(safeDuration * pxPerSec));

  // Draw high-resolution audio waveform + aligned scene cut-point markers on canvas
  useEffect(() => {
    const canvas = waveformCanvasRef.current;
    if (!canvas) return;
    const width = Math.min(4096, totalWidth);
    const height = 48;
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#0D1018';
    ctx.fillRect(0, 0, width, height);

    // Highlight active/selected scene region on the waveform so user sees voice segment under active photo
    const activeScene =
      scenes.find((s) => currentTime >= s.start && currentTime < s.end) ||
      scenes.find((s) => s.id === selectedSceneId);
    if (activeScene) {
      const x0 = (activeScene.start / safeDuration) * width;
      const x1 = (activeScene.end / safeDuration) * width;
      ctx.fillStyle = 'rgba(91, 155, 213, 0.14)';
      ctx.fillRect(x0, 0, Math.max(2, x1 - x0), height);
    }

    // Center baseline
    ctx.strokeStyle = '#1E2536';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();

    if (waveformPeaks.length > 0) {
      const maxPeak = Math.max(0.05, ...waveformPeaks);
      const barCount = Math.min(Math.floor(width / 2.5), waveformPeaks.length);
      const barWidth = width / Math.max(1, barCount);
      const progressRatio = Math.max(0, Math.min(1, currentTime / safeDuration));

      for (let i = 0; i < barCount; i++) {
        const peakIdx = Math.floor((i / barCount) * waveformPeaks.length);
        const normalized = (waveformPeaks[peakIdx] || 0) / maxPeak;
        const amp = Math.max(0.08, Math.min(1, normalized));
        const barH = amp * (height - 8);
        const x = i * barWidth;
        const y = (height - barH) / 2;
        const isPlayed = i / barCount <= progressRatio;
        // Silence valleys appear dimmer so users can visually see breath pauses
        const isQuietPause = normalized < 0.18;
        ctx.fillStyle = isPlayed
          ? isQuietPause
            ? 'rgba(245, 196, 81, 0.45)'
            : '#F5C451'
          : isQuietPause
            ? 'rgba(91, 155, 213, 0.35)'
            : '#5B9BD5';
        ctx.fillRect(x, y, Math.max(1.2, barWidth - 1.1), barH);
      }
    }

    // Draw vertical scene cut-boundary lines aligned 1:1 with the photo thumbnails above
    ctx.save();
    ctx.strokeStyle = 'rgba(245, 196, 81, 0.55)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    for (let i = 0; i < scenes.length - 1; i++) {
      const cutX = Math.round((scenes[i].end / safeDuration) * width) + 0.5;
      ctx.beginPath();
      ctx.moveTo(cutX, 0);
      ctx.lineTo(cutX, height);
      ctx.stroke();
    }
    ctx.restore();
  }, [waveformPeaks, totalWidth, currentTime, safeDuration, scenes, selectedSceneId]);

  // Global pointer drag handlers for clip boundary resizing
  useEffect(() => {
    const handlePointerMove = (e: PointerEvent) => {
      const drag = dragStateRef.current;
      if (!drag) return;
      const deltaPx = e.clientX - drag.startClientX;
      const deltaSec = deltaPx / pxPerSec;
      const nextBoundary = drag.initialBoundary + deltaSec;
      const updated = adjustCutBoundary(scenes, drag.leftIndex, nextBoundary);
      if (updated !== scenes) {
        onScenesChange(updated);
      }
    };

    const handlePointerUp = () => {
      dragStateRef.current = null;
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [pxPerSec, scenes, onScenesChange]);

  const handleTrackSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (dragStateRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(totalWidth, e.clientX - rect.left));
    const t = Math.max(0, Math.min(safeDuration, (x / totalWidth) * safeDuration));
    onSeek(t);
  };

  // Compute ruler ticks dynamically based on zoom
  const tickStep = pxPerSec >= 40 ? 2 : pxPerSec >= 20 ? 5 : 10;
  const ticks: number[] = [];
  for (let t = 0; t <= safeDuration; t += tickStep) {
    ticks.push(t);
  }

  const playheadX = Math.max(0, Math.min(totalWidth, (currentTime / safeDuration) * totalWidth));

  return (
    <div className="rounded-xl border border-[#1E2433] bg-[#11151E]">
      {/* Timeline Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#1D2230] px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-3 text-xs text-[#9AA5BC]">
          <span className="font-semibold text-white">Timeline Foto &amp; Gelombang Suara</span>
          <span aria-hidden="true">·</span>
          <span>
            Garis putus-putus kuning di gelombang suara menandai titik pergantian foto di atasnya
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-3 shrink-0">
          {onSnapCutsToVoicePauses && scenes.length > 0 && (
            <button
              type="button"
              disabled={syncingVoicePauses}
              onClick={onSnapCutsToVoicePauses}
              title="Pas-kan otomatis seluruh batas foto di timeline ke lembah jeda suara pada gelombang audio"
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#2C3E5A] bg-[#172234] px-2.5 py-1 text-[11px] font-semibold text-[#8EC5FC] hover:border-[#5B9BD5] hover:text-white disabled:opacity-40 whitespace-nowrap"
            >
              <AudioLines className="h-3.5 w-3.5" aria-hidden="true" />
              <span>
                {syncingVoicePauses
                  ? 'Menyelaraskan Jeda Suara...'
                  : 'Kunci Potongan Foto ke Jeda Suara'}
              </span>
            </button>
          )}

          <div className="flex items-center gap-2">
            <ZoomOut className="h-3.5 w-3.5 text-[#8F9BB3]" aria-hidden="true" />
            <label htmlFor="timeline-zoom" className="sr-only">
              Zoom timeline
            </label>
            <input
              id="timeline-zoom"
              type="range"
              min={8}
              max={80}
              value={pxPerSec}
              onChange={(e) => setPxPerSec(Number(e.target.value))}
              className="w-28 accent-[#5B9BD5]"
            />
            <ZoomIn className="h-3.5 w-3.5 text-[#8F9BB3]" aria-hidden="true" />
          </div>
        </div>
      </div>

      {/* Scrollable Timeline Canvas */}
      <div ref={trackContainerRef} className="overflow-x-auto p-3">
        <div
          className="relative select-none"
          style={{ width: `${totalWidth}px` }}
          data-testid="timeline-track-canvas"
        >
          {/* Time Ruler */}
          <div
            onClick={handleTrackSeek}
            className="relative h-6 cursor-pointer border-b border-[#1F2637] bg-[#0C0F16]"
          >
            {ticks.map((t) => {
              const leftPct = (t / safeDuration) * 100;
              return (
                <div
                  key={t}
                  className="absolute top-0 bottom-0 border-l border-[#252D40] pl-1 text-[10px] font-mono text-[#7C879E] tabular-nums"
                  style={{ left: `${leftPct}%` }}
                >
                  {formatTimeMMSS(t)}
                </div>
              );
            })}
          </div>

          {/* Scene Clips Row */}
          <div className="relative mt-2 h-20 rounded-lg bg-[#0C0F16] border border-[#1B2130]">
            {scenes.map((scene, idx) => {
              const leftPx = (scene.start / safeDuration) * totalWidth;
              const widthPx = Math.max(14, ((scene.end - scene.start) / safeDuration) * totalWidth);
              const thumbUrl = scene.imageId ? thumbUrls.get(scene.imageId) : undefined;
              const isSelected = selectedSceneId === scene.id;
              const isPlayingNow = currentTime >= scene.start && currentTime < scene.end;
              const dur = scene.end - scene.start;

              return (
                <React.Fragment key={scene.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onSelectScene(scene.id);
                      onSeek(scene.start + 0.01);
                    }}
                    title={`#${scene.id} (${formatTimePrecise(scene.start)} – ${formatTimePrecise(scene.end)}) · ${scene.text}`}
                    aria-label={`Pilih adegan ${scene.id}, durasi ${dur.toFixed(1)} detik`}
                    style={{ left: `${leftPx}px`, width: `${widthPx}px` }}
                    className={`absolute top-0 bottom-0 overflow-hidden rounded-md border text-left transition-all ${
                      isPlayingNow
                        ? 'z-10 border-[#F5C451] ring-1 ring-[#F5C451]'
                        : isSelected
                          ? 'z-10 border-[#5B9BD5] ring-1 ring-[#5B9BD5]'
                          : thumbUrl
                            ? 'border-[#2B3449] hover:border-[#5B9BD5]'
                            : 'border-[#7C2D12] bg-[#251612] hover:border-[#D97706]'
                    }`}
                  >
                    {thumbUrl ? (
                      <img
                        src={thumbUrl}
                        alt={`Thumbnail ${formatSceneCode(scene.id)}`}
                        className="h-full w-full object-cover object-center opacity-95 transition-transform duration-150 hover:scale-[1.03]"
                        draggable={false}
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center bg-[#1C1414] px-1 text-center text-[10px] font-medium text-[#F5C451]">
                        #{scene.id} Kosong
                      </div>
                    )}
                    <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between bg-gradient-to-b from-black/75 via-black/30 to-transparent px-1.5 py-0.5">
                      <span className="font-mono text-[10px] font-bold text-[#F5C451] tabular-nums">
                        #{scene.id}
                      </span>
                      {widthPx >= 86 && (
                        <span className="truncate font-mono text-[9px] text-[#D2D8E6] tabular-nums">
                          {formatTimePrecise(scene.start)}–{formatTimePrecise(scene.end)}
                        </span>
                      )}
                    </div>
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/55 to-transparent px-1.5 py-1">
                      <span className="block truncate font-mono text-[10px] font-semibold text-white tabular-nums">
                        {dur.toFixed(1)}s · {scene.text}
                      </span>
                    </div>
                  </button>

                  {/* Draggable Cut Boundary Handle between scene[idx] and scene[idx+1] */}
                  {idx < scenes.length - 1 && (
                    <div
                      role="separator"
                      aria-orientation="vertical"
                      aria-label={`Geser batas antara adegan ${scene.id} dan ${scenes[idx + 1].id}`}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        e.currentTarget.setPointerCapture(e.pointerId);
                        dragStateRef.current = {
                          leftIndex: idx,
                          startClientX: e.clientX,
                          initialBoundary: scene.end,
                        };
                        onSelectScene(scene.id);
                      }}
                      style={{ left: `${leftPx + widthPx - 5}px` }}
                      className="absolute top-0 bottom-0 z-20 flex w-2.5 cursor-col-resize items-center justify-center group"
                    >
                      <span className="h-10 w-1 rounded-full bg-[#5B9BD5]/75 transition-colors group-hover:bg-[#F5C451]" />
                    </div>
                  )}
                </React.Fragment>
              );
            })}
          </div>

          {/* Audio Waveform Track */}
          <div
            onClick={handleTrackSeek}
            className="mt-2 cursor-pointer overflow-hidden rounded-lg border border-[#242D42] bg-[#0D1018]"
            title="Klik gelombang suara untuk memindahkan playhead dan mengecek kesesuaian foto dengan kalimat narasi"
          >
            <canvas
              ref={waveformCanvasRef}
              className="block h-12 w-full"
              aria-label="Waveform audio narasi dengan penanda titik potong adegan"
            />
          </div>

          {/* Synchronized Playhead */}
          <div
            className="pointer-events-none absolute top-0 bottom-0 z-30 w-0.5 bg-[#F5C451]"
            style={{ left: `${playheadX}px` }}
          >
            <div className="h-2.5 w-2.5 -translate-x-[4px] rounded-b-sm bg-[#F5C451]" />
          </div>
        </div>
      </div>
    </div>
  );
};
