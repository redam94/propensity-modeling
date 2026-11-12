// The overview page's opening sequence: one set of dots (survey respondents) that rearranges itself
// as the reader scrolls, from a raw comparison to a propensity-score adjustment.
// Every number shown is computed from the simulation below, not typed in.
import { makeRng, sigmoid, fitLogistic, balancingWeights, diffMeans, commonSupport } from "./sim.js";

const story = document.querySelector("[data-story]");
if (story) init(story);

function simulate(n, seed) {
  const rng = makeRng(seed);
  const x = new Float64Array(n), t = new Uint8Array(n), y = new Uint8Array(n);
  let effect = 0, nExposed = 0;
  for (let i = 0; i < n; i++) {
    x[i] = rng.n(); // media appetite: drives both exposure and brand awareness
    t[i] = rng.bern(sigmoid(-0.45 + 1.15 * x[i]));
    const u = rng.u();
    const y0 = u < sigmoid(-0.55 + 0.95 * x[i]) ? 1 : 0;
    const y1 = u < sigmoid(-0.55 + 0.95 * x[i] + 0.36) ? 1 : 0;
    y[i] = t[i] ? y1 : y0;
    if (t[i]) { effect += y1 - y0; nExposed++; }
  }
  const { p } = fitLogistic([x], t);
  const w = balancingWeights(p, t, "att");
  const ones = new Float64Array(n).fill(1);
  return { n, x, t, y, e: p, w, raw: diffMeans(y, t, ones), adjusted: diffMeans(y, t, w), truth: effect / nExposed };
}

