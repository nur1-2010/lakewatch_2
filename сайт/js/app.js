// LakeWatch — фронтенд. Сайт из нескольких страниц (адрес после #):
//   #/              обзор: 3D-рельеф, главные цифры, озёра в фокусе
//   #/lakes         каталог озёр с фильтрами
//   #/map           карта озёр и путей стока
//   #/lake/<id>     страница озера; вкладки: /trend, /images, /place
//   #/risk          почему ледниковые озёра опасны
//   #/method        как считаются цифры и чего мы не показываем
//   #/about         о проекте и источники
import { LANGS, currentLang, detectLang, setLang, t, translateStatic } from "./i18n.js";
import { area, date as fmtDate, escapeHtml as esc, messageFormatters, number, pct, volume } from "./format.js";
import { renderChart, sparkline } from "./chart.js";
import { STATUS_ICON, findingIcon, icon } from "./icons.js";
import { createTerrain, webglAvailable } from "./terrain3d.js";

const API = "api";
const view = document.getElementById("view");
const stage = document.getElementById("stage");
const state = { lakes: null, meta: null, overview: null, details: {}, showRejected: false, map: null, routed: false,
                terrain: null, stageKey: "", renderId: 0, filter: "all", mapPick: null };

const name = (obj) => obj?.[currentLang()] ?? obj?.ru ?? "";
const msg = (finding) => t(finding.key, finding.params, messageFormatters);
const tf = (key, params) => t(key, params, messageFormatters);
const dir = (v, eps = 0.5) => (v === null || v === undefined || Math.abs(v) < eps ? "flat" : v > 0 ? "up" : "down");
const DIR_ICON = { up: "trending-up", down: "trending-down", flat: "minus" };
const signedArea = (m2) => `${m2 > 0 ? "+" : m2 < 0 ? "−" : ""}${area(Math.abs(m2))}`;
const lakeHref = (id, tab = "") => `#/lake/${encodeURIComponent(id)}${tab ? `/${tab}` : ""}`;
const needsAttention = (l) => ["alert", "watch"].includes(l.level) && l.role !== "reference";
const FLOW_COLOR = { almaty: "#d2522f", talgar: "#e0a021", other: "#3fd0c4" };
const TABS = ["overview", "trend", "images", "place"];

async function getJSON(path) {
  // Данные запрашиваются как файлы .json: так сайт одинаково работает и с сервером,
  // и как набор готовых файлов на статическом хостинге.
  const resp = await fetch(`${API}/${path}.json`);
  if (!resp.ok) throw new Error(`${path}: ${resp.status}`);
  return resp.json();
}

const badge = (s) =>
  `<span class="badge lvl-${esc(s.level)}">${icon(STATUS_ICON[s.status] || "info", "sm")}${esc(t(`status.${s.status}`))}</span>`;

function delta(value, label = "") {
  if (value === null || value === undefined) return "";
  const d = dir(value);
  return `<span class="delta ${d} num">${icon(DIR_ICON[d], "sm")}<b>${esc(pct(value))}</b>${label ? ` ${esc(label)}` : ""}</span>`;
}

// Куда течёт вода из озера — одной фразой.
function drainText(lake) {
  const d = lake.drainage;
  if (!d) return "";
  if (d.river) return t("drain.to", { river: name(d.river) }) + (d.downstream ? ` → ${t(`town.${d.downstream}`)}` : "");
  return t(`drain.exit.${d.exit}`);
}

// Площадь для крупного показа: число отдельно, единица отдельно (число «досчитывается» от нуля).
function areaParts(m2) {
  return Math.abs(m2) >= 100_000 ? { value: m2 / 1e6, digits: 2, unit: t("units.km2") }
                                  : { value: Math.round(m2 / 10) * 10, digits: 0, unit: t("units.m2") };
}

// Один показатель. value — либо {count, digits, unit} (анимируется), либо готовая строка.
function figure(label, value, note = "", cls = "") {
  const dd = typeof value === "object"
    ? `<span data-count="${value.count}" data-digits="${value.digits || 0}">0</span>${value.unit ? `<small>${esc(value.unit)}</small>` : ""}`
    : esc(value);
  return `<div class="figure ${cls}"><dt>${esc(label)}</dt><dd class="num">${dd}</dd>${note ? `<span class="note num">${note}</span>` : ""}</div>`;
}

function countUp(root = document) {
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  root.querySelectorAll("[data-count]").forEach((el) => {
    const to = Number(el.dataset.count), digits = Number(el.dataset.digits || 0);
    const show = (v) => { el.textContent = number(v, digits); };
    if (still || !Number.isFinite(to)) { show(to); return; }
    show(0);
    const io = new IntersectionObserver((entries) => {
      if (!entries[0].isIntersecting) return;
      io.disconnect();
      const start = performance.now(), dur = 1200;
      const tick = (now) => {
        const p = Math.min(1, (now - start) / dur);
        show(to * (1 - (1 - p) ** 3));
        if (p < 1) requestAnimationFrame(tick); else show(to);
      };
      requestAnimationFrame(tick);
    }, { threshold: 0.4 });
    io.observe(el);
  });
}

// ------------------------------------------------------------------ сцена (верх страницы)

// Сцена перерисовывается только когда меняется её «ключ». При переходе между вкладками одного
// озера ключ тот же, поэтому 3D-рельеф не создаётся заново и страница не подвисает.
function setStage(key, html, kind, after) {
  document.body.dataset.stage = kind;
  if (state.stageKey === key) return;
  state.terrain?.dispose();
  state.terrain = null;
  state.stageKey = key;
  state.renderId++;
  stage.innerHTML = html;
  after?.();
}

function pageHead(key, title, lead) {
  setStage(`page:${key}:${currentLang()}`, `
  <section class="page-head" aria-labelledby="page-h">
    <div class="ridges" aria-hidden="true"><i></i><i></i><i></i></div>
    <div class="wrap">
      <p class="kicker label">${esc(t("hero.kicker"))}</p>
      <h1 id="page-h" tabindex="-1">${esc(title)}</h1>
      ${lead ? `<p class="lead">${esc(lead)}</p>` : ""}
    </div>
  </section>`, "page");
}

async function mountTerrain(options = {}) {
  const host = stage.querySelector(".t3d");
  const hero = stage.querySelector(".hero3d");
  if (!host) return;
  if (!webglAvailable()) { hero.classList.add("no-3d"); return; }
  const myRender = state.renderId;
  // подписи на сцене — только у трёх самых важных озёр, иначе они закрывают горы
  const labelled = new Set(state.lakes.filter(needsAttention).slice(0, 3).map((l) => l.id));
  const lakes = state.lakes.map((l) => ({
    labelled: labelled.has(l.id),
    id: l.id, lon: l.lon, lat: l.lat, level: l.level, area_m2: l.current?.area_m2 ?? 0, yearly: l.yearly || [],
    label: name(l.name), sub: `${t(`status.${l.status}`)}${l.current ? ` · ${area(l.current.area_m2)}` : ""}`,
    href: lakeHref(l.id), main: l.role !== "reference",
    // на странице озера высокий флажок только у него самого, остальные озёра — маленькие точки
    prominent: options.focusId ? l.id === options.focusId : needsAttention(l),
  }));
  try {
    const terrain = await createTerrain(host, lakes, {
      ...options, mode: state.terrainMode,
      onSelect: (id) => showSceneCard(id, options.focusId),
    });
    if (myRender !== state.renderId) { terrain.dispose(); return; }     // пока грузилось, страницу сменили
    state.terrain = terrain;
    mountSceneUi(host, terrain);
  } catch (err) {
    console.error(err);
    hero.classList.add("no-3d");
  }
}

