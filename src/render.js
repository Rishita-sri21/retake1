// @ts-check
/**
 * Draws one finished frame: the source frame through the virtual camera
 * (zoom), with blurred secrets, spotlights, title and chapter cards,
 * fast-forward badge and captions. Used identically by the preview and by
 * the export, so what you preview is what you get.
 */
import { cameraAt, cameraModeAt, levelAt } from './plan.js';

/** @typedef {import('./plan.js').Plan} Plan */

export const FONT_DISPLAY = '"Big Shoulders Display", "Arial Narrow", sans-serif';
export const FONT_BODY = '"IBM Plex Sans", system-ui, sans-serif';

/**
 * @typedef {Object} Look
 * @property {boolean} captions
 * @property {number} captionSize   Relative to frame height (0.03–0.06).
 * @property {boolean} badge        Show the fast-forward badge.
 * @property {boolean} watermark
 * @property {boolean} camera       Show the camera bubble (when the take has one).
 * @property {'circle'|'rounded'} camShape
 * @property {'br'|'bl'|'tr'|'tl'} camCorner
 * @property {number} camSize      Bubble diameter relative to frame height.
 */

/** @type {Look} */
export const DEFAULT_LOOK = { captions: true, captionSize: 0.042, badge: true, watermark: false, camera: true, camShape: 'circle', camCorner: 'br', camSize: 0.26 };

/** Small canvas reused for pixelation. */
let pix = /** @type {HTMLCanvasElement | null} */ (null);

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} W
 * @param {number} H
 * @param {{frame: CanvasImageSource, width: number, height: number}} source
 * @param {Plan} plan
 * @param {number} src   Source time of this frame.
 * @param {number} out   Output time of this frame.
 * @param {number} rate  Playback rate of the current segment.
 * @param {Look} look
 * @param {{frame: CanvasImageSource, width: number, height: number} | null} [camera]
 */