function init(root) {
  const canvas = root.querySelector("canvas");
  const ctx = canvas.getContext("2d");
  const captions = [...root.querySelectorAll(".story-caption")];
  const steps = [...root.querySelectorAll(".story-step")];
  const dots = [...root.querySelectorAll(".story-progress i")];
  const metrics = [...root.querySelectorAll(".story-metric")];
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  const STAGES = steps.length;

  // Headline numbers come from a large simulated population; the dots are its first N respondents.
  const pop = simulate(24000, 20261111);
  const N = window.innerWidth < 720 ? 440 : 780;
  const d = { x: pop.x.subarray(0, N), t: pop.t.subarray(0, N), y: pop.y.subarray(0, N), e: pop.e.subarray(0, N), w: pop.w.subarray(0, N) };
  const support = commonSupport(d.e, d.t);
  const share = (g) => {
    let s = 0, c = 0;
    for (let i = 0; i < pop.n; i++) if (pop.t[i] === g) { s += pop.y[i]; c++; }
    return s / c;
  };
  const aware = { exposed: share(1), control: share(0) };

  const pts = (v) => (v >= 0 ? "+" : "−") + Math.abs(v * 100).toFixed(0);
  root.querySelectorAll("[data-bind]").forEach((el) => {
    const key = el.getAttribute("data-bind");
    const value = { raw: pts(pop.raw), adjusted: pts(pop.adjusted), truth: pts(pop.truth), confounding: pts(pop.raw - pop.adjusted).replace("+", ""),
      n: pop.n.toLocaleString("en-US"), awareExposed: Math.round(aware.exposed * 100), awareControl: Math.round(aware.control * 100) }[key];
    if (value !== undefined) el.textContent = value;
  });

  const jitter = makeRng(7);
  const seedA = Float32Array.from({ length: N }, () => jitter.n());
  const seedB = Float32Array.from({ length: N }, () => jitter.n());
  const delay = Float32Array.from({ length: N }, () => jitter.u());
  const order = Array.from({ length: N }, (_, i) => i);

  let W = 0, H = 0, dpr = 1, layouts = [], region = null, meta = {};
  const cur = { x: new Float32Array(N), y: new Float32Array(N), r: new Float32Array(N), a: new Float32Array(N) };
  const from = { x: new Float32Array(N), y: new Float32Array(N), r: new Float32Array(N), a: new Float32Array(N) };
  const deco = new Float32Array(STAGES);
  let stage = -1, changedAt = 0, visible = false, raf = 0;

  function color(name) {
    return getComputedStyle(root).getPropertyValue(name).trim();
  }
  let C = {};
  function readColors() {
    C = { exposed: color("--exposed"), control: color("--control"), support: color("--support"), ink: color("--ink"), muted: color("--muted"), line: color("--line") };
  }

  function fitSpacing(counts, room, start) {
    // Largest dot spacing whose tallest stack still fits in `room` pixels.
    for (let s = start; s > 3; s -= 0.5) if (counts(s) * s <= room) return s;
    return 3;
  }

  function stacks(values, lo, hi, s, mid, gap) {
    const span = region.x1 - region.x0;
    const cols = Math.max(8, Math.floor(span / s));
    const step = span / cols;
    const up = new Uint16Array(cols), down = new Uint16Array(cols);
    const L = blank();
    for (const i of order) {
      const c = Math.min(cols - 1, Math.max(0, Math.floor(((values[i] - lo) / (hi - lo)) * cols)));
      const k = d.t[i] ? up[c]++ : down[c]++;
      L.x[i] = region.x0 + (c + 0.5) * step;
      L.y[i] = d.t[i] ? mid - gap - (k + 0.5) * s : mid + gap + (k + 0.5) * s;
      L.r[i] = Math.min(step, s) * 0.42;
      L.a[i] = 0.95;
    }
    return { L, peak: Math.max(Math.max(...up), Math.max(...down)) };
  }

  function blank() {
    return { x: new Float32Array(N), y: new Float32Array(N), r: new Float32Array(N), a: new Float32Array(N) };
  }

  function build() {
    const small = W < 720;
    const padX = Math.max(22, W * (small ? 0.06 : 0.1));
    region = { x0: padX, x1: W - padX, y0: H * (small ? 0.44 : 0.39), y1: H * (small ? 0.76 : 0.73) };
    const rw = region.x1 - region.x0, rh = region.y1 - region.y0;
    const cx = (region.x0 + region.x1) / 2, cy = (region.y0 + region.y1) / 2;
    layouts = [];

    // 0: an undifferentiated crowd
    const L0 = blank();
    for (let i = 0; i < N; i++) {
      L0.x[i] = cx + Math.max(-2.4, Math.min(2.4, seedA[i])) * rw * 0.2;
      L0.y[i] = cy + Math.max(-2.2, Math.min(2.2, seedB[i])) * rh * 0.24;
      L0.r[i] = small ? 3 : 4;
      L0.a[i] = 0.9;
    }
    layouts.push(L0);

    // 1: the raw comparison, two blocks with aware respondents on top
    const L1 = blank();
    const bw = rw * (small ? 0.42 : 0.3);
    const groups = [[], []];
    for (let i = 0; i < N; i++) groups[d.t[i]].push(i);
    groups.forEach((g) => g.sort((a, b) => d.y[b] - d.y[a]));
    const top = region.y0 + 46;
    const s1 = fitSpacing((s) => Math.ceil(Math.max(groups[0].length, groups[1].length) / Math.max(1, Math.floor(bw / s))), region.y1 - top, 15);
    const cols = Math.max(1, Math.floor(bw / s1));
    const centers = [cx + rw * (small ? 0.26 : 0.2), cx - rw * (small ? 0.26 : 0.2)]; // [control, exposed]
    groups.forEach((g, grp) => {
      g.forEach((i, k) => {
        L1.x[i] = centers[grp] - (cols * s1) / 2 + ((k % cols) + 0.5) * s1;
        L1.y[i] = top + (Math.floor(k / cols) + 0.5) * s1;
        L1.r[i] = s1 * 0.4;
        L1.a[i] = d.y[i] ? 1 : 0.24;
      });
    });
    layouts.push(L1);
    meta.blocks = { centers, top: region.y0 + 10 };

    // 2: sorted by the confounder; 3: sorted by propensity score
    const mid = cy, gap = 5, room = rh / 2 - gap - 4;
    const sFor = (vals, lo, hi) => fitSpacing((s) => stacks(vals, lo, hi, s, mid, gap).peak, room, 16);
    const s2 = sFor(d.x, -2.7, 2.7);
    layouts.push(stacks(d.x, -2.7, 2.7, s2, mid, gap).L);
    const s3 = sFor(d.e, 0, 1);
    const L3 = stacks(d.e, 0, 1, s3, mid, gap).L;
    layouts.push(L3);

    // 4: same positions, controls resized by their ATT weight
    const L4 = blank();
    let mw = 0, nc = 0;
    for (let i = 0; i < N; i++) if (!d.t[i]) { mw += d.w[i]; nc++; }
    mw /= nc;
    for (let i = 0; i < N; i++) {
      L4.x[i] = L3.x[i];
      L4.y[i] = L3.y[i];
      L4.r[i] = d.t[i] ? L3.r[i] : L3.r[i] * Math.max(0.3, Math.min(3.2, Math.sqrt(d.w[i] / mw)));
      L4.a[i] = d.t[i] ? 0.95 : 0.78;
    }
    layouts.push(L4);
    meta.mid = mid;

    // 5: two overlapping groups, the comparison that is actually possible
    const L5 = blank();
    const R = Math.min(rh * 0.5, rw * (small ? 0.3 : 0.2));
    const counts = [0, 0];
    const totals = [groups[0].length, groups[1].length];
    for (let i = 0; i < N; i++) {
      const g = d.t[i], k = counts[g]++;
      const rad = R * Math.sqrt((k + 0.5) / totals[g]);
      const th = k * 2.399963;
      L5.x[i] = cx + (g ? -1 : 1) * R * 0.52 + rad * Math.cos(th);
      L5.y[i] = cy + rad * Math.sin(th);
      L5.r[i] = small ? 2.6 : 3.4;
      L5.a[i] = 0.82;
    }
    layouts.push(L5);
    while (layouts.length < STAGES) layouts.push(L5);
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = rect.width;
    H = rect.height;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    readColors();
    build();
    const s = Math.max(0, stage);
    for (let i = 0; i < N; i++) {
      cur.x[i] = layouts[s].x[i]; cur.y[i] = layouts[s].y[i]; cur.r[i] = layouts[s].r[i]; cur.a[i] = layouts[s].a[i];
    }
    from.x.set(cur.x); from.y.set(cur.y); from.r.set(cur.r); from.a.set(cur.a);
    draw(performance.now());
  }

  function setStage(next) {
    if (next === stage) return;
    stage = next;
    root.setAttribute("data-stage", String(stage));
    from.x.set(cur.x); from.y.set(cur.y); from.r.set(cur.r); from.a.set(cur.a);
    changedAt = performance.now();
    captions.forEach((c, i) => {
      c.classList.toggle("is-active", i === stage);
      c.setAttribute("aria-hidden", String(i !== stage));
    });
    dots.forEach((el, i) => el.classList.toggle("is-active", i === stage));
    metrics.forEach((m) => m.classList.toggle("is-on", stage >= Number(m.getAttribute("data-from"))));
    kick();
  }

  function onScroll() {
    const rect = root.getBoundingClientRect();
    const travel = rect.height - window.innerHeight;
    const p = travel > 0 ? Math.min(1, Math.max(0, -rect.top / travel)) : 0;
    setStage(Math.round(p * (STAGES - 1)));
  }

  const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
  const font = (size, weight = 600) => `${weight} ${size}px -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif`;

  function text(str, x, y, { size = 13, weight = 600, fill = C.muted, align = "center", alpha = 1 } = {}) {
    ctx.globalAlpha = alpha;
    ctx.font = font(size, weight);
    ctx.fillStyle = fill;
    ctx.textAlign = align;
    ctx.fillText(str, x, y);
  }

  function decorations() {
    const { x0, x1, y0, y1 } = region;
    const mid = meta.mid;
    const small = W < 720;
    // 1: block labels
    if (deco[1] > 0.01) {
      const [cc, ce] = meta.blocks.centers;
      text("Exposed", ce, meta.blocks.top, { size: 15, fill: C.exposed, alpha: deco[1] });
      text(`${Math.round(aware.exposed * 100)}% aware of the brand`, ce, meta.blocks.top + 18, { weight: 400, alpha: deco[1] });
      text("Control", cc, meta.blocks.top, { size: 15, fill: C.control, alpha: deco[1] });
      text(`${Math.round(aware.control * 100)}% aware of the brand`, cc, meta.blocks.top + 18, { weight: 400, alpha: deco[1] });
    }
    // 2: confounder axis
    if (deco[2] > 0.01) {
      axisLine(mid, deco[2]);
      text(small ? "Light media use" : "Lighter media use", x0, y1 + 20, { align: "left", weight: 400, alpha: deco[2] });
      text(small ? "Heavy media use" : "Heavier media use", x1, y1 + 20, { align: "right", weight: 400, alpha: deco[2] });
      groupLabels(deco[2]);
    }
    // 3 and 4: propensity axis with the common-support band
    const a34 = Math.max(deco[3], deco[4]);
    if (a34 > 0.01) {
      const sx = (v) => x0 + v * (x1 - x0);
      ctx.globalAlpha = a34 * 0.13;
      ctx.fillStyle = C.support;
      ctx.fillRect(sx(support[0]), y0, sx(support[1]) - sx(support[0]), y1 - y0);
      axisLine(mid, a34);
      [0, 0.25, 0.5, 0.75, 1].forEach((v) => text(v.toFixed(2).replace(/0$/, "").replace(/\.$/, ""), sx(v), y1 + 20, { weight: 400, alpha: a34 }));
      text(small ? "Estimated chance of exposure" : "Propensity score: estimated chance of being exposed", (x0 + x1) / 2, y1 + 40, { weight: 400, alpha: a34 });
      groupLabels(a34);
    }
    // 5: closing labels
    if (deco[5] > 0.01) {
      const R = Math.min((y1 - y0) * 0.5, (x1 - x0) * (small ? 0.3 : 0.2));
      const cx = (x0 + x1) / 2;
      text("Exposed", cx - R * 1.1, y1 + 22, { size: 14, fill: C.exposed, alpha: deco[5] });
      text("Control", cx + R * 1.1, y1 + 22, { size: 14, fill: C.control, alpha: deco[5] });
    }
    ctx.globalAlpha = 1;
  }

  function axisLine(y, alpha) {
    ctx.globalAlpha = alpha * 0.9;
    ctx.strokeStyle = C.line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(region.x0, y);
    ctx.lineTo(region.x1, y);
    ctx.stroke();
  }

  function groupLabels(alpha) {
    text("Exposed", region.x0, region.y0 + 4, { align: "left", fill: C.exposed, alpha });
    text("Control", region.x0, region.y1 - 2, { align: "left", fill: C.control, alpha });
  }

  function draw(now) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const L = layouts[Math.max(0, stage)];
    const dur = reduce.matches ? 1 : 1100;
    let moving = false;
    for (let s = 0; s < STAGES; s++) {
      const target = s === stage ? 1 : 0;
      deco[s] = reduce.matches ? target : deco[s] + (target - deco[s]) * 0.09;
      if (Math.abs(target - deco[s]) > 0.01) moving = true;
    }
    decorations();
    const drift = stage === 0 && !reduce.matches;
    for (let pass = 0; pass < 2; pass++) {
      // Controls first, exposed on top.
      ctx.fillStyle = pass ? C.exposed : C.control;
      for (let i = 0; i < N; i++) {
        if (d.t[i] !== pass) continue;
        const k0 = (now - changedAt - delay[i] * 420) / dur;
        const k = k0 >= 1 ? 1 : k0 <= 0 ? 0 : ease(k0);
        if (k < 1) moving = true;
        let x = from.x[i] + (L.x[i] - from.x[i]) * k;
        let y = from.y[i] + (L.y[i] - from.y[i]) * k;
        const r = from.r[i] + (L.r[i] - from.r[i]) * k;
        const a = from.a[i] + (L.a[i] - from.a[i]) * k;
        cur.x[i] = x; cur.y[i] = y; cur.r[i] = r; cur.a[i] = a;
        if (drift) {
          x += Math.sin(now / 2600 + seedA[i] * 9) * 7;
          y += Math.cos(now / 3100 + seedB[i] * 9) * 7;
        }
        ctx.globalAlpha = a;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(0.5, r), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    return moving || drift;
  }

  function loop(now) {
    raf = 0;
    const again = draw(now);
    if (visible && again) raf = requestAnimationFrame(loop);
  }
  function kick() {
    if (!raf && visible) raf = requestAnimationFrame(loop);
  }

  new IntersectionObserver((entries) => {
    visible = entries[0].isIntersecting;
    if (visible) kick();
  }).observe(root);
  new ResizeObserver(() => { resize(); kick(); }).observe(canvas);
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { readColors(); kick(); });
  window.addEventListener("scroll", onScroll, { passive: true });
  resize();
  onScroll();
  if (stage < 0) setStage(0);
}
