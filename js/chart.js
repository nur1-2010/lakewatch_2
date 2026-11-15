// График площади озера. Чистый SVG, без библиотек.
// Точки — отдельные снимки, линия — медиана за год, пунктир — многолетняя норма.
import { t } from "./i18n.js";
import { area, date as fmtDate, number } from "./format.js";

const NS = "http://www.w3.org/2000/svg";

function el(name, attrs = {}, parent) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
}

const dayNum = (iso) => Date.parse(`${iso}T12:00:00Z`) / 86_400_000;

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((m) => m * p).find((m) => m >= v);
}

// options: showRejected — показывать отброшенные снимки; normal — {area_m2} многолетняя норма;
//          summary — текстовое описание главного вывода для экранных читалок.
export function renderChart(container, series, yearly, { showRejected = false, normal = null, summary = "" } = {}) {
  container.textContent = "";
  const pts = series.filter((p) => p.valid || showRejected);
  if (!pts.length) return;

  const W = 760, H = 320, L = 72, R = 16, T = 14, B = 32;
  const x0 = dayNum(pts[0].date), x1 = Math.max(dayNum(pts[pts.length - 1].date), x0 + 1);
  // Верх шкалы по 95-му процентилю, чтобы пара выбросов (тень, снег) не сплющила график.
  // Точки выше верхней границы рисуются на краю треугольником.
  const sorted = pts.map((p) => p.area_m2).sort((a, b) => a - b);
  const p95 = sorted[Math.floor(0.95 * (sorted.length - 1))];
  const medMax = Math.max(0, ...yearly.map((y) => y.median_area_m2));
  const yMax = niceMax(Math.max(p95 * 1.25, medMax * 1.2, 1));
  const X = (d) => L + ((dayNum(d) - x0) / (x1 - x0)) * (W - L - R);
  const Y = (v) => H - B - (Math.min(v, yMax) / yMax) * (H - T - B);
  const axisArea = (v) => (yMax >= 1_000_000 ? `${number(v / 1e6, 1)} ${t("units.km2")}`
    : yMax >= 100_000 ? `${number(v / 1e6, 2)} ${t("units.km2")}` : `${number(v)} ${t("units.m2")}`);

  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img",
    "aria-label": [t("detail.chart"), summary].filter(Boolean).join(". ") }, container);

  for (let i = 0; i <= 4; i++) {
    const v = (yMax * i) / 4, y = Y(v);
    el("line", { x1: L, x2: W - R, y1: y, y2: y, class: "grid" }, svg);
    el("text", { x: L - 8, y: y + 4, "text-anchor": "end", class: "axis" }, svg).textContent = axisArea(v);
  }
  const y0 = new Date(pts[0].date).getUTCFullYear(), y1 = new Date(pts[pts.length - 1].date).getUTCFullYear();
  for (let y = y0; y <= y1; y++) {
    const mid = `${y}-08-15`;
    if (dayNum(mid) < x0 - 40 || dayNum(mid) > x1 + 40) continue;
    el("text", { x: Math.min(Math.max(X(mid), L + 14), W - R - 14), y: H - 9, "text-anchor": "middle", class: "axis" }, svg)
      .textContent = String(y);
  }

  if (normal && normal.area_m2 > 0 && normal.area_m2 < yMax) {
    const y = Y(normal.area_m2);
    el("line", { x1: L, x2: W - R, y1: y, y2: y, class: "norm" }, svg);   // подпись нормы — в легенде
  }

  const tooltip = document.getElementById("tooltip");
  const showAt = (x, y, text) => {
    tooltip.textContent = text;
    tooltip.hidden = false;
    const r = tooltip.getBoundingClientRect();
    tooltip.style.left = `${Math.max(8, Math.min(x + 12, innerWidth - r.width - 8))}px`;
    tooltip.style.top = `${Math.max(8, y - r.height - 10)}px`;
  };
  const hide = () => { tooltip.hidden = true; };

  for (const p of pts) {
    const cx = X(p.date), cy = Y(p.area_m2);
    const cls = p.valid ? "pt" : "pt rej";
    if (p.area_m2 > yMax) {
      el("path", { d: `M${cx - 4},${cy + 5} L${cx + 4},${cy + 5} L${cx},${cy - 2} Z`, class: cls }, svg);
    } else {
      el("circle", { cx, cy, r: 3.2, class: cls }, svg);
    }
    const hit = el("circle", { cx, cy, r: 11, class: "hit" }, svg);     // увеличенная зона наведения/касания
    const label = t("detail.tooltip", { date: fmtDate(p.date), area: area(p.area_m2) }) +
      (p.valid ? "" : ` · ${t("detail.legend.rejected")}`);
    hit.addEventListener("pointerenter", (e) => showAt(e.clientX, e.clientY, label));
    hit.addEventListener("pointermove", (e) => showAt(e.clientX, e.clientY, label));
    hit.addEventListener("pointerleave", hide);
  }

  const med = yearly.filter((y) => dayNum(`${y.year}-08-15`) >= x0 - 60);
  if (med.length > 1) {
    el("polyline", { class: "med", points: med.map((y) => `${X(`${y.year}-08-15`)},${Y(y.median_area_m2)}`).join(" ") }, svg);
  }
  // Точки медианы доступны с клавиатуры: Tab переходит по годам и показывает значение.
  for (const y of med) {
    const label = `${y.year}: ${area(y.median_area_m2)} (${t("detail.legend.median")})`;
    const dot = el("circle", { cx: X(`${y.year}-08-15`), cy: Y(y.median_area_m2), r: 5.5, class: "med-pt",
      tabindex: "0", role: "img", "aria-label": label }, svg);
    const fromDot = () => { const b = dot.getBoundingClientRect(); showAt(b.left + b.width / 2, b.top, label); };
    dot.addEventListener("pointerenter", fromDot);
    dot.addEventListener("pointerleave", hide);
    dot.addEventListener("focus", fromDot);
    dot.addEventListener("blur", hide);
  }
  svg.addEventListener("pointerleave", hide);
}

// Мини-график на карточке: столбики медианы по годам, последний год выделен.
export function sparkline(yearly, label) {
  if (!yearly?.length) return "";
  const W = 132, H = 48, gap = 4;
  const max = Math.max(...yearly.map((y) => y.median_area_m2), 1);
  const bw = (W - gap * (yearly.length - 1)) / yearly.length;
  const bars = yearly.map((y, i) => {
    const h = Math.max(2, (y.median_area_m2 / max) * (H - 2));
    return `<rect class="bar${i === yearly.length - 1 ? " last" : ""}" x="${(i * (bw + gap)).toFixed(1)}" y="${(H - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="2"/>`;
  }).join("");
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="${label}">${bars}</svg>`;
}
