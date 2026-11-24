import type { SceneItem, SubtitleSettings, VideoExportSettings } from '../types/project';
import { getActiveSubtitleAtTime } from './subtitleUtils';
import { findSceneAtTime } from './timelineMath';

export interface RenderFrameParams {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  currentTime: number;
  scenes: SceneItem[];
  imageElements: Map<string, HTMLImageElement | ImageBitmap>;
  subtitleSettings: SubtitleSettings;
  videoSettings: VideoExportSettings;
}

const CROSSFADE_SECONDS = 0.3;

function drawCoverImage(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement | ImageBitmap,
  width: number,
  height: number,
  zoomFactor: number,
  alpha: number
) {
  const imgW = 'naturalWidth' in img ? img.naturalWidth : img.width;
  const imgH = 'naturalHeight' in img ? img.naturalHeight : img.height;
  if (!imgW || !imgH) return;

  const canvasRatio = width / height;
  const imgRatio = imgW / imgH;

  let drawW = width;
  let drawH = height;
  if (imgRatio > canvasRatio) {
    drawH = height;
    drawW = height * imgRatio;
  } else {
    drawW = width;
    drawH = width / imgRatio;
  }

  drawW *= zoomFactor;
  drawH *= zoomFactor;

  const offsetX = (width - drawW) / 2;
  const offsetY = (height - drawH) / 2;

  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
  ctx.drawImage(img, offsetX, offsetY, drawW, drawH);
  ctx.restore();
}

