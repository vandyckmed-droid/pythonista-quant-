// Canvas charts: sparklines and the scrubbing price chart.
// Marks follow the house spec: 2px lines, 10% area wash, 8px end-dot with a
// 2px surface ring, hairline solid gridlines.

const CSS = getComputedStyle(document.documentElement);
const col = name => CSS.getPropertyValue(name).trim();

function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: rect.width, h: rect.height };
}

// Thin bars anchored to a 0 baseline (positive green, negative red), on a
// shared scale passed in by the caller so every card in the list is directly
// comparable. A bar beyond scaleMax is capped at the edge with a small
// chevron, rather than silently drawn as if it were the true height.
// Null entries (not enough history for that point) are skipped.
// `signed` centres the zero line so negative bars have room. When nothing in
// the whole list is ever negative — as with momentum scores, which are
// positive by construction for members — zero sits at the bottom instead, so
// the full height is spent on the range that actually varies.
// The history reads as context and the latest value as the point being made,
// so older bars are muted and faded toward the left while only the most
// recent one carries the full accent colour. Bars are laid out right-aligned
// so the final one ends flush with the canvas edge, letting the chart line up
// with the value printed above it.
const OLDEST_ALPHA = 0.45;   // leftmost bar; ramps to 1 at the newest

export function drawBarSeries(canvas, values, scaleMax, { signed = true } = {}) {
  const { ctx, w, h } = setupCanvas(canvas);
  const n = values.length;
  const zero = signed ? h / 2 : h;
  const span = signed ? h / 2 : h;
  const slot = w / n;
  const barW = Math.max(1, slot * 0.66);
  const radius = Math.min(barW / 2, 2.5);
  let newest = -1;
  for (let i = n - 1; i >= 0; i--) if (values[i] != null) { newest = i; break; }

  ctx.clearRect(0, 0, w, h);
  values.forEach((v, i) => {
    if (v == null) return;
    const clipped = Math.abs(v) > scaleMax;
    const clamped = Math.max(-scaleMax, Math.min(scaleMax, v));
    const barH = Math.max(1, (Math.abs(clamped) / scaleMax) * span);
    // right-aligned within the slot, so the last bar ends exactly at w
    const x = i * slot + (slot - barW);
    const up = clamped >= 0;
    const y = up ? zero - barH : zero;
    const live = i === newest;

    ctx.globalAlpha = live ? 1
      : OLDEST_ALPHA + (1 - OLDEST_ALPHA) * (n > 1 ? i / (n - 1) : 1);
    ctx.fillStyle = live
      ? col(up ? '--up' : '--down')
      : col(up ? '--bar-dim-up' : '--bar-dim-down');

    // round only the growing end, so bars still sit flat on the baseline
    ctx.beginPath();
    const r = Math.min(radius, barH);
    if (ctx.roundRect) {
      ctx.roundRect(x, y, barW, barH, up ? [r, r, 0, 0] : [0, 0, r, r]);
    } else {
      ctx.rect(x, y, barW, barH);
    }
    ctx.fill();

    if (clipped) {
      const cx = x + barW / 2;
      const tip = up ? y : y + barH;
      const dir = up ? -1 : 1;   // chevron points further outward
      ctx.beginPath();
      ctx.moveTo(cx - barW * 0.42, tip - dir * 0.5);
      ctx.lineTo(cx, tip + dir * 2.5);
      ctx.lineTo(cx + barW * 0.42, tip - dir * 0.5);
      ctx.strokeStyle = ctx.fillStyle;
      ctx.lineWidth = 1;
      ctx.lineJoin = ctx.lineCap = 'round';
      ctx.stroke();
    }
  });
  ctx.globalAlpha = 1;
}

// Price chart with y gridlines, area wash, end-dot; returns a geometry object
// the scrubbing layer uses to map touch x -> data point.
export function drawPriceChart(canvas, dates, values, { scrubIndex = null } = {}) {
  const { ctx, w, h } = setupCanvas(canvas);
  const up = values[values.length - 1] >= values[0];
  const color = up ? col('--up') : col('--down');
  const padL = 8, padR = 14, padT = 14, padB = 8;
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const x = i => padL + (i / (values.length - 1)) * (w - padL - padR);
  const y = v => h - padB - ((v - min) / span) * (h - padT - padB);

  ctx.clearRect(0, 0, w, h);

  // hairline gridlines at three clean levels
  ctx.strokeStyle = col('--grid');
  ctx.lineWidth = 1;
  for (const f of [0.25, 0.5, 0.75]) {
    const gy = padT + f * (h - padT - padB);
    ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(w - padR, gy); ctx.stroke();
  }

  // area wash
  ctx.beginPath();
  values.forEach((v, i) => i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v)));
  ctx.lineTo(x(values.length - 1), h - padB);
  ctx.lineTo(x(0), h - padB);
  ctx.closePath();
  ctx.globalAlpha = 0.10;
  ctx.fillStyle = color;
  ctx.fill();
  ctx.globalAlpha = 1;

  // the line
  ctx.beginPath();
  values.forEach((v, i) => i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v)));
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineJoin = ctx.lineCap = 'round';
  ctx.stroke();

  const dot = (cx, cy) => {
    ctx.beginPath(); ctx.arc(cx, cy, 6, 0, Math.PI * 2);
    ctx.fillStyle = col('--surface'); ctx.fill();          // 2px surface ring
    ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();
  };

  if (scrubIndex == null) {
    dot(x(values.length - 1), y(values[values.length - 1]));
  } else {
    // crosshair + marker at the scrubbed point
    const sx = x(scrubIndex), sy = y(values[scrubIndex]);
    ctx.strokeStyle = col('--muted');
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(sx, padT - 6); ctx.lineTo(sx, h - padB); ctx.stroke();
    dot(sx, sy);
  }

  return {
    indexAt(clientX) {
      const rect = canvas.getBoundingClientRect();
      const px = clientX - rect.left;
      const t = (px - padL) / (w - padL - padR);
      return Math.max(0, Math.min(values.length - 1, Math.round(t * (values.length - 1))));
    },
    xAt: x,
  };
}

// Bucketed correlation color — five discrete steps read faster than a
// continuous gradient. Anything below 0.2 (including negatives) is neutral.
export const CORR_BUCKETS = [
  { max: 0.2, color: '#383835', label: '<0.2' },
  { max: 0.4, color: '#7c4640', label: '0.2–0.4' },
  { max: 0.6, color: '#d95926', label: '0.4–0.6' },
  { max: 0.8, color: '#e64545', label: '0.6–0.8' },
  { max: Infinity, color: '#ff4f86', label: '>0.8' },
];

export function corrColor(v) {
  return CORR_BUCKETS.find(b => v < b.max || b.max === Infinity).color;
}