// Кнопки «Спутник / Рельеф», подсказка и карточка выбранного озера поверх 3D-сцены.
function mountSceneUi(host, terrain) {
  const ui = document.createElement("div");
  ui.className = "t3d-ui";
  ui.innerHTML = `
    <div class="t3d-tools">
      ${terrain.hasSatellite ? `<div class="t3d-modes" role="group" aria-label="${esc(t("terrain.mode"))}">
        <button type="button" data-mode="satellite">${esc(t("terrain.satellite"))}</button>
        <button type="button" data-mode="relief">${esc(t("terrain.relief"))}</button>
      </div>` : ""}
      <p class="t3d-tip">${esc(t("terrain.tip"))}</p>
    </div>
    <section class="t3d-card" id="t3d-card" hidden aria-live="polite"></section>`;
  host.appendChild(ui);
  const syncModes = () => ui.querySelectorAll("[data-mode]").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.mode === terrain.mode)));
  ui.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => {
    state.terrainMode = terrain.setMode(b.dataset.mode);
    syncModes();
  }));
  syncModes();
}

// Карточка озера, выбранного на 3D-сцене. Стрелки листают озёра по порядку списка,
// и камера каждый раз перелетает к следующему — так можно обойти все озёра, не уходя со сцены.
function showSceneCard(id, pageLakeId = null) {
  const card = document.getElementById("t3d-card");
  if (!card) return;
  const lake = state.lakes.find((l) => l.id === id);
  if (!lake || id === pageLakeId) { card.hidden = true; card.innerHTML = ""; return; }
  const list = state.lakes;
  const i = list.indexOf(lake);
  const cur = lake.current, yoy = lake.year_over_year;
  const where = [lake.elevation_m ? `${number(lake.elevation_m)} ${t("units.m")}` : "", drainText(lake)].filter(Boolean).join(" · ");
  card.innerHTML = `
    <button type="button" class="t3d-close" data-act="close" aria-label="${esc(t("scene.close"))}">×</button>
    <div>${badge(lake)}</div>
    <h3>${esc(name(lake.name))}</h3>
    ${cur ? `<p class="t3d-card-area num"><b>${esc(area(cur.area_m2))}</b>
      ${yoy && lake.status !== "new_lake" ? delta(yoy.change_pct, t("card.vs_prev", { year: yoy.prev_year })) : ""}</p>` : ""}
    ${where ? `<p class="t3d-card-where">${esc(where)}</p>` : ""}
    <p class="t3d-card-head">${lake.headline ? esc(msg(lake.headline)) : ""}</p>
    <div class="t3d-card-actions">
      <button type="button" class="t3d-step" data-act="prev" aria-label="${esc(t("scene.prev"))}">${icon("chevron", "sm")}</button>
      <a class="btn primary" href="${lakeHref(lake.id)}">${esc(t("card.open"))}${icon("chevron", "sm")}</a>
      <button type="button" class="t3d-step" data-act="next" aria-label="${esc(t("scene.next"))}">${icon("chevron", "sm")}</button>
    </div>
    <p class="t3d-card-count num">${i + 1} / ${list.length}</p>`;
  card.hidden = false;
  const go = (step) => state.terrain?.select(list[(i + step + list.length) % list.length].id);
  card.querySelector('[data-act="close"]').addEventListener("click", () => state.terrain?.select(null));
  card.querySelector('[data-act="prev"]').addEventListener("click", () => go(-1));
  card.querySelector('[data-act="next"]').addEventListener("click", () => go(1));
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !document.getElementById("t3d-card")?.hidden) state.terrain?.select(null);
});

// ------------------------------------------------------------------ общие элементы

function renderChrome() {
  translateStatic(document);
  document.querySelectorAll(".lang button").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.lang === currentLang())));
  const run = state.meta?.last_run;
  document.getElementById("updated").textContent = run?.finished_at ? t("updated", { date: fmtDate(run.finished_at) }) : "";
}

function setActiveNav(key) {
  document.querySelectorAll(".nav a").forEach((a) => {
    if (a.dataset.nav === key) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
}

function satelliteLayer() {
  // спутниковая подложка в горах есть примерно до 15-го приближения
  return L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 17, maxNativeZoom: 15,
    attribution: "Tiles © Esri — Esri, Maxar, Earthstar Geographics · © OpenStreetMap",
  });
}

function flowLine(lake, map, weight = 2) {
  const path = lake.drainage?.path;
  if (!path?.length) return null;
  const color = FLOW_COLOR[lake.drainage.downstream] || FLOW_COLOR.other;
  return L.polyline(path.map(([lon, lat]) => [lat, lon]), { color, weight, opacity: 0.9, interactive: false }).addTo(map);
}

function photoCard(l) {
  const cur = l.current;
  return `<li><a class="photo-card" href="${lakeHref(l.id)}">
    ${l.preview ? `<img src="${esc(l.preview)}" alt="" loading="lazy" width="800" height="800">` : ""}
    <span class="cap">${badge(l)}<h3>${esc(name(l.name))}</h3>
      <span class="sub num">${cur ? esc(area(cur.area_m2)) : ""}${l.year_over_year?.change_pct != null && l.status !== "new_lake"
        ? ` · ${esc(pct(l.year_over_year.change_pct))} ${esc(t("card.vs_prev", { year: l.year_over_year.prev_year }))}` : ""}</span></span>
  </a></li>`;
}

// ------------------------------------------------------------------ «машина времени» на 3D-сцене
// Кнопка прокручивает годы наблюдений, и круги озёр на рельефе растут и уменьшаются по настоящим
// измерениям. Рядом показана суммарная площадь за выбранный год — только по тем озёрам, у которых
// есть данные за все годы, иначе сумма менялась бы просто потому, что меняется набор озёр.

function timeSeriesTotals(o) {
  const years = [];
  for (let y = o.year_from; y <= o.year_to; y++) years.push(y);
  const full = state.lakes.filter((l) => l.role !== "reference" &&
    years.every((y) => (l.yearly || []).some((r) => r.year === y)));
  const totals = Object.fromEntries(years.map((y) =>
    [y, full.reduce((sum, l) => sum + l.yearly.find((r) => r.year === y).median_area_m2, 0)]));
  return { years, totals, count: full.length };
}

function timeMachineHtml(o) {
  if (!o.year_from || !o.year_to || o.year_to <= o.year_from) return "";
  return `
  <div class="tm" role="group" aria-label="${esc(t("time.title"))}">
    <button type="button" class="tm-play" id="tm-play" aria-pressed="false">
      <span class="tm-ico">${icon("play")}</span><span id="tm-play-label">${esc(t("time.play"))}</span></button>
    <div class="tm-body">
      <div class="tm-read"><output class="tm-year num" id="tm-year" for="tm-range">${o.year_to}</output>
        <span class="tm-total num" id="tm-total" aria-live="polite"></span></div>
      <input type="range" id="tm-range" min="${o.year_from}" max="${o.year_to}" step="1" value="${o.year_to}" aria-label="${esc(t("time.year"))}">
      <div class="tm-ends num" aria-hidden="true"><span>${o.year_from}</span><span>${o.year_to}</span></div>
    </div>
  </div>`;
}