function drawMissingPlaceholder(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  sceneNumber: number
) {
  ctx.fillStyle = '#141822';
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = '#2A3142';
  ctx.lineWidth = Math.max(2, width / 400);
  ctx.strokeRect(width * 0.08, height * 0.12, width * 0.84, height * 0.76);

  ctx.fillStyle = '#8C97AD';
  ctx.font = `600 ${Math.round(width * 0.028)}px "Plus Jakarta Sans", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`Adegan ${sceneNumber} — Belum Ada Gambar`, width / 2, height / 2);
}

function drawSubtitles(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  scene: SceneItem,
  currentTime: number,
  settings: SubtitleSettings
) {
  if (settings.mode === 'off') return;
  const { chunk, activeWordIndex } = getActiveSubtitleAtTime(scene, currentTime);
  if (!chunk || chunk.words.length === 0) return;

  const scale = height / 720;
  const fontSize = Math.max(16, Math.round(settings.fontSize * scale));
  ctx.save();
  ctx.font = `700 ${fontSize}px "Plus Jakarta Sans", sans-serif`;
  ctx.textBaseline = 'middle';

  let centerY = height * 0.87;
  if (settings.position === 'middle') centerY = height * 0.5;
  else if (settings.position === 'top') centerY = height * 0.13;

  const padX = Math.round(20 * scale);
  const padY = Math.round(10 * scale);

  if (settings.mode === 'lines') {
    const text = chunk.text;
    const metrics = ctx.measureText(text);
    const boxW = Math.min(width * 0.9, metrics.width + padX * 2);
    const boxH = fontSize + padY * 2;

    ctx.fillStyle = 'rgba(10, 12, 18, 0.76)';
    ctx.beginPath();
    ctx.roundRect((width - boxW) / 2, centerY - boxH / 2, boxW, boxH, 8 * scale);
    ctx.fill();

    ctx.textAlign = 'center';
    ctx.lineWidth = Math.max(2, 4 * scale);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
    ctx.strokeText(text, width / 2, centerY, width * 0.86);
    ctx.fillStyle = settings.textColor;
    ctx.fillText(text, width / 2, centerY, width * 0.86);
  } else {
    // Dynamic mode with active word highlight
    const spaceWidth = ctx.measureText(' ').width;
    const wordWidths = chunk.words.map((w) => ctx.measureText(w.word).width);
    const totalW =
      wordWidths.reduce((a, b) => a + b, 0) + spaceWidth * Math.max(0, chunk.words.length - 1);
    const maxLineW = width * 0.88;
    const fitScale = totalW > maxLineW ? maxLineW / totalW : 1;

    const scaledFont = Math.max(14, Math.round(fontSize * fitScale));
    ctx.font = `700 ${scaledFont}px "Plus Jakarta Sans", sans-serif`;
    const sSpace = ctx.measureText(' ').width;
    const sWidths = chunk.words.map((w) => ctx.measureText(w.word).width);
    const sTotalW = sWidths.reduce((a, b) => a + b, 0) + sSpace * Math.max(0, chunk.words.length - 1);

    const boxW = sTotalW + padX * 2;
    const boxH = scaledFont + padY * 2;

    ctx.fillStyle = 'rgba(10, 12, 18, 0.78)';
    ctx.beginPath();
    ctx.roundRect((width - boxW) / 2, centerY - boxH / 2, boxW, boxH, 10 * scale);
    ctx.fill();

    let cursorX = (width - sTotalW) / 2;
    ctx.textAlign = 'left';

    chunk.words.forEach((w, idx) => {
      const isCurrent = idx === activeWordIndex;
      if (isCurrent) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
        ctx.beginPath();
        ctx.roundRect(
          cursorX - 5 * scale,
          centerY - scaledFont * 0.62,
          sWidths[idx] + 10 * scale,
          scaledFont * 1.24,
          6 * scale
        );
        ctx.fill();
      }

      ctx.lineWidth = Math.max(2, 4 * scale);
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.9)';
      ctx.strokeText(w.word, cursorX, centerY);

      ctx.fillStyle = isCurrent ? settings.highlightColor : settings.textColor;
      ctx.fillText(w.word, cursorX, centerY);

      cursorX += sWidths[idx] + sSpace;
    });
  }

  ctx.restore();
}

export function renderStudioFrame(params: RenderFrameParams): void {
  const { ctx, width, height, currentTime, scenes, imageElements, subtitleSettings, videoSettings } = params;

  ctx.fillStyle = '#0B0D12';
  ctx.fillRect(0, 0, width, height);

  if (scenes.length === 0) {
    ctx.fillStyle = '#7C879C';
    ctx.font = `500 ${Math.round(width * 0.024)}px "Plus Jakarta Sans", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Belum ada adegan. Buat timestamp di Kotak 3 terlebih dahulu.', width / 2, height / 2);
    return;
  }

  const { scene, index } = findSceneAtTime(scenes, currentTime);
  if (!scene) return;

  const sceneDur = Math.max(0.1, scene.end - scene.start);
  const elapsed = Math.max(0, Math.min(sceneDur, currentTime - scene.start));
  const progress = elapsed / sceneDur;

  // Alternate gentle zoom-in and zoom-out across scenes for visual variety
  const kenBurnsZoom = videoSettings.kenBurns
    ? index % 2 === 0
      ? 1.0 + progress * 0.07
      : 1.07 - progress * 0.07
    : 1.0;

  const currImg = scene.imageId ? imageElements.get(scene.imageId) : undefined;
  const prevScene = index > 0 ? scenes[index - 1] : null;
  const prevImg = prevScene?.imageId ? imageElements.get(prevScene.imageId) : undefined;

  const inCrossfade = videoSettings.crossfade && index > 0 && elapsed < CROSSFADE_SECONDS;

  if (inCrossfade && prevImg) {
    const t = elapsed / CROSSFADE_SECONDS;
    const prevZoom = videoSettings.kenBurns ? ((index - 1) % 2 === 0 ? 1.07 : 1.0) : 1.0;
    drawCoverImage(ctx, prevImg, width, height, prevZoom, 1 - t);
    if (currImg) {
      drawCoverImage(ctx, currImg, width, height, kenBurnsZoom, t);
    } else {
      ctx.save();
      ctx.globalAlpha = t;
      drawMissingPlaceholder(ctx, width, height, scene.id);
      ctx.restore();
    }
  } else if (currImg) {
    drawCoverImage(ctx, currImg, width, height, kenBurnsZoom, 1);
  } else {
    drawMissingPlaceholder(ctx, width, height, scene.id);
  }

  drawSubtitles(ctx, width, height, scene, currentTime, subtitleSettings);
}
