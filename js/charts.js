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

export function drawSparkline(canvas, values) {
  const { ctx, w, h } = setupCanvas(canvas);
  const up = values[values.length - 1] >= values[0];
  const color = up ? col('--up') : col('--down');
  const min = Math.min(...values), max = Math.max(...values);
  const pad = 2, span = max - min || 1;
  const x = i => pad + (i / (values.length - 1)) * (w - pad * 2);
  const y = v => h - pad - ((v - min) / span) * (h - pad * 2);

  ctx.clearRect(0, 0, w, h);
  ctx.beginPath();
  values.forEach((v, i) => i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v)));
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = ctx.lineCap = 'round';
  ctx.stroke();
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

// Diverging blue <-> red heatmap color for correlation in [-1, 1],
// through the neutral dark midpoint.
export function corrColor(v) {
  const mid = [0x38, 0x38, 0x35];
  const pole = v >= 0 ? [0xe6, 0x67, 0x67] : [0x39, 0x87, 0xe5];
  const t = Math.min(1, Math.abs(v));
  const c = mid.map((m, i) => Math.round(m + (pole[i] - m) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
