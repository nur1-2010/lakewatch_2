// 3D-модель рельефа Иле-Алатау с озёрами. Рельеф настоящий: высоты из Copernicus DEM
// (assets/terrain/, готовит команда `python -m lakewatch terrain`). Библиотека — three.js.
//
// Вид — со стороны Алматы (с севера) на юг. Высоты слегка увеличены, а озёра нарисованы
// крупнее настоящих, иначе их не было бы видно: это наглядная модель, а не точная карта.

/* global THREE */

const EXAGGERATION = 1.35;          // во сколько раз увеличены высоты
const BASE_Y = -0.9;                // низ «среза» блока рельефа
const LEVEL_COLOR = { alert: 0xe2603c, watch: 0xf0b13c, normal: 0x6fcf97, info: 0xb9c7c0 };
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export function webglAvailable() {
  try {
    const c = document.createElement("canvas");
    return !!(window.WebGLRenderingContext && (c.getContext("webgl") || c.getContext("experimental-webgl"))) && !!window.THREE;
  } catch { return false; }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`terrain image ${src}`));
    img.src = src;
  });
}

// Склеиваем кусочки карты высот в одну сетку высот (в метрах).
let heightmapPromise = null;
function loadHeightmap() {
  heightmapPromise ??= (async () => {
    const meta = await (await fetch("assets/terrain/terrain.json")).json();
    const [x0, y0, x1, y1] = meta.bbox;
    const ppdX = meta.parts[0].width / (meta.parts[0].bbox[2] - meta.parts[0].bbox[0]);
    const ppdY = meta.parts[0].height / (meta.parts[0].bbox[3] - meta.parts[0].bbox[1]);
    const W = Math.round((x1 - x0) * ppdX), H = Math.round((y1 - y0) * ppdY);
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const images = await Promise.all(meta.parts.map((p) => loadImage(`assets/terrain/${p.file}`)));
    meta.parts.forEach((p, i) => {
      const dx = Math.round((p.bbox[0] - x0) * ppdX), dy = Math.round((y1 - p.bbox[3]) * ppdY);   // север — сверху
      ctx.drawImage(images[i], dx, dy, p.width, p.height);
    });
    const px = ctx.getImageData(0, 0, W, H).data;
    const raw = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) raw[i] = meta.elev_min + (px[i * 4] / 255) * (meta.elev_max - meta.elev_min);
    // лёгкое сглаживание: 8-битная карта даёт «ступеньки» по ~13 м
    const h = new Float32Array(W * H);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      let s = 0, n = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const jj = j + dj, ii = i + di;
        if (jj >= 0 && jj < H && ii >= 0 && ii < W) { s += raw[jj * W + ii]; n++; }
      }
      h[j * W + i] = s / n;
    }
    return { meta, W, H, h };
  })();
  return heightmapPromise;
}

const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Цвет точки рельефа: лес → альпийские луга → камень → снег; на крутых склонах снег не держится.
const C = {
  // природная палитра: хвойный лес, альпийский луг, охристая тундра, тёплый камень, голубоватый снег
  forest: [0.11, 0.30, 0.22], meadow: [0.36, 0.52, 0.30], tundra: [0.66, 0.60, 0.40],
  rock: [0.50, 0.44, 0.39], cliff: [0.30, 0.29, 0.31], snow: [0.93, 0.97, 0.99],
};
function terrainColor(elev, flatness) {
  const mix = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
  let c = mix(C.forest, C.meadow, smooth(2300, 2800, elev));
  c = mix(c, C.tundra, smooth(2900, 3300, elev));
  c = mix(c, C.rock, smooth(3250, 3600, elev));
  c = mix(c, C.cliff, (1 - smooth(0.62, 0.86, flatness)) * smooth(2600, 3200, elev));
  c = mix(c, C.snow, smooth(3650, 3950, elev) * smooth(0.60, 0.80, flatness));
  return c;
}