function bindTimeMachine(o) {
  const range = document.getElementById("tm-range");
  if (!range) return;
  const play = document.getElementById("tm-play"), label = document.getElementById("tm-play-label");
  const yearOut = document.getElementById("tm-year"), totalOut = document.getElementById("tm-total");
  const { totals, count } = timeSeriesTotals(o);
  let timer = 0;

  const show = (year) => {
    range.value = String(year);
    yearOut.textContent = String(year);
    totalOut.textContent = count ? tf("time.total", { area: totals[year], count }) : "";
    // в последнем году показываем текущее состояние (в нём учтены и озёра без полного ряда)
    state.terrain?.setYear(year === o.year_to ? null : year);
  };
  const stop = () => {
    clearInterval(timer); timer = 0;
    play.setAttribute("aria-pressed", "false");
    play.querySelector(".tm-ico").innerHTML = icon("play");
    label.textContent = t("time.play");
  };
  const start = () => {
    let year = o.year_from;
    show(year);
    play.setAttribute("aria-pressed", "true");
    play.querySelector(".tm-ico").innerHTML = icon("pause");
    label.textContent = t("time.pause");
    timer = setInterval(() => {
      // страницу сменили, а таймер ещё жив — останавливаемся, чтобы не работать вхолостую
      if (!document.body.contains(range)) { clearInterval(timer); return; }
      year += 1;
      show(year);
      if (year >= o.year_to) stop();
    }, 1500);
  };
  play.addEventListener("click", () => (timer ? stop() : start()));
  range.addEventListener("input", () => { if (timer) stop(); show(Number(range.value)); });
  show(o.year_to);
}

// ------------------------------------------------------------------ страница: обзор

function renderHome() {
  const o = state.overview || {};
  const monitored = state.lakes.filter((l) => l.role !== "reference");
  const attention = monitored.filter(needsAttention);
  const total = o.total_area;
  const totalParts = total ? areaParts(total.area_m2) : null;
  const featured = [...attention, ...monitored.filter((l) => !needsAttention(l) && l.preview)].slice(0, 3);

  setStage(`home:${currentLang()}`, `
  <section class="hero3d" aria-labelledby="hero-h">
    <div class="t3d" id="terrain" role="img" aria-label="${esc(t("terrain.aria"))}"></div>
    <div class="wrap hero3d-inner">
      <div class="hero3d-text">
        <p class="kicker label">${esc(t("hero.eyebrow"))}</p>
        <h1 id="hero-h">${esc(t("hero.title"))}</h1>
        <p class="lead">${esc(t("hero.lead"))}</p>
        <div class="hero-actions">
          <a class="btn dawn" href="#/lakes">${esc(t("hero.cta"))}${icon("chevron", "sm")}</a>
          <a class="btn ghost" href="#/map">${esc(t("nav.map"))}</a>
        </div>
      </div>
      <div class="hero-foot">
        <p class="t3d-caption">${esc(t("terrain.caption"))}</p>
        ${timeMachineHtml(o)}
      </div>
    </div>
  </section>`, "hero", () => {
    mountTerrain({ labels: "prominent", frame: "block", distance: 46, elevation: 0.34, azimuth: 0.2, shiftX: 0.17, shiftY: 0.02, focusDistance: 21 });
    bindTimeMachine(o);
  });

  const tiles = [
    ["t-lake", "#/lakes", "tile.lakes", { from: o.year_from, to: o.year_to }],
    ["t-moss", "#/map", "tile.map", {}],
    ["t-dawn", "#/risk", "tile.risk", {}],
    ["t-ice", "#/method", "tile.method", {}],
  ];

  view.innerHTML = `
  <div class="fade-in">
    <dl class="figures">
      ${figure(t("stat.lakes"), { count: o.lakes_monitored ?? 0 },
        o.lakes_hidden ? esc(t("stat.hidden", { count: number(o.lakes_hidden) })) : `${o.year_from ?? ""}–${o.year_to ?? ""}`)}
      ${figure(t("stat.attention"), { count: o.lakes_attention ?? 0 },
        `${icon(o.lakes_attention ? "alert" : "check", "sm")}${esc([...new Set(attention.map((l) => t(`status.${l.status}`)))].join(" · ") || t("status.stable"))}`,
        o.lakes_attention ? "attn" : "")}
      ${totalParts ? figure(`${t("stat.total")}, ${total.year}`, { count: totalParts.value, digits: totalParts.digits, unit: totalParts.unit },
        `${icon(DIR_ICON[total.direction], "sm")}${esc(pct(total.change_pct))} ${esc(t("card.vs_prev", { year: total.prev_year }))}`, total.direction) : ""}
      ${figure(t("stat.images"), { count: o.observations ?? 0 }, `Sentinel-2 · ${o.year_from ?? ""}–${o.year_to ?? ""}`)}
    </dl>

    <section class="statement lvl-${attention.length ? "watch" : "normal"}" aria-labelledby="ov-h">
      <h2 id="ov-h">${icon(attention.length ? "alert" : "check", "sm")}${esc(t("overview.title"))}</h2>
      <p>${total ? esc(tf(`overview.total.${total.direction}`, { year: total.year, prev_year: total.prev_year, area: total.area_m2,
          prev_area: total.prev_area_m2, pct: Math.abs(Math.round(total.change_pct ?? 0)) })) : esc(t("alerts.none"))}</p>
      <div class="links">${attention.length
        ? `${esc(t("alerts.some", { count: attention.length }))}: ${attention.map((l) => `<a href="${lakeHref(l.id)}">${esc(name(l.name))}</a>`).join(", ")}.`
        : esc(t("alerts.none"))}</div>
    </section>

    ${featured.length ? `<section class="section" aria-labelledby="focus-h">
      <div class="section-head"><h2 id="focus-h">${esc(t("home.focus_title"))}</h2>
        <a class="btn" href="#/lakes">${esc(t("home.all_lakes"))}${icon("chevron", "sm")}</a></div>
      <ul class="featured">${featured.map(photoCard).join("")}</ul>
    </section>` : ""}

    <section class="section" aria-labelledby="explore-h">
      <div class="section-head"><h2 id="explore-h">${esc(t("home.explore"))}</h2></div>
      <ul class="tiles">${tiles.map(([cls, href, key, params]) => `
        <li><a class="tile ${cls}" href="${href}"><h3>${esc(t(`${key}.t`))}</h3><p>${esc(t(`${key}.d`, params))}</p>
          <span class="go">${esc(t("card.open"))}${icon("chevron", "sm")}</span></a></li>`).join("")}</ul>
    </section>
  </div>`;
  countUp(view);
}

// ------------------------------------------------------------------ страница: каталог озёр

