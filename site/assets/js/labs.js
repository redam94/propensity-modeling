// Interactive demonstrations for the concept pages. Each lab is a <div data-lab="name"> whose copy and
// layout live in the HTML; this module simulates data, estimates effects and draws the charts.
import {
  makeRng, sigmoid, fitLogistic, balancingWeights, matchWeights, strataWeights, diffMeans, smd, ess, auc,
  psHistogram, ovl, commonSupport, mean, sd,
} from "./sim.js";
import { d3, mirrorHist, estimateRows, lovePlot, weightCurve, whenVisible, countTo, onFrame, tip } from "./charts.js";

const el = (root, name) => root.querySelector(`[data-el="${name}"]`);
const signed = (v, d = 2) => (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(d);
const clip = (p, lo = 0.02, hi = 0.98) => Float64Array.from(p, (v) => Math.min(hi, Math.max(lo, v)));

const LABS = { dag: dagLab, hidden: hiddenLab, overlap: overlapLab, methods: methodsLab, builder: builderLab };
document.querySelectorAll("[data-lab]").forEach((root) => {
  const init = LABS[root.getAttribute("data-lab")];
  if (init) whenVisible(root, () => init(root), "200px 0px");
});

function setVerdict(node, tone, title, body) {
  node.setAttribute("data-tone", tone);
  node.innerHTML = `<b>${title}</b>${body}`;
}

// ====================================================================== DAG
function dagLab(root) {
  const TRUE_EFFECT = 0.7; // 0.25 direct + 0.5 x 0.9 through ad recall
  const VARS = {
    C: { label: "Heavy streamer", sub: "causes both", x: 0.5, y: 0.0 },
    Z: { label: "Targeted region", sub: "causes exposure only", x: 0, y: 0.2 },
    P: { label: "Category buyer", sub: "causes outcome only", x: 1, y: 0.2 },
    M: { label: "Ad recall", sub: "caused by exposure", x: 0.5, y: 0.62, yCompact: 0.42 },
    K: { label: "Visited brand site", sub: "caused by both", x: 0.5, y: 1 },
  };
  const FIXED = {
    T: { label: "Ad exposure", sub: "treatment", x: 0, y: 0.62 },
    Y: { label: "Purchase intent", sub: "outcome", x: 1, y: 0.62 },
  };
  const EDGES = [
    ["C", "T"], ["C", "Y"], ["Z", "T"], ["P", "Y"], ["T", "M"], ["M", "Y"], ["T", "Y", "arc"], ["T", "K"], ["Y", "K"],
  ];
  const adjusted = new Set();

  // Replicate surveys, so the chart can show both bias (where the cloud sits) and noise (how wide it is).
  const REPS = 120, n = 1200;
  const rng = makeRng(4242);
  const sims = Array.from({ length: REPS }, () => {
    const s = { C: new Float64Array(n), Z: new Float64Array(n), P: new Float64Array(n), M: new Float64Array(n), K: new Float64Array(n), T: new Uint8Array(n), Y: new Float64Array(n) };
    for (let i = 0; i < n; i++) {
      s.C[i] = rng.n(); s.Z[i] = rng.n(); s.P[i] = rng.n();
      s.T[i] = rng.bern(sigmoid(-0.2 + 0.9 * s.C[i] + 1.1 * s.Z[i]));
      s.M[i] = 0.9 * s.T[i] + 0.8 * rng.n();
      s.Y[i] = 0.25 * s.T[i] + 0.5 * s.M[i] + 0.8 * s.C[i] + 1.2 * s.P[i] + rng.n();
      s.K[i] = 0.8 * s.T[i] + 0.7 * s.Y[i] + rng.n();
    }
    return s;
  });
  const ones = new Float64Array(n).fill(1);
  const naive = sims.map((s) => diffMeans(s.Y, s.T, ones));

  const chart = estimateRows(el(root, "estimates"), { labelWidth: 150, rowH: 52, label: "Estimated effect across 120 simulated surveys" });
  const dag = drawDag(el(root, "dag"));
  const chips = el(root, "chips");
  Object.entries(VARS).forEach(([key, v]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.textContent = v.label;
    b.setAttribute("aria-pressed", "false");
    b.addEventListener("click", () => toggle(key));
    b.dataset.key = key;
    chips.appendChild(b);
  });
  root.querySelectorAll("[data-preset]").forEach((b) =>
    b.addEventListener("click", () => {
      adjusted.clear();
      b.getAttribute("data-preset").split("").filter((k) => VARS[k]).forEach((k) => adjusted.add(k));
      update();
    }));

  function toggle(key) {
    adjusted.has(key) ? adjusted.delete(key) : adjusted.add(key);
    update();
  }

  function update() {
    const keys = [...adjusted];
    const est = [], aucs = [];
    sims.forEach((s) => {
      if (!keys.length) {
        est.push(diffMeans(s.Y, s.T, ones));
        aucs.push(0.5);
        return;
      }
      const { p } = fitLogistic(keys.map((k) => s[k]), s.T);
      aucs.push(auc(p, s.T));
      est.push(diffMeans(s.Y, s.T, balancingWeights(clip(p), s.T, "ate")));
    });
    const bias = mean(est) - TRUE_EFFECT;
    const spread = sd(est);
    chart.set({
      rows: [
        { key: "naive", label: "No adjustment", value: mean(naive), samples: naive, color: "var(--faint)" },
        { key: "model", label: "Your model", note: keys.length ? `${keys.length} variable${keys.length > 1 ? "s" : ""}` : "nothing selected", value: mean(est), samples: est },
      ],
      truth: TRUE_EFFECT, truthLabel: "True effect", domain: [-1.15, 1.7], xTitle: "Estimated effect of exposure on purchase intent (scale points)",
    });
    countTo(el(root, "auc"), mean(aucs), (v) => v.toFixed(2));
    countTo(el(root, "bias"), bias, (v) => signed(v));
    countTo(el(root, "spread"), spread, (v) => v.toFixed(2));
    el(root, "bias").parentNode.setAttribute("data-tone", Math.abs(bias) > 0.08 ? "bad" : "good");
    chips.querySelectorAll(".chip").forEach((b) => b.setAttribute("aria-pressed", String(adjusted.has(b.dataset.key))));
    dag.update();

    const v = el(root, "verdict");
    const has = (k) => adjusted.has(k);
    if (has("M") && has("K")) setVerdict(v, "bad", "Two post-exposure variables, two different biases.", "Ad recall carries part of the effect, so holding it fixed removes that part. Site visits are a shared consequence of exposure and intent, so holding them fixed invents an association. Neither belongs in the model.");
    else if (has("M") && !has("C")) setVerdict(v, "bad", "Two errors that happen to cancel.", "Leaving streaming out pushes the estimate up. Holding ad recall fixed pushes it down. Here the two roughly offset, which is luck and not identification: change either strength and the estimate moves away from the truth.");
    else if (has("M")) setVerdict(v, "bad", "You adjusted away part of the effect.", "Ad recall is how the campaign works: exposure raises recall, recall raises intent. Comparing people with equal recall hides everything that travels along that route. The model fits better and the answer is wrong.");
    else if (has("K")) setVerdict(v, "bad", "You opened a path that was closed.", "Visiting the brand site is caused by exposure and by intent. Among people with the same visit behaviour, exposure and intent become linked even where the ad did nothing. Conditioning on a shared consequence creates bias.");
    else if (!has("C")) setVerdict(v, "bad", has("Z") || has("P") ? "The confounder is still out." : "Confounding is doing the talking.", "Heavy streamers see more ads and already lean towards the brand. Until streaming is in the model, its influence is credited to the campaign" + (has("Z") ? ", and adding the targeting variable makes the remaining bias larger, not smaller." : "."));
    else if (has("Z")) setVerdict(v, "neutral", "Unbiased, but you paid for the AUC.", "Targeted region predicts exposure and nothing else. Adding it raises the AUC, pushes scores towards 0 and 1 and scatters the estimates, without removing any bias. A better exposure forecast is not a better adjustment.");
    else if (has("P")) setVerdict(v, "good", "Identified, and tighter.", "Streaming closes the only back-door path. Category buying does not predict exposure at all, yet including it narrows the spread, because it explains outcome variation the weights would otherwise leave as noise.");
    else setVerdict(v, "good", "This set identifies the effect.", "One variable causes both exposure and intent, and it is in the model. The estimates centre on the truth even though the AUC is unremarkable.");
  }

  function drawDag(mount) {
    const svg = d3.select(mount).append("svg").attr("role", "img").attr("aria-label", "Causal diagram of the brand-lift example");
    const defs = svg.append("defs");
    [["plain", "var(--line)"], ["causal", "var(--support)"], ["bias", "var(--bias)"]].forEach(([id, c]) => {
      defs.append("marker").attr("id", `arrow-${id}`).attr("viewBox", "0 0 10 10").attr("refX", 8.5).attr("refY", 5)
        .attr("markerWidth", 7).attr("markerHeight", 7).attr("orient", "auto-start-reverse")
        .append("path").attr("d", "M0,1 L9,5 L0,9 z").style("fill", c);
    });
    const gEdges = svg.append("g"), gFlow = svg.append("g"), gNodes = svg.append("g");
    const all = { ...VARS, ...FIXED };
    let geo = {};

    function layout() {
      const W = Math.max(280, mount.clientWidth);
      const compact = W < 520;
      const H = compact ? 430 : 440;
      const nw = compact ? 106 : 150, nh = compact ? 40 : 46;
      svg.attr("width", W).attr("height", H).attr("viewBox", `0 0 ${W} ${H}`);
      const pad = nw / 2 + 2;
      geo = { W, H, nw, nh, compact, pos: {} };
      Object.entries(all).forEach(([k, v]) => {
        const vy = compact && v.yCompact !== undefined ? v.yCompact : v.y;
        geo.pos[k] = { x: pad + v.x * (W - 2 * pad), y: nh / 2 + 4 + vy * (H - nh - 8) };
      });
    }

    function edgePath(a, b, arc) {
      const A = geo.pos[a], B = geo.pos[b];
      // Trim the segment to the borders of both node boxes.
      const trim = (from, to) => {
        const dx = to.x - from.x, dy = to.y - from.y;
        const k = Math.min(Math.abs((geo.nw / 2 + 5) / (dx || 1e-9)), Math.abs((geo.nh / 2 + 5) / (dy || 1e-9)));
        return { x: from.x + dx * k, y: from.y + dy * k };
      };
      if (arc && !geo.compact) {
        const midY = A.y - geo.nh * 1.55;
        const s = { x: A.x + geo.nw * 0.2, y: A.y - geo.nh / 2 - 4 }, e = { x: B.x - geo.nw * 0.2, y: B.y - geo.nh / 2 - 6 };
        return `M${s.x},${s.y} C${s.x + 40},${midY} ${e.x - 40},${midY} ${e.x},${e.y}`;
      }
      const s = trim(A, B), e = trim(B, A);
      return `M${s.x},${s.y} L${e.x},${e.y}`;
    }

    function state(a, b) {
      const key = a + b;
      if (["TM", "MY"].includes(key)) return adjusted.has("M") ? "blocked" : "causal";
      if (key === "TY") return "causal";
      if (["CT", "CY"].includes(key)) return adjusted.has("C") ? "blocked" : "bias";
      if (["TK", "YK"].includes(key)) return adjusted.has("K") ? "bias" : "plain";
      return "plain";
    }

    function update() {
      layout();
      const edges = gEdges.selectAll("path").data(EDGES, (e) => e[0] + e[1]);
      edges.enter().append("path").merge(edges)
        .attr("d", (e) => edgePath(e[0], e[1], e[2]))
        .attr("class", (e) => { const s = state(e[0], e[1]); return `edge${s === "causal" ? " is-causal" : s === "bias" ? " is-bias" : s === "blocked" ? " is-blocked" : ""}`; })
        .attr("marker-end", (e) => { const s = state(e[0], e[1]); return `url(#arrow-${s === "causal" || s === "bias" ? s : "plain"})`; });
      const flows = gFlow.selectAll("path").data(EDGES, (e) => e[0] + e[1]);
      flows.enter().append("path").merge(flows)
        .attr("d", (e) => edgePath(e[0], e[1], e[2]))
        .attr("class", (e) => { const s = state(e[0], e[1]); return `flow${s === "causal" ? " is-causal" : s === "bias" ? " is-bias" : ""}`; });

      const nodes = gNodes.selectAll("g.node").data(Object.keys(all), (k) => k);
      const enter = nodes.enter().append("g").attr("class", (k) => `node ${VARS[k] ? "is-toggle" : "is-fixed"}`);
      enter.append("rect");
      enter.append("text").attr("class", "name");
      enter.append("text").attr("class", "sub");
      enter.filter((k) => VARS[k]).on("click", (_, k) => toggle(k))
        .on("mousemove", (event, k) => tip.show(`<b>${VARS[k].label}</b>${adjusted.has(k) ? "In the model. Click to remove." : "Not in the model. Click to add."}`, event))
        .on("mouseleave", () => tip.hide());
      const merged = enter.merge(nodes);
      merged.attr("transform", (k) => `translate(${geo.pos[k].x},${geo.pos[k].y})`).classed("is-adjusted", (k) => adjusted.has(k));
      merged.select("rect").attr("x", -geo.nw / 2).attr("y", -geo.nh / 2).attr("width", geo.nw).attr("height", geo.nh).attr("rx", geo.nh / 2);
      merged.select(".name").attr("y", -2).style("font-size", geo.compact ? "11.5px" : "13px").text((k) => all[k].label);
      merged.select(".sub").attr("y", 12).style("font-size", geo.compact ? "9.5px" : "11px").text((k) => all[k].sub);
    }
    let lastW = 0;
    new ResizeObserver(() => {
      if (Math.abs(mount.clientWidth - lastW) > 2) { lastW = mount.clientWidth; update(); }
    }).observe(mount);
    return { update };
  }

  update();
}

// ======================================================== unmeasured confounder
function hiddenLab(root) {
  const n = 4000, TRUE_EFFECT = 0.5;
  const rng = makeRng(99);
  const x1 = new Float64Array(n), x2 = new Float64Array(n), u = new Float64Array(n), ut = new Float64Array(n), noise = new Float64Array(n);
  for (let i = 0; i < n; i++) { x1[i] = rng.n(); x2[i] = rng.n(); u[i] = rng.n(); ut[i] = rng.u(); noise[i] = rng.n(); }
  const ones = new Float64Array(n).fill(1);
  const slider = el(root, "strength"), out = el(root, "strength-out"), reveal = el(root, "reveal");
  const love = lovePlot(el(root, "love"), { labelWidth: 210, rowH: 34, minMax: 0.6 });
  const est = estimateRows(el(root, "estimates"), { labelWidth: 150, rowH: 46 });
  const LEVELS = ["none", "weak", "moderate", "strong", "very strong"];

  const update = onFrame(() => {
    const g = Number(slider.value) / 100;
    out.textContent = LEVELS[Math.min(4, Math.round(g * 4))];
    const t = new Uint8Array(n), y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      t[i] = ut[i] < sigmoid(-0.3 + 0.8 * x1[i] - 0.5 * x2[i] + 1.3 * g * u[i]) ? 1 : 0;
      y[i] = TRUE_EFFECT * t[i] + 0.6 * x1[i] - 0.3 * x2[i] + 1.1 * g * u[i] + noise[i];
    }
    const { p } = fitLogistic([x1, x2], t);
    const w = balancingWeights(p, t, "att");
    const rows = [
      { label: "Streaming hours", before: smd(x1, t), after: smd(x1, t, w) },
      { label: "Age", before: smd(x2, t), after: smd(x2, t, w) },
    ];
    const worst = Math.max(...rows.map((r) => Math.abs(r.after)));
    if (reveal.getAttribute("aria-pressed") === "true") {
      rows.push({ label: "In market for the category", before: smd(u, t), after: smd(u, t, w), hidden: true });
    }
    love.set({ rows });
    const raw = diffMeans(y, t, ones), adj = diffMeans(y, t, w);
    est.set({
      rows: [
        { key: "raw", label: "Raw difference", value: raw, color: "var(--faint)", shape: "diamond", hollow: true },
        { key: "adj", label: "After weighting", value: adj },
      ],
      truth: TRUE_EFFECT, domain: [0, 2.1], zero: false, xTitle: "Estimated effect on favourability (scale points)",
    });
    countTo(el(root, "smd"), worst, (v) => v.toFixed(3));
    countTo(el(root, "bias"), adj - TRUE_EFFECT, (v) => signed(v));
    el(root, "smd").parentNode.setAttribute("data-tone", "good");
    el(root, "bias").parentNode.setAttribute("data-tone", Math.abs(adj - TRUE_EFFECT) > 0.08 ? "bad" : "good");
    const v = el(root, "verdict");
    if (g < 0.08) setVerdict(v, "good", "Balanced, and right.", "Nothing outside the model drives both exposure and the outcome, so balancing what you measured is enough. You cannot know this from the data.");
    else setVerdict(v, "bad", "Balanced, and wrong.", `Every measured covariate is balanced to within ${worst.toFixed(3)} standard deviations, and the estimate is off by ${signed(adj - TRUE_EFFECT)} points. The balance table has no row for a variable the survey never asked about.`);
  });
  slider.addEventListener("input", update);
  reveal.addEventListener("click", () => {
    const on = reveal.getAttribute("aria-pressed") !== "true";
    reveal.setAttribute("aria-pressed", String(on));
    reveal.textContent = on ? "Hide the unmeasured variable" : "Reveal the unmeasured variable";
    update();
  });
  update();
}