/**
 * @param container  элемент, в который вставляется сцена
 * @param lakes      [{id, lon, lat, level, label, sub, area_m2, href}]
 * @param options    {focusId, labels: "all"|"focus", distance, elevation, interactive}
 */
export async function createTerrain(container, lakes, options = {}) {
  const { meta, W, H, h } = await loadHeightmap();
  const [x0, y0, x1, y1] = meta.bbox;
  const latC = (y0 + y1) / 2, lonC = (x0 + x1) / 2;
  const kmLon = 111.32 * Math.cos((latC * Math.PI) / 180), kmLat = 110.574;
  const sizeX = (x1 - x0) * kmLon, sizeZ = (y1 - y0) * kmLat;      // 1 единица сцены = 1 км
  const yOf = (elev) => ((elev - meta.elev_min) / 1000) * EXAGGERATION;
  const toXZ = (lon, lat) => [(lon - lonC) * kmLon, -(lat - latC) * kmLat];
  const elevAt = (lon, lat) => {
    const i = Math.min(W - 1, Math.max(0, Math.round(((lon - x0) / (x1 - x0)) * (W - 1))));
    const j = Math.min(H - 1, Math.max(0, Math.round(((y1 - lat) / (y1 - y0)) * (H - 1))));
    return h[j * W + i];
  };

  // ---------------------------------------------------------------- сцена
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  const canvas = renderer.domElement;
  canvas.setAttribute("aria-hidden", "true");
  container.appendChild(canvas);
  const labelLayer = document.createElement("div");
  labelLayer.className = "t3d-labels";
  container.appendChild(labelLayer);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 400);
  scene.add(new THREE.HemisphereLight(0xd8f0ea, 0x1f3a33, 0.72));     // небо бирюзовое, от земли — зелёный отсвет
  const sun = new THREE.DirectionalLight(0xffe2bd, 0.95);             // тёплый рассветный свет
  sun.position.set(-14, 16, -6);               // низкое утреннее солнце с востока
  scene.add(sun);

  // ---------------------------------------------------------------- рельеф
  const pos = new Float32Array(W * H * 3);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const k = (j * W + i) * 3;
    pos[k] = (i / (W - 1) - 0.5) * sizeX;
    pos[k + 1] = yOf(h[j * W + i]);
    pos[k + 2] = (j / (H - 1) - 0.5) * sizeZ;
  }
  const idx = new Uint32Array((W - 1) * (H - 1) * 6);
  let q = 0;
  for (let j = 0; j < H - 1; j++) for (let i = 0; i < W - 1; i++) {
    const a = j * W + i, b = a + 1, c = a + W, d = c + 1;
    idx[q++] = a; idx[q++] = c; idx[q++] = b; idx[q++] = b; idx[q++] = c; idx[q++] = d;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();
  const nrm = geo.attributes.normal.array;
  // Цвет вершины — RGBA: четвёртое число — прозрачность. У краёв она плавно падает до нуля.
  const FADE = 0.16;                                   // доля ширины, на которой рельеф растворяется
  const col = new Float32Array(W * H * 4);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const v = j * W + i;
    const c = terrainColor(h[v], nrm[v * 3 + 1]);
    const ex = Math.min(i, W - 1 - i) / (W - 1), ez = Math.min(j, H - 1 - j) / (H - 1);
    col[v * 4] = c[0]; col[v * 4 + 1] = c[1]; col[v * 4 + 2] = c[2];
    col[v * 4 + 3] = smooth(0, FADE, ex) * smooth(0, FADE, ez);
  }
  geo.setAttribute("color", new THREE.BufferAttribute(col, 4));
  const terrain = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    vertexColors: true, flatShading: true, roughness: 0.92, metalness: 0, transparent: true }));
  scene.add(terrain);

  // Боковых стенок нет: к краям рельеф становится прозрачным и растворяется в небе.

  // ---------------------------------------------------------------- озёра
  const markers = lakes.map((lake) => {
    const [x, z] = toXZ(lake.lon, lake.lat);
    const y = yOf(elevAt(lake.lon, lake.lat));
    const color = LEVEL_COLOR[lake.level] ?? LEVEL_COLOR.info;
    const group = new THREE.Group();
    group.position.set(x, y, z);

    // Радиус круга считается по самой большой площади озера за все годы; в остальные годы круг
    // уменьшается пропорционально (см. setYear) — так работает «машина времени».
    const byYear = new Map((lake.yearly || []).map((y) => [y.year, y.median_area_m2]));
    const maxArea = Math.max(lake.area_m2 || 0, ...byYear.values(), 0);
    const radius = Math.max(0.17, (Math.sqrt(maxArea / Math.PI) / 1000) * 1.6);
    const scaleFor = (a) => (maxArea < 1 || a < 1 ? 0 : Math.max(0.12, Math.sqrt(a / maxArea)));
    const nowScale = byYear.size ? scaleFor(lake.area_m2 || 0) : 1;
    const water = new THREE.Mesh(new THREE.CircleGeometry(radius, 40), new THREE.MeshBasicMaterial({ color: 0x3fd0c4 }));   // ледниковая бирюза
    water.rotation.x = -Math.PI / 2; water.position.y = 0.05;
    const rim = new THREE.Mesh(new THREE.RingGeometry(radius, radius + 0.045, 40), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }));
    rim.rotation.x = -Math.PI / 2; rim.position.y = 0.055;
    const pulse = new THREE.Mesh(new THREE.RingGeometry(radius + 0.05, radius + 0.11, 40), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false }));
    pulse.rotation.x = -Math.PI / 2; pulse.position.y = 0.06;

    // Озёра, требующие внимания (и выбранное озеро), получают высокий флажок; остальные — маленькую точку,
    // иначе при десятках озёр сцена превращается в «ёжика».
    const tall = lake.prominent !== false;
    const poleH = tall ? 1.7 : 0.22;
    const head = new THREE.Mesh(new THREE.SphereGeometry(tall ? 0.14 : 0.085, 20, 14), new THREE.MeshBasicMaterial({ color }));
    head.position.y = poleH;
    const disc = new THREE.Group();            // вода с ободком: именно этот круг меняет размер по годам
    disc.add(water, rim, pulse);
    disc.scale.setScalar(Math.max(nowScale, 0.001));
    group.add(disc, head);
    if (tall) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, poleH, 8), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7 }));
      pole.position.y = poleH / 2;
      group.add(pole);
    }
    scene.add(group);

    const label = document.createElement(lake.href ? "a" : "div");
    label.className = `t3d-label lvl-${lake.level}`;
    if (lake.href) label.href = lake.href;
    label.setAttribute("aria-label", [lake.label, lake.sub].filter(Boolean).join(" — "));
    label.title = lake.label;
    label.innerHTML = `<i></i><span><b></b><small></small></span>`;
    label.querySelector("b").textContent = lake.label;
    label.querySelector("small").textContent = lake.sub || "";
    labelLayer.appendChild(label);
    return { lake, group, head, pulse, label, disc, byYear, scaleFor, scale: nowScale, scaleGoal: nowScale, nowScale,
             top: new THREE.Vector3(x, y + poleH, z), ground: new THREE.Vector3(x, y, z),
             animate: lake.level === "alert" || lake.level === "watch" };
  });

  // ---------------------------------------------------------------- камера
  const mainLakes = markers.filter((m) => m.lake.main !== false);
  const home = new THREE.Vector3();
  (mainLakes.length ? mainLakes : markers).forEach((m) => home.add(m.ground));
  home.multiplyScalar(1 / Math.max(1, (mainLakes.length ? mainLakes : markers).length));
  if (!markers.length || options.frame === "block") home.set(0, 2.1, 0);    // показываем весь блок рельефа

  const view = { az: options.azimuth ?? 0.25, el: options.elevation ?? 0.44, dist: options.distance ?? 27, target: home.clone() };
  const goal = { el: view.el, dist: view.dist, target: home.clone() };
  let baseAz = view.az, focusId = null, dragging = false, lastX = 0, lastY = 0, userAz = 0, t0 = performance.now(), last = t0;

  function focus(id, { immediate = false } = {}) {
    focusId = id;
    const m = markers.find((mk) => mk.lake.id === id);
    if (m) { goal.target.copy(m.ground); goal.dist = options.focusDistance ?? 13; goal.el = 0.5; }
    else { goal.target.copy(home); goal.dist = options.distance ?? 27; goal.el = options.elevation ?? 0.44; }
    if (immediate) { view.target.copy(goal.target); view.dist = goal.dist; view.el = goal.el; }
    markers.forEach((mk) => mk.label.classList.toggle("is-focus", mk.lake.id === id));
    requestRender();
  }

  // «Машина времени»: показать озёра такими, какими они были в выбранном году.
  // year = null возвращает текущее состояние. Если за год у озера нет данных, круг не меняется.
  function setYear(year) {
    for (const m of markers) {
      if (year === null) m.scaleGoal = m.nowScale;
      else if (m.byYear.has(year)) m.scaleGoal = m.scaleFor(m.byYear.get(year));
    }
    requestRender();
  }

  let distScale = 1;                       // на узком экране камера ближе: сцена занимает отдельный блок
  function placeCamera() {
    const ce = Math.cos(view.el), dist = view.dist * distScale;
    camera.position.set(view.target.x + Math.sin(view.az) * ce * dist, view.target.y + Math.sin(view.el) * dist,
                        view.target.z - Math.cos(view.az) * ce * dist);
    camera.lookAt(view.target);
  }

  // ---------------------------------------------------------------- подписи
  const v = new THREE.Vector3();
  function placeLabels(width, height) {
    const boxes = [];
    const order = [...markers].sort((a, b) => a.top.distanceToSquared(camera.position) - b.top.distanceToSquared(camera.position));
    for (const m of order) {
      const showLabel = m.lake.id === focusId || options.labels === "all" ||
        (options.labels === "prominent" && m.lake.labelled === true);
      v.copy(m.top).project(camera);
      const visible = showLabel && v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05;
      m.label.style.display = visible ? "" : "none";
      if (!visible) continue;
      let x = (v.x * 0.5 + 0.5) * width, y = (-v.y * 0.5 + 0.5) * height;
      const w = m.label.offsetWidth, hgt = m.label.offsetHeight;
      x = Math.min(width - w - 8, Math.max(8, x + 12));
      y = y - hgt / 2;
      for (let tries = 0; tries < 6; tries++) {         // раздвигаем подписи, если они накладываются
        const hit = boxes.find((b) => x < b.x + b.w + 6 && x + w + 6 > b.x && y < b.y + b.h + 4 && y + hgt + 4 > b.y);
        if (!hit) break;
        y = hit.y - hgt - 6;
      }
      y = Math.min(height - hgt - 8, Math.max(8, y));
      boxes.push({ x, y, w, h: hgt });
      m.label.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    }
  }

  // ---------------------------------------------------------------- цикл отрисовки
  let raf = 0, visible = true, disposed = false, needsRender = true, width = 0, height = 0;
  const still = reducedMotion() || options.interactive === false;

  function resize() {
    width = container.clientWidth; height = container.clientHeight;
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    // на узком экране отодвигаем камеру, чтобы блок рельефа помещался целиком
    // чем уже окно, тем шире угол обзора — чтобы блок рельефа помещался целиком
    const narrow = width < 900;
    distScale = narrow ? 0.74 : 1;
    camera.fov = Math.min(62, 34 * Math.max(1, 1.45 / (width / height)));
    // на широком экране сдвигаем сцену вправо, чтобы слева осталось место для заголовка
    if (!narrow && (options.shiftX || options.shiftY)) {
      camera.setViewOffset(width, height, -(options.shiftX || 0) * width, -(options.shiftY || 0) * height, width, height);
    } else {
      camera.clearViewOffset();
    }
    camera.updateProjectionMatrix();
    needsRender = true;
  }

  function frame(now) {
    raf = 0;
    if (disposed) return;
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    const k = 1 - Math.exp(-dt * 3.2);
    const t = (now - t0) / 1000;
    const sway = still || dragging ? 0 : Math.sin(t * 0.16) * (focusId ? 0.22 : 0.42);
    const azGoal = baseAz + userAz + sway;
    const moving = Math.abs(azGoal - view.az) > 1e-4 || Math.abs(goal.dist - view.dist) > 1e-3 ||
      Math.abs(goal.el - view.el) > 1e-4 || view.target.distanceToSquared(goal.target) > 1e-6;
    view.az = lerp(view.az, azGoal, dragging ? 1 : k);
    view.el = lerp(view.el, goal.el, k);
    view.dist = lerp(view.dist, goal.dist, k);
    view.target.lerp(goal.target, k);

    let resizing = false;                 // круги озёр плавно меняют размер при смене года
    for (const m of markers) {
      if (Math.abs(m.scaleGoal - m.scale) < 1e-3) continue;
      resizing = true;
      m.scale = still ? m.scaleGoal : lerp(m.scale, m.scaleGoal, Math.min(1, k * 1.6));
      m.disc.scale.setScalar(Math.max(m.scale, 0.001));
      m.disc.visible = m.scale > 0.01;
    }

    let pulsing = false;
    if (!still) for (const m of markers) {
      if (!m.animate) continue;
      pulsing = true;
      const ph = (t * 0.55 + m.ground.x * 0.13) % 1;
      m.pulse.scale.setScalar(1 + ph * 2.6);
      m.pulse.material.opacity = 0.75 * (1 - ph);
    }
    if (moving || pulsing || resizing || needsRender) {
      placeCamera();
      renderer.render(scene, camera);
      placeLabels(width, height);
      needsRender = false;
    }
    if (visible && (!still || moving || resizing)) raf = requestAnimationFrame(frame);
  }
  function requestRender() { needsRender = true; if (!raf && !disposed) { last = performance.now(); raf = requestAnimationFrame(frame); } }

  // ---------------------------------------------------------------- управление
  const onDown = (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; canvas.setPointerCapture?.(e.pointerId); canvas.classList.add("is-drag"); requestRender(); };
  const onMove = (e) => {
    if (!dragging) return;
    // Кнопка уже отпущена (например, над подписью или за окном), а событие «отпускания» до нас
    // не дошло — без этой проверки сцена «прилипала» к курсору и продолжала вращаться.
    if (e.pointerType === "mouse" && !(e.buttons & 1)) { onUp(); return; }
    userAz -= (e.clientX - lastX) * 0.006;
    goal.el = Math.min(1.1, Math.max(0.18, goal.el + (e.clientY - lastY) * 0.004));
    view.el = goal.el;
    lastX = e.clientX; lastY = e.clientY;
    requestRender();
  };
  const onUp = () => { dragging = false; canvas.classList.remove("is-drag"); };
  if (options.interactive !== false) {
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    canvas.addEventListener("lostpointercapture", onUp);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("blur", onUp);
  }
  const ro = new ResizeObserver(() => { resize(); requestRender(); });
  ro.observe(container);
  const io = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; if (visible) requestRender(); });
  io.observe(container);                                   // вне экрана сцена не рисуется — бережём батарею
  const onVis = () => { visible = !document.hidden; if (visible) requestRender(); };
  document.addEventListener("visibilitychange", onVis);

  resize();
  if (options.focusId) focus(options.focusId, { immediate: true });
  placeCamera();
  requestRender();
  container.classList.add("is-ready");

  return {
    focus,
    setYear,
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect(); io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("blur", onUp);
      scene.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); });
      renderer.dispose();
      renderer.forceContextLoss?.();
      canvas.remove(); labelLayer.remove();
    },
  };
}