function lakeRow(l) {
  const cur = l.current, yoy = l.year_over_year, years = l.yearly || [];
  const parts = cur ? areaParts(cur.area_m2) : null;
  const where = [l.elevation_m ? `${number(l.elevation_m)} ${t("units.m")}` : "", drainText(l)].filter(Boolean).join(" · ");
  const tags = [needsAttention(l) ? "attention" : "", l.drainage?.downstream || ""].filter(Boolean).join(" ");
  return `
  <li data-tags="${esc(tags)}"><a class="row" href="${lakeHref(l.id)}">
    <span><h3>${esc(name(l.name))}</h3><span class="where num">${esc(where)}</span></span>
    <span class="meta">
      ${badge(l)}
      <span class="area num">${parts ? `${esc(number(parts.value, parts.digits))}<small>${esc(parts.unit)}</small>` : "—"}</span>
      <span>${yoy && l.status !== "new_lake" ? delta(yoy.change_pct) : ""}</span>
      <span>${years.length > 1 ? sparkline(years, esc(t("card.spark", { from: years[0].year, to: years[years.length - 1].year }))) : ""}</span>
    </span>
    ${icon("chevron", "go")}
  </a></li>`;
}

function applyFilter() {
  let shown = 0;
  for (const li of view.querySelectorAll(".index > li")) {
    const ok = state.filter === "all" || li.dataset.tags.split(" ").includes(state.filter);
    li.hidden = !ok;
    if (ok) shown++;
  }
  view.querySelectorAll(".filters button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.filter === state.filter)));
  const empty = view.querySelector(".empty");
  if (empty) empty.hidden = shown > 0;
}

function renderLakes() {
  pageHead("lakes", t("page.lakes.title"), t("page.lakes.lead"));
  const monitored = state.lakes.filter((l) => l.role !== "reference");
  const counts = { all: state.lakes.length, attention: monitored.filter(needsAttention).length,
                   almaty: monitored.filter((l) => l.drainage?.downstream === "almaty").length,
                   talgar: monitored.filter((l) => l.drainage?.downstream === "talgar").length };
  view.innerHTML = `
  <div class="fade-in">
    <div class="filters" role="group" aria-label="${esc(t("page.lakes.title"))}">
      ${["all", "attention", "almaty", "talgar"].map((f) =>
        `<button type="button" data-filter="${f}">${esc(t(`filter.${f}`))}<span class="count">${counts[f]}</span></button>`).join("")}
    </div>
    <ol class="index">${state.lakes.map(lakeRow).join("")}</ol>
    <p class="empty" hidden>${esc(t("list.empty"))}</p>
  </div>`;
  view.querySelectorAll(".filters button").forEach((b) =>
    b.addEventListener("click", () => { state.filter = b.dataset.filter; applyFilter(); }));
  applyFilter();
}

// ------------------------------------------------------------------ страница: карта

function mapSide(l) {
  if (!l) {
    return `<h3>${esc(t("map.pick"))}</h3><p class="muted">${esc(t("map.pick_hint"))}</p>`;
  }
  const cur = l.current, yoy = l.year_over_year;
  return `
    <div>${badge(l)}</div>
    <h3>${esc(name(l.name))}</h3>
    ${cur ? `<div><div class="muted" style="font-size:13px">${esc(t("card.area", { year: cur.year }))}</div><div class="area num">${esc(area(cur.area_m2))}</div></div>` : ""}
    ${yoy && l.status !== "new_lake" ? `<div>${delta(yoy.change_pct, t("card.vs_prev", { year: yoy.prev_year }))}</div>` : ""}
    ${drainText(l) ? `<p class="muted" style="font-size:14px">${esc(drainText(l))}</p>` : ""}
    <a class="btn primary" href="${lakeHref(l.id)}">${esc(t("card.open"))}${icon("chevron", "sm")}</a>`;
}

function renderMap() {
  pageHead("map", t("page.map.title"), t("page.map.lead"));
  view.innerHTML = `
  <div class="fade-in">
    <div class="map-layout">
      <div id="map" role="region" aria-label="${esc(t("page.map.title"))}"></div>
      <aside class="map-side glass" aria-live="polite">
        <div id="map-pick" style="display:grid;gap:var(--s-3)"></div>
        <div class="map-legend">
          <span><i style="border-color:${FLOW_COLOR.almaty}"></i>${esc(t("map.flow", { town: t("town.almaty") }))}</span>
          <span><i style="border-color:${FLOW_COLOR.talgar}"></i>${esc(t("map.flow", { town: t("town.talgar") }))}</span>
          <span><i style="border-color:${FLOW_COLOR.other}"></i>${esc(t("map.flow_other"))}</span>
        </div>
      </aside>
    </div>
    <p class="hint-text">${esc(t("drain.note"))}</p>
  </div>`;

  const pick = document.getElementById("map-pick");
  const map = L.map("map", { scrollWheelZoom: false });
  satelliteLayer().addTo(map);
  const bounds = [], pins = {};
  // Нажатие на метку выбирает озеро и показывает его в панели сбоку. Всплывающих окон на карте нет:
  // раньше окно открывалось поверх меток, сдвигало карту и мешало выбрать соседнее озеро.
  const select = (l) => {
    state.mapPick = l?.id ?? null;
    pick.innerHTML = mapSide(l);
    for (const [id, el] of Object.entries(pins)) el.classList.toggle("on", id === state.mapPick);
  };
  for (const l of state.lakes) {
    flowLine(l, map);
    const big = needsAttention(l);
    const size = big ? 24 : 16;
    const marker = L.marker([l.lat, l.lon], {
      icon: L.divIcon({ className: "", iconSize: [size, size], iconAnchor: [size / 2, size / 2],
        html: `<span class="map-pin ${big ? "big" : ""} lvl-${esc(l.level)}"></span>` }),
      title: name(l.name), alt: `${name(l.name)} — ${t(`status.${l.status}`)}`, zIndexOffset: big ? 500 : 0,
    }).addTo(map);
    marker.on("click", () => select(l));
    marker.on("add", () => { pins[l.id] = marker.getElement()?.querySelector(".map-pin"); });
    pins[l.id] = marker.getElement()?.querySelector(".map-pin");
    bounds.push([l.lat, l.lon]);
  }
  map.on("click", () => select(null));
  map.fitBounds(bounds, { padding: [40, 40], maxZoom: 13 });
  state.map = map;
  select(state.lakes.find((l) => l.id === state.mapPick) || null);
}

// ------------------------------------------------------------------ страница озера

function lakeFigures(a) {
  const cur = a.current;
  if (!cur) return "";
  const out = [];
  const p = areaParts(cur.area_m2);
  const arrow = (d) => icon(DIR_ICON[d], "sm");
  out.push(figure(t("kpi.area", { year: cur.year }), { count: p.value, digits: p.digits, unit: p.unit },
    esc(t("kpi.hint.median", { count: number(cur.observations) }))));
  if (a.normal && a.change_vs_normal_pct !== null) {
    const d = dir(a.change_vs_normal_pct);
    out.push(figure(t("kpi.vs_normal"), pct(a.change_vs_normal_pct), `${arrow(d)}${esc(tf("kpi.hint.normal", { area: a.normal.area_m2 }))}`, d));
  }
  const yoy = a.year_over_year;
  if (yoy) {
    const d = dir(yoy.change_pct ?? yoy.change_m2);
    out.push(figure(t("kpi.vs_prev", { year: yoy.prev_year }), yoy.change_pct !== null ? pct(yoy.change_pct) : signedArea(yoy.change_m2),
      `${arrow(d)}${esc(tf("kpi.hint.was", { area: yoy.prev_area_m2 }))}`, d));
  }
  const since = a.since_start;
  if (since && since.year !== cur.year) {
    const d = dir(since.change_pct ?? since.change_m2);
    out.push(figure(t("kpi.since", { year: since.year }), since.change_pct !== null ? pct(since.change_pct) : signedArea(since.change_m2),
      `${arrow(d)}${esc(tf("kpi.hint.was", { area: since.area_m2 }))}`, d));
  }
  if (a.trend) {
    const d = a.trend.direction;
    out.push(figure(t("kpi.trend"), signedArea(a.trend.m2_per_year), `${arrow(d)}${esc(t("kpi.hint.trend", { from: a.trend.year_from, to: a.trend.year_to }))}`, d));
  }
  if (a.volume_estimate) out.push(figure(t("kpi.volume"), `≈ ${volume(a.volume_estimate.m3)}`, esc(t("kpi.hint.volume"))));
  return `<dl class="figures six compact">${out.join("")}</dl>`;
}

function findingItem(f) {
  const d = /\.(up|grew)$/.test(f.key) ? "up" : /\.(down|shrank|gone)$/.test(f.key) ? "down" : "";
  return `<li class="${d}"><span class="ico">${icon(findingIcon(f.key))}</span><p>${esc(msg(f))}</p></li>`;
}

function yearlyTable(a) {
  const rows = a.yearly || [];
  if (!rows.length) return "";
  const max = Math.max(...rows.map((y) => y.median_area_m2), 1);
  const curYear = a.current?.year;
  const body = [...rows].reverse().map((y) => {
    const d = dir(y.change_pct, 3);
    const chg = y.change_pct === null
      ? (y.change_m2 ? `<span class="chg ${dir(y.change_m2)} num">${icon(DIR_ICON[dir(y.change_m2)], "sm")}${esc(signedArea(y.change_m2))}</span>` : `<span class="chg flat">—</span>`)
      : `<span class="chg ${d} num">${icon(DIR_ICON[d], "sm")}${esc(pct(y.change_pct))}</span>`;
    return `<tr class="${y.year === curYear ? "current" : ""}">
      <td class="num">${y.year}</td>
      <td class="num">${esc(area(y.median_area_m2))}</td>
      <td class="bar-cell" aria-hidden="true"><span class="bar-track"><span class="bar-fill" style="width:${Math.max(1, (100 * y.median_area_m2) / max).toFixed(1)}%"></span></span></td>
      <td>${chg}</td>
      <td class="num">${number(y.observations)}</td>
    </tr>`;
  }).join("");
  return `
    <div class="table-scroll"><table class="years">
      <thead><tr>
        <th scope="col">${esc(t("detail.year"))}</th><th scope="col">${esc(t("detail.median_area"))}</th>
        <th scope="col" aria-hidden="true"></th><th scope="col">${esc(t("detail.change_prev"))}</th>
        <th scope="col">${esc(t("detail.images_count"))}</th>
      </tr></thead><tbody>${body}</tbody>
    </table></div>
    <p class="hint-text">${esc(t("detail.yearly_hint"))}</p>`;
}

function factRows(lake) {
  const d = lake.drainage, g = lake.glacier;
  const rows = [];
  const add = (k, v) => { if (v) rows.push(`<div><dt>${esc(k)}</dt><dd class="num">${esc(v)}</dd></div>`); };
  add(t("detail.elevation"), lake.elevation_m ? `${number(lake.elevation_m)} ${t("units.m")}` : "");
  add(t("detail.coords"), `${lake.lat.toFixed(4)}° N, ${lake.lon.toFixed(4)}° E`);
  if (g) add(t("detail.glacier"), [g.name ? name(g.name) : "", t("detail.glacier_dist", { distance: number(g.distance_m) })].filter(Boolean).join(", "));
  if (d) {
    add(t("detail.drain"), d.river ? name(d.river) : t(`drain.exit.${d.exit}`));
    add(t("drain.downstream"), d.downstream ? t(`town.${d.downstream}`) : t("drain.unknown"));
  }
  add(t("detail.source"), (lake.sources || []).join("; "));
  return rows.join("");
}

function tabOverview(d) {
  const lake = d.lake, a = d.analysis, findings = a.findings || [];
  const drain = drainText(lake);
  return `
    <p class="lead-text">${esc(name(lake.description))}${drain ? ` ${esc(drain.replace(/^./, (c) => c.toUpperCase()))}.` : ""}</p>
    ${lakeFigures(a)}
    ${a.meaning ? `<section class="statement lvl-${esc(a.level)}" aria-labelledby="mean-h">
      <h2 id="mean-h">${icon(STATUS_ICON[a.status] || "info", "sm")}${esc(t("detail.meaning"))}</h2>
      <p>${esc(findings[0] ? msg(findings[0]) : "")}</p><div class="links">${esc(t(a.meaning))}</div>
    </section>` : ""}
    <section class="block" aria-labelledby="find-h">
      <h2 id="find-h">${esc(t("detail.findings"))}</h2>
      <ul class="findings">${findings.slice(a.meaning ? 1 : 0).map(findingItem).join("")}</ul>
    </section>
    <div class="next-links">
      <a class="btn primary" href="${lakeHref(lake.id, "trend")}">${esc(t("tab.trend"))}${icon("chevron", "sm")}</a>
      <a class="btn" href="${lakeHref(lake.id, "images")}">${esc(t("tab.images"))}</a>
      <a class="btn" href="${lakeHref(lake.id, "place")}">${esc(t("tab.place"))}</a>
    </div>`;
}

function tabTrend(d) {
  const a = d.analysis;
  return `
    <section class="block" aria-labelledby="chart-h">
      <h2 id="chart-h">${esc(t("detail.chart"))}</h2>
      <div id="chart"></div>
      <div class="legend">
        <span class="key"><i style="background:var(--water)"></i>${esc(t("detail.legend.obs"))}</span>
        <span class="key"><i class="line"></i>${esc(t("detail.legend.median"))}</span>
        ${a.normal ? `<span class="key"><i class="dash"></i>${esc(tf("kpi.hint.normal", { area: a.normal.area_m2 }))}</span>` : ""}
        <label><input type="checkbox" id="rej" ${state.showRejected ? "checked" : ""}> ${esc(t("detail.show_rejected"))}</label>
      </div>
      <p class="hint-text">${esc(t("detail.observations", { valid: number(a.observations_valid), total: number(a.observations_total) }))}</p>
    </section>
    <section class="block" aria-labelledby="years-h">
      <h2 id="years-h">${esc(t("detail.yearly"))}</h2>
      ${yearlyTable(a)}
    </section>`;
}

function tabImages(d) {
  return d.previews?.length
    ? `<section class="block frames" id="frames" aria-labelledby="img-h"></section>`
    : `<section class="block"><p class="muted">${esc(t("headline.insufficient", { count: 0, years: 0 }))}</p></section>`;
}

// Таблица измерений собирается прямо в браузере из уже загруженных данных,
// поэтому отдельные файлы .csv на сервере не нужны.
const CSV_FIELDS = ["date", "area_m2", "scl_water_m2", "cloud_pct", "snow_pct", "valid", "rejected_reason"];
function csvHref(series) {
  const cell = (v) => (v === null || v === undefined ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const rows = [CSV_FIELDS.join(","), ...(series || []).map((p) => CSV_FIELDS.map((f) => cell(p[f])).join(","))];
  return `data:text/csv;charset=utf-8,${encodeURIComponent(rows.join("\n") + "\n")}`;
}

function tabPlace(d) {
  const lake = d.lake;
  return `
    <div class="two-col">
      <section class="block" aria-labelledby="place-h">
        <h2 id="place-h">${esc(t("detail.location"))}</h2>
        <div id="lake-map" role="region" aria-label="${esc(t("detail.location"))}"></div>
        ${lake.drainage ? `<p class="hint-text">${esc(t("drain.note"))}</p>` : ""}
      </section>
      <section class="block" aria-labelledby="facts-h">
        <h2 id="facts-h">${esc(t("detail.facts"))}</h2>
        <dl class="facts">${factRows(lake)}</dl>
        <div class="actions">
          <a class="btn primary" href="${csvHref(d.series)}" download="${esc(lake.id)}_observations.csv">${icon("download", "sm")}${esc(t("detail.download"))}</a>
          ${lake.osm_id ? `<a class="btn" href="https://www.openstreetmap.org/${esc(lake.osm_id)}" target="_blank" rel="noopener">${icon("external", "sm")}${esc(t("detail.osm"))}</a>` : ""}
        </div>
      </section>
    </div>`;
}

function renderLake(d, tab) {
  const lake = d.lake, a = d.analysis;
  const nameNote = lake.name_status && t(`name_status.${lake.name_status}`);

  setStage(`lake:${lake.id}:${currentLang()}`, `
  <section class="hero3d compact" aria-labelledby="lake-h">
    <div class="t3d" id="terrain" role="img" aria-label="${esc(t("terrain.aria"))}"></div>
    <div class="wrap hero3d-inner">
      <nav aria-label="${esc(t("detail.breadcrumb"))}"><ol class="breadcrumb">
        <li><a href="#/lakes">${esc(t("nav.lakes"))}</a>${icon("chevron", "sm")}</li>
        <li aria-current="page">${esc(name(lake.name))}</li>
      </ol></nav>
      <div class="hero3d-text">
        <div class="detail-head">${badge(a)}${lake.role === "reference" ? `<span class="chip">${esc(t("role.reference"))}</span>` : ""}</div>
        <h1 id="lake-h" tabindex="-1">${esc(name(lake.name))}</h1>
        ${nameNote ? `<p class="name-note">${icon("info", "sm")}<span>${esc(nameNote)}</span></p>` : ""}
      </div>
    </div>
  </section>`, "hero", () =>
    mountTerrain({ labels: "focus", focusId: lake.id, focusDistance: 12, azimuth: 0.35, shiftX: 0.18, shiftY: 0.02 }));

  const body = { overview: tabOverview, trend: tabTrend, images: tabImages, place: tabPlace }[tab](d);
  view.innerHTML = `
  <nav class="tabs" id="tabs" aria-label="${esc(t("detail.tabs"))}">
    ${TABS.map((k) => `<a href="${lakeHref(lake.id, k === "overview" ? "" : k)}" ${k === tab ? 'aria-current="page"' : ""}>${esc(t(`tab.${k}`))}</a>`).join("")}
  </nav>
  <article class="detail fade-in">${body}</article>`;
  countUp(view);

  if (tab === "trend") {
    const summary = a.findings?.[0] ? msg(a.findings[0]) : "";
    const draw = () => renderChart(document.getElementById("chart"), d.series, a.yearly || [],
      { showRejected: state.showRejected, normal: a.normal, summary });
    draw();
    document.getElementById("rej").addEventListener("change", (e) => { state.showRejected = e.target.checked; draw(); });
  }
  if (tab === "images" && d.previews?.length) renderFrames(d.previews, d.preview_frame_scale || 1, lake);
  if (tab === "place") {
    const map = L.map("lake-map", { scrollWheelZoom: false });
    satelliteLayer().addTo(map);
    const [x0, y0, x1, y1] = lake.bbox;
    L.rectangle([[y0, x0], [y1, x1]], { color: "#ffffff", weight: 1.5, dashArray: "5 5", fill: false, interactive: false }).addTo(map);
    const line = flowLine(lake, map, 3);
    // показываем озеро и первые километры стока, а не весь путь до края карты
    const near = (lake.drainage?.path || []).slice(0, 14).map(([lon, lat]) => [lat, lon]);
    map.fitBounds(L.latLngBounds([[y0, x0], [y1, x1], ...near]), { padding: [26, 26], maxZoom: 15 });
    if (line) line.bringToBack();
    state.map = map;
  }
}

function renderFrames(previews, frameScale = 1, lake = null) {
  const box = document.getElementById("frames");
  const last = previews.length - 1;            // по одному кадру на год: последний — самый свежий
  // кадр шире квадрата измерения в frameScale раз: квадрат занимает середину картинки
  const inset = (((1 - 1 / frameScale) / 2) * 100).toFixed(2);
  let scaleBar = "";
  if (lake?.half_size_m) {
    const frameM = lake.half_size_m * 2 * frameScale;
    const barM = [100, 200, 250, 500, 1000, 2000].reduce((best, v) => (Math.abs(v - frameM / 4) < Math.abs(best - frameM / 4) ? v : best));
    const label = barM >= 1000 ? `${number(barM / 1000)} ${t("units.km")}` : `${number(barM)} ${t("units.m")}`;
    scaleBar = `<span class="frame-scale">${esc(label)}<i style="width:${((barM / frameM) * 100).toFixed(2)}cqw"></i></span>`;
  }
  box.innerHTML = `
    <h2 id="img-h">${esc(t("detail.images"))}</h2>
    <figure>
      <div class="frame-box">
        <img id="frame-img" alt="" width="800" height="800">
        <span class="frame-area" style="inset:${inset}%"></span>
        <span class="frame-year num" id="frame-year" aria-hidden="true"></span>
        ${scaleBar}
      </div>
      <input type="range" id="frame-range" min="0" max="${last}" value="${last}" step="1" aria-label="${esc(t("detail.images"))}">
      <div class="frame-years num" aria-hidden="true"><span>${previews[0].date.slice(0, 4)}</span><span>${previews[last].date.slice(0, 4)}</span></div>
      <figcaption><span id="frame-cap" aria-live="polite"></span>. ${esc(t("detail.images_hint"))}</figcaption>
    </figure>`;
  const img = document.getElementById("frame-img"), cap = document.getElementById("frame-cap");
  const range = document.getElementById("frame-range"), year = document.getElementById("frame-year");
  const show = (i) => {
    img.src = previews[i].url;
    img.alt = `${t("detail.images")}: ${fmtDate(previews[i].date)}`;
    cap.textContent = fmtDate(previews[i].date);
    year.textContent = previews[i].date.slice(0, 4);
    range.setAttribute("aria-valuetext", fmtDate(previews[i].date));
  };
  range.addEventListener("input", () => show(Number(range.value)));
  show(last);
  previews.forEach((p) => { const pre = new Image(); pre.src = p.url; });   // предзагрузка, чтобы ползунок не мигал
}

// ------------------------------------------------------------------ текстовые страницы

const SOURCES = {
  risk: [
    ["Debris Flows field trip: Kishi and Ulken Almaty (debrisflow.ru, PDF)", "https://www.debrisflow.ru/wp-content/uploads/2015/09/Fierld_trip_Kishi_Ulken_Almaty.pdf"],
    ["Medeu Dam — Wikipedia", "https://www.wikipedia.org/wiki/Medeu_Dam"],
    ["Сель 1973-го: как Алматы спасли от разрушения — informburo.kz", "https://informburo.kz/stati/sel-1973-go-kak-almaty-spasli-ot-razruseniya"],
  ],
  data: [
    ["Copernicus Sentinel-2 (ESA)", "https://dataspace.copernicus.eu/"],
    ["Copernicus DEM GLO-30", "https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM"],
    ["Microsoft Planetary Computer", "https://planetarycomputer.microsoft.com/"],
    ["OpenStreetMap", "https://www.openstreetmap.org/copyright"],
    ["Esri World Imagery", "https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9"],
  ],
};
const sourceList = (items) => `<ul class="source-list">${items.map(([label, url]) =>
  `<li><a href="${esc(url)}" target="_blank" rel="noopener">${icon("external", "sm")}${esc(label)}</a></li>`).join("")}</ul>`;
const step = (n, title, text) => `<section class="step">${n ? `<span class="n num" aria-hidden="true">${n}</span>` : ""}<h2>${esc(title)}</h2><p>${esc(text)}</p></section>`;

// Сели, которые уже случались. Тексты — в i18n (ключи mud.<id>.*), здесь — вид события,
// снимок места (если он есть) и источники. Все цифры взяты из перечисленных источников.
const MUDFLOWS = [
  { id: "1921", kind: "rain", sources: [
    ["Самые разрушительные сели Алматы — tengrinews.kz", "https://tengrinews.kz/mixnews/muzcinu-proneslo-potokom-ves-gorod-samye-razrusitelnye-seli-376452/"],
    ["Самые громкие природные бедствия — nur.kz", "https://www.nur.kz/society/1492594-samye-gromkie-prirodnye-bedstviya-pro/"],
    ["Яфязова Р. К., 2007 — Казгидромет (PDF)", "https://www.kazhydromet.kz/files/Yafyazova_2007.pdf"]] },
  { id: "1963", kind: "outburst", image: "issyk", sources: [
    ["Иссыкской трагедии — полвека — forbes.kz", "https://forbes.kz/articles/issyikskoy_tragedii_-_polveka"],
    ["Lake Issyk — Wikipedia", "https://en.wikipedia.org/wiki/Lake_Issyk"]] },
  { id: "1973", kind: "outburst", image: "medeu", sources: [
    ["Field trip: Kishi and Ulken Almaty — debrisflow.ru (PDF)", "https://www.debrisflow.ru/wp-content/uploads/2015/09/Fierld_trip_Kishi_Ulken_Almaty.pdf"],
    ["Medeu Dam — Wikipedia", "https://www.wikipedia.org/wiki/Medeu_Dam"],
    ["Сель 1973-го: как Алматы спасли от разрушения — informburo.kz", "https://informburo.kz/stati/sel-1973-go-kak-almaty-spasli-ot-razruseniya"]] },
  { id: "1977", kind: "outburst", sources: [
    ["Моренные озёра в предгорьях Алматы — sputnik.kz", "https://ru.sputnik.kz/20190628/morennye-ozera-almaty-sel-ugroza-10740470.html"],
    ["Гляциальные сели в Заилийском Алатау за 120 лет — «Лёд и снег»", "https://ice-snow.igras.ru/jour/article/viewFile/801/512"],
    ["Шесть моренных озёр остаются потенциально опасными — bes.media", "https://bes.media/news/shest-morennyh-ozer-v-almaty-ostayutsya-potentsialno-opasnymi-kak-gorod-zaschischayut-ot-seley/"]] },
  { id: "2015", kind: "outburst", sources: [
    ["Что известно о последнем крупном селе в Алматы — zakon.kz", "https://www.zakon.kz/redaktsiia-zakonkz/4981430-chto-izvestno-o-poslednem-krupnom-sele.html"],
    ["Причина селя — прорыв моренного озера — caravan.kz", "https://www.caravan.kz/news/yurijj-ilin-prichina-selya-proryv-morennogo-ozera-351581/"],
    ["Сель в Алматы глазами очевидцев — informburo.kz", "https://informburo.kz/novosti/sel-v-almaty-glazami-ochevidcev-8899.html"]] },
  { id: "2024", kind: "human", image: "shymbulak", sources: [
    ["Антропогенный сель в бассейне Шымбулака 30 июня 2024 г. — журнал Казгидромета", "https://journal.kazhydromet.kz/kazgidro/article/view/2351"]] },
];
const KIND_ICON = { rain: "droplet", outburst: "alert", human: "layers" };

function mudflowCard(ev, imageDate) {
  const k = (f) => t(`mud.${ev.id}.${f}`);
  const rows = ["cause", "course", "damage"].map((f) =>
    `<div><dt>${esc(t(`mud.label.${f}`))}</dt><dd>${esc(k(f))}</dd></div>`).join("");
  return `
  <li class="mud" id="mud-${ev.id}">
    <div class="mud-year num" aria-hidden="true">${ev.id}</div>
    <article class="mud-body">
      <p class="mud-meta"><span class="mud-kind kind-${ev.kind}">${icon(KIND_ICON[ev.kind], "sm")}${esc(t(`mud.kind.${ev.kind}`))}</span>
        <span>${esc(k("date"))}</span></p>
      <h3>${esc(k("title"))}</h3>
      <p class="mud-place">${esc(k("place"))}</p>
      <div class="mud-grid ${ev.image ? "" : "no-img"}">
        <dl class="mud-facts">${rows}</dl>
        ${ev.image ? `<figure class="mud-fig"><img src="assets/history/${ev.image}.jpg" alt="${esc(k("img"))}" width="600" height="600" loading="lazy">
          <figcaption>${esc(k("img"))}. ${esc(t("mud.img_note", { date: imageDate ? fmtDate(imageDate) : "" }))}</figcaption></figure>` : ""}
      </div>
      <details class="mud-src"><summary>${esc(t("mud.sources"))}</summary>${sourceList(ev.sources)}</details>
    </article>
  </li>`;
}

async function renderRisk() {
  pageHead("risk", t("risk.title"), t("page.risk.lead"));
  const counts = MUDFLOWS.reduce((acc, ev) => ({ ...acc, [ev.kind]: (acc[ev.kind] || 0) + 1 }), {});
  view.innerHTML = `
  <div class="fade-in">
    <div class="prose-grid three">
      ${[1, 2, 3].map((n) => `<section class="step"><span class="n num" aria-hidden="true">0${n}</span><p>${esc(t(`risk.p${n}`))}</p></section>`).join("")}
    </div>
    <section class="section" aria-labelledby="hist-h">
      <div class="section-head"><div><h2 id="hist-h">${esc(t("mud.title"))}</h2><p>${esc(t("mud.lead"))}</p></div></div>
      <dl class="figures mud-figures">
        ${figure(t("mud.stat.total"), String(MUDFLOWS.length), esc(`${MUDFLOWS[0].id}–${MUDFLOWS[MUDFLOWS.length - 1].id}`))}
        ${figure(t("mud.kind.outburst"), String(counts.outburst || 0), esc(t("mud.stat.outburst")), "attn")}
        ${figure(t("mud.kind.rain"), String(counts.rain || 0), esc(t("mud.stat.rain")))}
        ${figure(t("mud.kind.human"), String(counts.human || 0), esc(t("mud.stat.human")))}
      </dl>
      <ol class="muds" id="muds">${MUDFLOWS.map((ev) => mudflowCard(ev, null)).join("")}</ol>
      <p class="hint-text">${esc(t("mud.note"))}</p>
    </section>
    <section class="statement lvl-watch section" aria-labelledby="lesson-h">
      <h2 id="lesson-h">${icon("info", "sm")}${esc(t("mud.lesson.title"))}</h2>
      <p>${esc(t("mud.lesson.text"))}</p>
    </section>
    <div class="next-links section"><a class="btn primary" href="#/map">${esc(t("tile.map.t"))}${icon("chevron", "sm")}</a>
      <a class="btn" href="#/method">${esc(t("tile.method.t"))}</a></div>
  </div>`;
  // дата спутникового снимка — та же, что у 3D-рельефа; подставляем её в подписи к фотографиям мест
  try {
    const meta = await (await fetch("assets/terrain/terrain.json")).json();
    if (meta.satellite_date) {
      view.querySelectorAll(".mud-fig figcaption").forEach((fc, i) => {
        const ev = MUDFLOWS.filter((e) => e.image)[i];
        fc.textContent = `${t(`mud.${ev.id}.img`)}. ${t("mud.img_note", { date: fmtDate(meta.satellite_date) })}`;
      });
    }
  } catch { /* без даты подпись тоже понятна */ }
}

function renderMethod() {
  pageHead("method", t("method.title"), t("page.method.lead"));
  const m = state.meta?.method, o = state.overview || {};
  const params = { threshold: number(m?.ndwi_threshold ?? 0.2, 1), clouds: m?.max_cloud_pct ?? 15, snow: m?.max_snow_pct ?? 40 };
  const total = (o.lakes_monitored ?? 0) + (o.lakes_hidden ?? 0);
  view.innerHTML = `
  <div class="fade-in prose-grid two">
    ${step("01", t("method.h.sat"), t("method.p1"))}
    ${step("02", t("method.h.water"), `${t("method.p2", params)} ${t("method.p3", params)}`)}
    ${step("03", t("method.h.rules"), t("method.statuses"))}
    ${step("04", t("method.h.hidden"), t("method.hidden", { total: number(total), hidden: number(o.lakes_hidden ?? 0), min: number(2000) }))}
    ${step("05", t("method.h.limits"), t("method.p4"))}
    <section class="step"><span class="n num" aria-hidden="true">06</span><h2>${esc(t("about.h.sources"))}</h2>${sourceList(SOURCES.data)}</section>
  </div>`;
}

function renderAbout() {
  pageHead("about", t("about.title"), t("page.about.lead"));
  view.innerHTML = `
  <div class="fade-in prose-grid two">
    ${step("", t("about.title"), `${t("about.p1")} ${t("about.p2")}`)}
    ${step("", t("page.lakes.title"), t("about.names"))}
    <section class="step"><h2>${esc(t("about.h.sources"))}</h2><p>${esc(t("footer.data"))}</p>${sourceList(SOURCES.data)}</section>
    <section class="statement lvl-watch"><h2>${icon("alert", "sm")}${esc(t("about.h.official"))}</h2>
      <div class="links">${esc(t("disclaimer"))}</div><div class="links">${esc(t("beta.notice"))}</div></section>
  </div>`;
}

// ------------------------------------------------------------------ маршрутизация

function parseRoute() {
  const parts = (location.hash || "#/").replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "lake" && parts[1]) return { page: "lake", id: parts[1], tab: TABS.includes(parts[2]) ? parts[2] : "overview" };
  if (["lakes", "map", "risk", "method", "about"].includes(parts[0])) return { page: parts[0] };
  return { page: "home" };
}

// Полоска загрузки вверху страницы: видна, пока подгружаются данные озера.
const progress = document.getElementById("progress");
function busy(on) {
  if (!progress) return;
  progress.hidden = !on;
  view.setAttribute("aria-busy", String(on));
}

// Название вкладки браузера меняется вместе со страницей сайта.
const PAGE_TITLE = { lakes: "page.lakes.title", map: "page.map.title", risk: "risk.title", method: "method.title", about: "about.title" };
function setTitle(r) {
  const page = r.page === "lake" ? name(state.details[r.id]?.lake?.name) : PAGE_TITLE[r.page] ? t(PAGE_TITLE[r.page]) : "";
  document.title = page ? `${page} — LakeWatch` : t("app.title");
}

let lastRoute = null;
async function route({ keepScroll = false } = {}) {
  if (state.map) { state.map.remove(); state.map = null; }
  const r = parseRoute();
  const sameLake = lastRoute?.page === "lake" && r.page === "lake" && lastRoute.id === r.id;
  try {
    if (r.page === "lake") {
      if (!state.details[r.id]) {
        busy(true);
        try { state.details[r.id] = await getJSON(`lakes/${encodeURIComponent(r.id)}`); } finally { busy(false); }
      }
      renderLake(state.details[r.id], r.tab);
    } else {
      ({ home: renderHome, lakes: renderLakes, map: renderMap, risk: renderRisk, method: renderMethod, about: renderAbout })[r.page]();
    }
    setActiveNav(r.page === "lake" ? "lakes" : r.page);
    setTitle(r);
    if (!keepScroll) {
      if (sameLake) {
        // смена вкладки: остаёмся у вкладок, а не прыгаем в начало страницы
        const tabs = document.getElementById("tabs");
        if (tabs && tabs.getBoundingClientRect().top < 0) tabs.scrollIntoView({ block: "start" });
      } else {
        window.scrollTo({ top: 0, behavior: "instant" });
        // после перехода переводим фокус на заголовок — важно для клавиатуры и экранных читалок
        if (state.routed) stage.querySelector("h1[tabindex]")?.focus({ preventScroll: true });
      }
    }
  } catch (err) {
    console.error(err);
    setStage("error", "", "page");
    view.innerHTML = `<div class="error-box" role="alert"><p class="lead-text">${esc(t("error.load"))}</p>
      <p style="margin-top:16px"><a class="btn" href="#/">${esc(t("nav.home"))}</a></p></div>`;
  }
  lastRoute = r;
  state.routed = true;
}

async function changeLang(next) {
  await setLang(next);
  const url = new URL(location.href);
  url.searchParams.set("lang", next);
  history.replaceState(null, "", url);
  renderChrome();
  const y = window.scrollY;
  await route({ keepScroll: true });          // смена языка — не переход: прокрутку не трогаем
  window.scrollTo({ top: y, behavior: "instant" });
}

async function init() {
  await setLang(detectLang());
  translateStatic();
  document.querySelectorAll(".lang button").forEach((b) =>
    b.addEventListener("click", () => LANGS.includes(b.dataset.lang) && changeLang(b.dataset.lang)));
  try {
    const [lakes, meta, overview] = await Promise.all([getJSON("lakes"), getJSON("meta"), getJSON("overview")]);
    state.lakes = lakes.lakes;
    state.meta = meta;
    state.overview = overview;
  } catch (err) {
    console.error(err);
    view.innerHTML = `<div class="error-box" role="alert"><p class="lead-text">${esc(t("error.load"))}</p></div>`;
    return;
  }
  renderChrome();
  window.addEventListener("hashchange", () => route());
  await route();
}

init();