// ================================================================== overlap
function overlapLab(root) {
  const n = 5000;
  const rng = makeRng(31);
  const x1 = new Float64Array(n), x2 = new Float64Array(n), ut = new Float64Array(n);
  for (let i = 0; i < n; i++) { x1[i] = rng.n(); x2[i] = rng.n(); ut[i] = rng.u(); }
  const slider = el(root, "sep"), out = el(root, "sep-out");
  const hist = mirrorHist(el(root, "hist"), { height: 360 });

  const update = onFrame(() => {
    const s = Number(slider.value) / 100;
    const t = new Uint8Array(n);
    for (let i = 0; i < n; i++) t[i] = ut[i] < sigmoid(-0.35 + s * (x1[i] + 0.6 * x2[i])) ? 1 : 0;
    const { p } = fitLogistic([x1, x2], t);
    const h = psHistogram(p, t, null, 40);
    const support = commonSupport(p, t);
    hist.set({ ...h, support });
    const w = balancingWeights(p, t, "att");
    let nc = 0, ne = 0, high = 0;
    const cw = [];
    for (let i = 0; i < n; i++) {
      if (t[i]) { ne++; if (p[i] > 0.9) high++; } else { nc++; cw.push(w[i]); }
    }
    cw.sort((a, b) => b - a);
    const total = cw.reduce((a, b) => a + b, 0);
    const top = cw.slice(0, Math.max(1, Math.round(nc * 0.01))).reduce((a, b) => a + b, 0) / total;
    const a = auc(p, t), o = ovl(h), e = ess(w, t, 0);
    out.textContent = a.toFixed(2);
    countTo(el(root, "auc"), a, (v) => v.toFixed(2));
    countTo(el(root, "ovl"), o, (v) => v.toFixed(2));
    countTo(el(root, "ess"), e, (v) => Math.round(v).toLocaleString("en-US"));
    el(root, "ess-of").textContent = `effective controls, out of ${nc.toLocaleString("en-US")} surveyed`;
    countTo(el(root, "top"), top * 100, (v) => v.toFixed(0) + "%");
    countTo(el(root, "high"), (high / ne) * 100, (v) => v.toFixed(0) + "%");
    el(root, "ovl").parentNode.setAttribute("data-tone", o < 0.5 ? "bad" : o > 0.8 ? "good" : "");
    el(root, "ess").parentNode.setAttribute("data-tone", e / nc < 0.25 ? "bad" : "");
    const v = el(root, "verdict");
    if (o > 0.8) setVerdict(v, "good", "Plenty of comparable people.", "The model can barely tell the groups apart, which is the best case for a comparison: almost every exposed respondent has many controls who look like them.");
    else if (o >= 0.5) setVerdict(v, "neutral", "Workable, with care.", "The groups differ but still share most of the score range. Weights are uneven, so check the effective sample size and how much the estimate leans on a few controls.");
    else setVerdict(v, "bad", "The model predicts exposure too well.", `An AUC of ${a.toFixed(2)} would be a success in a targeting model. Here it means the groups barely overlap: ${Math.round(e).toLocaleString("en-US")} effective controls stand in for ${nc.toLocaleString("en-US")}, and the top 1% of them carry ${(top * 100).toFixed(0)}% of the weight.`);
  });
  slider.addEventListener("input", update);
  update();
}