export function drawFrame(ctx, W, H, source, plan, src, out, rate, look, camera = null) {
  const cam = cameraAt(plan, src);
  const s = cam.scale;
  const tx = Math.min(0, Math.max(W - W * s, W / 2 - cam.x * W * s));
  const ty = Math.min(0, Math.max(H - H * s, H / 2 - cam.y * H * s));

  ctx.save();
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  ctx.setTransform(s, 0, 0, s, tx, ty);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(source.frame, 0, 0, W, H);

  // Secrets: pixelate the region, from the moment it appeared.
  for (const b of plan.blurs) {
    if (src < b.src0 || src > b.src1) continue;
    const sx = b.box.x * source.width, sy = b.box.y * source.height;
    const sw = b.box.w * source.width, sh = b.box.h * source.height;
    const dx = b.box.x * W, dy = b.box.y * H, dw = b.box.w * W, dh = b.box.h * H;
    const cell = Math.max(6, Math.round(H / 60));
    const pw = Math.max(1, Math.round(dw / cell)), ph = Math.max(1, Math.round(dh / cell));
    pix = pix || document.createElement('canvas');
    pix.width = pw;
    pix.height = ph;
    const p = /** @type {CanvasRenderingContext2D} */ (pix.getContext('2d'));
    p.imageSmoothingEnabled = true;
    p.drawImage(source.frame, sx, sy, sw, sh, 0, 0, pw, ph);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(pix, 0, 0, pw, ph, dx, dy, dw, dh);
    ctx.imageSmoothingEnabled = true;
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 2 / s;
    ctx.setLineDash([6 / s, 4 / s]);
    ctx.strokeRect(dx, dy, dw, dh);
    ctx.setLineDash([]);
  }
  ctx.restore();

  // Spotlight: dim everything but a circle around the target.
  for (const sp of plan.spots) {
    if (src < sp.src0 || src > sp.src1) continue;
    const k = Math.min(1, (src - sp.src0) / 0.35, (sp.src1 - src) / 0.45);
    const px = tx + sp.x * W * s, py = ty + sp.y * H * s;
    const r = H * 0.11 * (1 + 0.04 * Math.sin((src - sp.src0) * 6));
    ctx.save();
    ctx.fillStyle = `rgba(8,9,12,${0.55 * k})`;
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.arc(px, py, r, 0, Math.PI * 2, true);
    ctx.fill('evenodd');
    ctx.strokeStyle = `rgba(255,214,10,${k})`;
    ctx.lineWidth = Math.max(3, H / 180);
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // Fast-forward badge.
  if (look.badge && rate > 1) {
    const fs = Math.round(H * 0.034);
    ctx.save();
    ctx.font = `700 ${fs}px ${FONT_BODY}`;
    const label = `${rate}×  ▸▸`;
    const w = ctx.measureText(label).width + fs * 1.2;
    const x = W - w - H * 0.03, y = H * 0.03;
    ctx.fillStyle = 'rgba(12,13,16,0.78)';
    roundRect(ctx, x, y, w, fs * 1.8, fs * 0.5);
    ctx.fill();
    ctx.fillStyle = '#ffd60a';
    ctx.fillText(label, x + fs * 0.6, y + fs * 1.25);
    ctx.restore();
  }

  if (camera && look.camera) drawCamera(ctx, W, H, camera, plan, src, look);

  // Opening title card.
  if (plan.title && out < 3.4) {
    const k = Math.min(1, out / 0.3, (3.4 - out) / 0.5);
    ctx.save();
    ctx.globalAlpha = k;
    const g = ctx.createLinearGradient(0, H * 0.45, 0, H);
    g.addColorStop(0, 'rgba(10,10,12,0)');
    g.addColorStop(1, 'rgba(10,10,12,0.9)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    const fs = Math.round(H * 0.085);
    ctx.font = `800 ${fs}px ${FONT_DISPLAY}`;
    const lines = wrapLines(ctx, plan.title.toUpperCase(), W - H * 0.14).slice(0, 3);
    const lh = fs * 1.02;
    const lastY = H * 0.88;
    const firstY = lastY - (lines.length - 1) * lh;
    ctx.fillStyle = '#ffd60a';
    ctx.fillRect(H * 0.07, firstY - fs - H * 0.035, H * 0.09, H * 0.012);
    ctx.fillStyle = '#ffffff';
    lines.forEach((l, i) => ctx.fillText(l, H * 0.07, firstY + i * lh));
    ctx.restore();
  }

  // Chapter lower-third.
  for (const c of plan.chapters) {
    const d = out - c.out;
    if (d < 0 || d > 2.8) continue;
    if (plan.title && c.out < 3.4) continue; // the title card is showing
    const k = Math.min(1, d / 0.35, (2.8 - d) / 0.4);
    const e = 1 - Math.pow(1 - k, 3);
    const fs = Math.round(H * 0.05);
    ctx.save();
    ctx.font = `800 ${fs}px ${FONT_DISPLAY}`;
    const text = c.title.toUpperCase();
    const w = ctx.measureText(text).width + fs * 1.4;
    const x = -w + (H * 0.05 + w) * e, y = H * 0.1;
    ctx.fillStyle = 'rgba(12,13,16,0.86)';
    ctx.fillRect(x, y, w, fs * 1.9);
    ctx.fillStyle = '#ffd60a';
    ctx.fillRect(x, y, fs * 0.22, fs * 1.9);
    ctx.font = `600 ${Math.round(fs * 0.42)}px ${FONT_BODY}`;
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fillText(`CHAPTER ${plan.chapters.indexOf(c) + 1}`, x + fs * 0.6, y + fs * 0.7);
    ctx.font = `800 ${fs}px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, x + fs * 0.6, y + fs * 1.62);
    ctx.restore();
  }

  // Captions.
  if (look.captions) {
    const cap = plan.captions.find((c) => out >= c.out0 && out < c.out1);
    if (cap) {
      const fs = Math.round(H * look.captionSize);
      ctx.save();
      ctx.font = `600 ${fs}px ${FONT_BODY}`;
      const lines = wrapLines(ctx, cap.text, W * 0.8);
      const lh = fs * 1.3;
      const boxW = Math.max(...lines.map((l) => ctx.measureText(l).width)) + fs * 1.2;
      const boxH = lines.length * lh + fs * 0.6;
      const x = (W - boxW) / 2, y = H - boxH - H * 0.05;
      ctx.fillStyle = 'rgba(10,10,12,0.78)';
      roundRect(ctx, x, y, boxW, boxH, fs * 0.35);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      lines.forEach((l, i) => ctx.fillText(l, W / 2, y + fs * 0.3 + lh * (i + 0.78)));
      ctx.restore();
    }
  }

  if (look.watermark) {
    ctx.save();
    ctx.font = `700 ${Math.round(H * 0.024)}px ${FONT_DISPLAY}`;
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.textAlign = 'right';
    ctx.fillText('EDITED BY VOICE · RETAKE', W - H * 0.03, H - H * 0.025);
    ctx.restore();
  }
}

/** @param {CanvasRenderingContext2D} ctx @param {number} x @param {number} y @param {number} w @param {number} h @param {number} r */
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** @param {CanvasRenderingContext2D} ctx @param {string} text @param {number} max */
function wrapLines(ctx, text, max) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > max && line) {
      lines.push(line);
      line = w;
    } else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Where the bubble sits for a mode.
 * @param {'small'|'big'|'hidden'} mode @param {number} W @param {number} H @param {Look} look
 */
function camRect(mode, W, H, look) {
  const d = H * look.camSize;
  const m = H * 0.04;
  const right = look.camCorner.endsWith('r'), bottom = look.camCorner.startsWith('b');
  const x = right ? W - d - m : m;
  // Keep clear of captions at the bottom centre and chapter cards at the top left.
  const y = bottom ? H - d - m - H * 0.02 : m + H * 0.02;
  if (mode === 'big') {
    const D = H * 0.6;
    return { x: (W - D) / 2, y: H * 0.05, d: D, a: 1 };
  }
  if (mode === 'hidden') return { x: x + d / 2, y: y + d / 2, d: 0, a: 0 };
  return { x, y, d, a: 1 };
}

/**
 * The presenter bubble: your camera, mirrored, cropped to fill, with a ring
 * that lights up while you speak.
 * @param {CanvasRenderingContext2D} ctx @param {number} W @param {number} H
 * @param {{frame: CanvasImageSource, width: number, height: number}} cam
 * @param {Plan} plan @param {number} src @param {Look} look
 */
function drawCamera(ctx, W, H, cam, plan, src, look) {
  const { from, to, k } = cameraModeAt(plan, src);
  const A = camRect(from, W, H, look), B = camRect(to, W, H, look);
  const r = { x: A.x + (B.x - A.x) * k, y: A.y + (B.y - A.y) * k, d: A.d + (B.d - A.d) * k, a: A.a + (B.a - A.a) * k };
  if (r.d < 2 || r.a <= 0.01 || !cam.width) return;

  // Big mode dims the screen behind you.
  const bigness = (from === 'big' ? 1 - k : 0) + (to === 'big' ? k : 0);
  if (bigness > 0) {
    ctx.save();
    ctx.fillStyle = `rgba(10,10,12,${0.72 * bigness})`;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  const radius = look.camShape === 'circle' ? r.d / 2 : r.d * 0.18;
  const path = () => {
    ctx.beginPath();
    if (look.camShape === 'circle') ctx.arc(r.x + r.d / 2, r.y + r.d / 2, r.d / 2, 0, Math.PI * 2);
    else {
      const { x, y, d } = r;
      ctx.moveTo(x + radius, y);
      ctx.arcTo(x + d, y, x + d, y + d, radius);
      ctx.arcTo(x + d, y + d, x, y + d, radius);
      ctx.arcTo(x, y + d, x, y, radius);
      ctx.arcTo(x, y, x + d, y, radius);
      ctx.closePath();
    }
  };

  ctx.save();
  ctx.globalAlpha = r.a;
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = H * 0.03;
  ctx.shadowOffsetY = H * 0.008;
  path();
  ctx.fillStyle = '#111';
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.clip();
  // Cover-crop the camera to a square, mirrored like a selfie view.
  const side = Math.min(cam.width, cam.height);
  const sx = (cam.width - side) / 2, sy = (cam.height - side) / 2;
  ctx.translate(r.x + r.d, r.y);
  ctx.scale(-1, 1);
  ctx.drawImage(cam.frame, sx, sy, side, side, 0, 0, r.d, r.d);
  ctx.restore();

  // Ring: white, turning slate-yellow while you talk.
  const talking = levelAt(plan, src) > (plan.levelThreshold || 0.04) * 1.3;
  ctx.save();
  ctx.globalAlpha = r.a;
  path();
  ctx.lineWidth = Math.max(3, r.d * 0.025);
  ctx.strokeStyle = talking ? '#ffd60a' : 'rgba(255,255,255,0.9)';
  ctx.stroke();
  ctx.restore();
}