// ================================================================== methods
function methodsLab(root) {
  const n = 6000;
  const rng = makeRng(2718);
  const x = new Float64Array(n), t = new Uint8Array(n), y = new Float64Array(n), tau = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = rng.n();
    t[i] = rng.bern(sigmoid(-0.4 + 1.3 * x[i]));
    tau[i] = 0.3 + 0.35 * x[i]; // the campaign works better on people who were likelier to see it
    y[i] = 0.6 * x[i] + tau[i] * t[i] + rng.n();
  }
  const { p } = fitLogistic([x], t);
  const avg = (wf) => { let s = 0, sw = 0; for (let i = 0; i < n; i++) { const w = wf(i); s += w * tau[i]; sw += w; } return s / sw; };
  const TRUTH = { ATT: avg((i) => t[i]), ATE: avg(() => 1), ATO: avg((i) => p[i] * (1 - p[i])) };
  const ones = new Float64Array(n).fill(1);
  const base = psHistogram(p, t, null, 30);

  const METHODS = {
    none: { target: "ATT", weights: () => ones, kind: "none", title: "No adjustment", body: "Every respondent counts once. The control group stays skewed towards low scores, so the comparison mixes the campaign's effect with the groups' differences." },
    match: { target: "ATT", weights: () => matchWeights(p, t, 0.2).w, kind: null, title: "Matching answers the ATT question.", body: "Each exposed respondent is paired with the nearest control on the score. Controls nobody needs are dropped; exposed respondents with no control inside the caliper are dropped too, which quietly narrows who the answer is about." },
    att: { target: "ATT", weights: () => balancingWeights(p, t, "att"), kind: "att", title: "ATT weights rebuild the control group.", body: "Exposed respondents keep weight 1. Controls are weighted by e / (1 − e), so the ones who resemble exposed respondents count for more. The weighted controls stand in for the exposed group, had it not been exposed." },
    ate: { target: "ATE", weights: () => balancingWeights(p, t, "ate"), kind: "ate", title: "ATE weights rebuild the whole audience, twice.", body: "Both groups are reweighted to look like everyone. That needs exposed people at low scores and controls at high scores, exactly where they are scarce, so a few respondents can carry very large weights." },
    overlap: { target: "ATO", weights: () => balancingWeights(p, t, "overlap"), kind: "overlap", title: "Overlap weights change the question.", body: "Weights are bounded and largest where the groups mix. Balance is exact and the estimate is stable, but it describes the people who could plausibly have gone either way, not the exposed group and not everyone." },
    strata: { target: "ATT", weights: () => strataWeights(p, t, 5), kind: null, title: "Stratification compares within five score bands.", body: "Respondents are grouped by score and controls are reweighted band by band. It is coarse: within a band the groups can still differ, so some imbalance survives." },
  };

  const hist = mirrorHist(el(root, "hist"), { height: 320 });
  const curve = weightCurve(el(root, "curve"));
  const est = estimateRows(el(root, "estimates"), { labelWidth: 170, rowH: 50 });

  function update() {
    const key = root.querySelector('input[name="method"]:checked').value;
    const m = METHODS[key];
    const w = m.weights();
    const used = Float64Array.from(w);
    const h = psHistogram(p, t, used, 30);
    hist.set({ ...h, ghost: key === "none" ? null : base, unit: "the weighted group" });
    el(root, "curve-wrap").hidden = !m.kind;
    el(root, "curve-none").hidden = Boolean(m.kind);
    if (m.kind) curve.set({ kind: m.kind, cap: 8 });
    const estimate = diffMeans(y, t, w);
    est.set({
      rows: [
        { key: "att", label: "True ATT", note: "the exposed", value: TRUTH.ATT, color: "var(--support)", shape: "diamond", hollow: m.target !== "ATT" },
        { key: "ato", label: "True ATO", note: "the overlap", value: TRUTH.ATO, color: "var(--support)", shape: "diamond", hollow: m.target !== "ATO" },
        { key: "ate", label: "True ATE", note: "everyone", value: TRUTH.ATE, color: "var(--support)", shape: "diamond", hollow: m.target !== "ATE" },
        { key: "est", label: "This method", value: estimate },
      ],
      truth: TRUTH[m.target], truthLabel: `Target: ${m.target}`, domain: [0, 1.25], zero: false, xTitle: "Effect of exposure (scale points)",
    });
    let maxW = 0, sumC = 0, nc = 0, dropped = 0;
    for (let i = 0; i < n; i++) {
      if (t[i]) { if (w[i] === 0) dropped++; } else { nc++; sumC += w[i]; }
    }
    const meanC = sumC / nc || 1;
    for (let i = 0; i < n; i++) if (!t[i]) maxW = Math.max(maxW, w[i] / meanC);
    countTo(el(root, "ess-c"), ess(w, t, 0), (v) => Math.round(v).toLocaleString("en-US"));
    countTo(el(root, "ess-e"), ess(w, t, 1), (v) => Math.round(v).toLocaleString("en-US"));
    countTo(el(root, "max-w"), maxW, (v) => v.toFixed(1) + "×");
    countTo(el(root, "smd"), Math.abs(smd(x, t, w)), (v) => v.toFixed(3));
    el(root, "smd").parentNode.setAttribute("data-tone", Math.abs(smd(x, t, w)) > 0.1 ? "bad" : "good");
    setVerdict(el(root, "verdict"), "neutral", m.title, m.body + (key === "match" && dropped ? ` Here ${dropped} exposed respondents found no match.` : ""));
  }
  root.querySelectorAll('input[name="method"]').forEach((r) => r.addEventListener("change", update));
  update();
}

// ========================================================== question builder
function builderLab(root) {
  const POP = {
    ATT: { who: "Among respondents who were exposed", formula: "E[ Y(1) − Y(0) | exposed ]", estimand: "ATT", methods: '["nn_matching", "ipw", "aipw"]',
      commit: "You need a comparable control for every exposed respondent. Controls who resemble no one exposed can simply be ignored." },
    ATE: { who: "Across the whole surveyed audience", formula: "E[ Y(1) − Y(0) ]", estimand: "ATE", methods: '["ipw", "aipw"]',
      commit: "You need comparable people in both directions: exposed respondents who look like typical controls, and the reverse. This is the most demanding choice, and the first to fail when overlap is thin." },
    ATO: { who: "Among respondents who could plausibly have been in either group", formula: "E[ Y(1) − Y(0) ] weighted by e(1 − e)", estimand: "ATT", methods: '["overlap_weights"]',
      commit: "You get stable weights and exact balance, in exchange for describing a population defined by the data. Say so when you report it: the package still labels the run with the configured estimand and adds a warning that the target is the ATO." },
  };
  const DOSE = {
    any: { text: "being exposed to the campaign at least once", values: '["Exposed"]', note: "\"Exposed\" bundles one impression with twenty. The estimate is an average over whatever mix of doses your sample happens to contain." },
    freq: { text: "seeing the campaign three or more times", values: '["3+ exposures"]', note: "Decide what happens to respondents with one or two exposures. Dropping them is a choice about the population; coding them as control changes the comparison." },
    view: { text: "watching the ad to completion", values: '["Completed view"]', note: "Completion is partly the viewer's own choice, made after the ad starts. People who watch to the end differ from people who skip in ways that also predict the outcome." },
  };
  const OUT = {
    aware: { text: "aided awareness", col: '"aided_awareness"', pos: '{"aided_awareness": ["Yes"]}', unit: "percentage points" },
    fav: { text: "favourability", col: '"favorability"', pos: "{}", unit: "points on the 1–5 scale" },
    intent: { text: "top-two-box purchase intent", col: '"purchase_intent"', pos: '{"purchase_intent": ["Definitely will", "Probably will"]}', unit: "percentage points" },
  };
  const pick = (name) => root.querySelector(`input[name="${name}"]:checked`).value;
  function update() {
    const p = POP[pick("pop")], d = DOSE[pick("dose")], o = OUT[pick("out")];
    el(root, "sentence").innerHTML = `${p.who}, how much higher is <strong>${o.text}</strong> because of <strong>${d.text}</strong> than it would have been without it?`;
    el(root, "formula").textContent = p.formula;
    el(root, "unit").textContent = o.unit;
    el(root, "commit").innerHTML = `<li>${p.commit}</li><li>${d.note}</li><li>Everything in the model must be fixed before exposure. Anything the campaign could have changed belongs on the outcome side.</li>`;
    const code =
      `cfg = AnalysisConfig(\n    dataset_id="survey",\n    treatment_column="group",\n    exposed_values=${d.values},\n    outcome_columns=[${o.col}],\n    outcome_positive_values=${o.pos},\n` +
      `    model_features=[...],        # measured before exposure, causes of exposure and outcome\n    estimand="${p.estimand}",\n    methods=${p.methods},\n)`;
    const pre = el(root, "code");
    pre.innerHTML = window.Site.highlight(code, "python");
    pre.dataset.raw = code;
  }
  root.querySelectorAll("input[type=radio]").forEach((r) => r.addEventListener("change", update));
  update();
}
