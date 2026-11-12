// Renders the walkthrough from site/assets/data/walkthrough.json, a real run_analysis() result on the
// bundled sample data (see scripts/build_site_data.py). Numbers in the prose are bound to the same file
// through data-w attributes, so text and charts cannot disagree.
import { mirrorHist, estimateRows, lovePlot, calibrationPlot, barList, whenVisible } from "./charts.js";

const esc = window.Site.esc;
const data = await fetch("assets/data/walkthrough.json").then((r) => r.json());
const result = data.result;

const METHOD_NAMES = { nn_matching: "Matching", ipw: "IPW", overlap_weights: "Overlap weights", stratification: "Stratification", aipw: "AIPW" };
const pretty = (s) => s.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
const sign = (v, d) => (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(d);
const FMT = {
  int: (v) => Math.round(v).toLocaleString("en-US"),
  f1: (v) => v.toFixed(1),
  f2: (v) => v.toFixed(2),
  f3: (v) => v.toFixed(3),
  pct: (v) => (v * 100).toFixed(1) + "%",
  pct0: (v) => (v * 100).toFixed(0) + "%",
  rawpct: (v) => v.toFixed(1) + "%",
  pp: (v) => sign(v * 100, 1) + " pp",
  signed: (v) => sign(v, 2),
  p: (v) => (v < 0.001 ? "< 0.001" : v.toFixed(3)),
};

// Path lookup with array selectors: result.methods[ipw].contrasts[consideration].lift
function resolve(path) {
  let cur = data;
  for (const seg of path.split(".")) {
    if (cur === undefined || cur === null) return undefined;
    const m = seg.match(/^(\w+)\[(.+)\]$/);
    if (m) {
      const arr = cur[m[1]];
      cur = Array.isArray(arr) ? arr.find((o) => [o.method, o.outcome, o.region, o.feature, o.name].includes(m[2])) : undefined;
    } else cur = cur[seg];
  }
  return cur;
}
document.querySelectorAll("[data-w]").forEach((node) => {
  const v = resolve(node.getAttribute("data-w"));
  if (v === undefined || v === null) return;
  const f = FMT[node.getAttribute("data-fmt")];
  node.textContent = f ? f(v) : String(v);
});

const $ = (id) => document.getElementById(id);
const table = (head, rows) =>
  `<table><thead><tr>${head.map((h) => `<th${h.num ? ' class="num"' : ""}>${h.label ?? h}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c, i) => `<td${head[i].num ? ' class="num"' : ""}>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;

function seg(mount, name, options, onChange) {
  mount.innerHTML = options
    .map((o, i) => `<label><input type="radio" name="${name}" value="${esc(o.value)}"${i === 0 ? " checked" : ""}><span>${esc(o.label)}</span></label>`)
    .join("");
  mount.querySelectorAll("input").forEach((r) => r.addEventListener("change", () => onChange(r.value)));
  return options[0].value;
}

// ------------------------------------------------------------------ data
{
  const cols = Object.keys(data.head[0]).slice(0, 9);
  $("w-head").innerHTML = table(cols, data.head.map((row) => cols.map((c) => esc(row[c] ?? "—"))));
  const ROLE = { treatment: "Treatment", outcome: "Outcome", model_feature: "Model feature", matching_feature: "Matching feature", id: "ID", ignore: "Ignore" };
  $("w-profile").innerHTML = table(
    ["Column", "Kind", { label: "Missing", num: true }, { label: "Unique", num: true }, "Suggested role"],
    data.profile.map((c) => [`<code>${esc(c.name)}</code>`, c.kind, c.n_missing, c.n_unique, `<span class="pill">${ROLE[c.suggested_role] || "—"}</span>`]),
  );
}

// ------------------------------------------------------------- run output
{
  const pre = $("w-progress");
  const lines = data.stages.map(([frac, stage]) => `${String(Math.round(frac * 100)).padStart(3)}% ${stage}`);
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  whenVisible(pre, () => {
    if (reduce) {
      pre.textContent = lines.join("\n");
      return;
    }
    let i = 0;
    const tick = () => {
      pre.textContent = lines.slice(0, ++i).join("\n");
      pre.scrollTop = pre.scrollHeight;
      if (i < lines.length) setTimeout(tick, 70);
    };
    tick();
  });
  const warnings = [...result.warnings.map((w) => ["Run", w]), ...result.methods.flatMap((m) => m.warnings.map((w) => [METHOD_NAMES[m.method], w]))];
  $("w-warnings").innerHTML = table(["From", "Warning"], warnings.map(([from, w]) => [`<span class="pill">${from}</span>`, esc(w)]));
}

// ---------------------------------------------------------------- overlap
{
  const h = result.overlap.histogram;
  const share = (counts) => {
    const total = counts.reduce((a, b) => a + b, 0) || 1;
    return counts.map((c) => c / total);
  };
  const chart = mirrorHist($("w-overlap"), { height: 360 });
  whenVisible($("w-overlap"), () =>
    chart.set({ edges: h.edges, exposed: share(h.exposed_counts), control: share(h.control_counts),
      support: [result.overlap.common_support_lower, result.overlap.common_support_upper] }));
  $("w-regions").innerHTML = table(
    ["Region", "Score range", { label: "Exposed", num: true }, { label: "Control", num: true }],
    result.overlap.regions.map((r) => [`<code>${r.region}</code>`, `${r.lower.toFixed(2)} to ${r.upper.toFixed(2)}`,
      `${r.n_exposed.toLocaleString("en-US")} (${r.pct_exposed.toFixed(1)}%)`, `${r.n_control.toLocaleString("en-US")} (${r.pct_control.toFixed(1)}%)`]),
  );
  const worst = [...result.feature_overlap].sort((a, b) => a.overlap_coefficient - b.overlap_coefficient).slice(0, 6);
  $("w-feature-overlap").innerHTML = table(
    ["Feature", "Role", { label: "Overlap coefficient", num: true }, { label: "Exposed unsupported", num: true }, { label: "Control unsupported", num: true }],
    worst.map((f) => [`<code>${esc(f.feature)}</code>`, f.role, f.overlap_coefficient.toFixed(2), f.pct_exposed_unsupported.toFixed(1) + "%", f.pct_control_unsupported.toFixed(1) + "%"]),
  );
}

// ------------------------------------------------------------------ model
{
  const cal = calibrationPlot($("w-calibration"));
  whenVisible($("w-calibration"), () => cal.set({ points: result.model.calibration }));
  whenVisible($("w-importance"), () =>
    barList($("w-importance"), result.model.feature_importance.slice(0, 10).map((f) => ({ label: f.feature, value: f.importance, text: (f.importance * 100).toFixed(1) + "%" }))));
}

// ---------------------------------------------------------------- balance
{
  const love = lovePlot($("w-love"), { labelWidth: 230, rowH: 26, minMax: 0.42 });
  const TOP = 16;
  const show = (method) => {
    const m = result.methods.find((x) => x.method === method);
    const rows = [...m.balance].sort((a, b) => Math.abs(b.smd_before) - Math.abs(a.smd_before)).slice(0, TOP)
      .map((b) => ({ label: b.variable, before: b.smd_before, after: b.smd_after }));
    love.set({ rows });
    $("w-love-note").textContent = `The ${TOP} most imbalanced of ${m.balance.length} variables before adjustment. ${m.label}.`;
  };
  const first = seg($("w-love-method"), "love-method", result.methods.map((m) => ({ value: m.method, label: METHOD_NAMES[m.method] })), show);
  whenVisible($("w-love"), () => show(first));
  $("w-balance-summary").innerHTML = table(
    ["Method", { label: "Largest |SMD| before", num: true }, { label: "Largest |SMD| after", num: true }, { label: "Imbalanced after", num: true }, { label: "Effective controls", num: true }],
    result.methods.map((m) => [esc(m.label), m.balance_summary.max_abs_smd_before.toFixed(3), m.balance_summary.max_abs_smd_after.toFixed(3),
      m.balance_summary.n_imbalanced_after, Math.round(m.weights ? m.weights.ess_control : m.n_control_used).toLocaleString("en-US")]),
  );
}

// ------------------------------------------------------------------- lift
function contrastRows(outcome, pick) {
  const any = result.methods[0].contrasts.find((c) => c.outcome === outcome);
  const binary = any.outcome_type === "binary";
  const k = binary ? 100 : 1;
  const fmt = binary ? (v) => sign(v, 1) : (v) => sign(v, 2);
  return { binary, k, fmt, unit: binary ? "percentage points" : "scale points", raw: any.raw_diff * k, rows: pick(k) };
}

{
  const chart = estimateRows($("w-lift"), { labelWidth: 150, rowH: 46 });
  const show = (outcome) => {
    const info = contrastRows(outcome, (k) =>
      result.methods.map((m) => {
        const c = m.contrasts.find((x) => x.outcome === outcome);
        return { key: m.method, label: METHOD_NAMES[m.method], value: c.lift * k, lo: c.ci_low * k, hi: c.ci_high * k, hollow: !c.significant,
          tip: `p = ${FMT.p(c.p_value)}, ${Math.round(c.effective_n_control).toLocaleString("en-US")} effective controls` };
      }));
    const noEffect = data.true_effects[outcome] === 0;
    chart.set({
      rows: [{ key: "raw", label: "Raw difference", note: "no adjustment", value: info.raw, color: "var(--faint)", shape: "diamond", hollow: true }, ...info.rows],
      fmt: info.fmt, truth: noEffect ? 0 : undefined, truthLabel: "True effect: none", xTitle: `Lift in ${pretty(outcome).toLowerCase()} (${info.unit})`,
    });
    const mean = (v) => (info.binary ? (v * 100).toFixed(1) + "%" : v.toFixed(2));
    $("w-lift-table").innerHTML = table(
      ["Method", { label: "Exposed", num: true }, { label: "Adjusted control", num: true }, { label: "Lift", num: true }, { label: "95% interval", num: true }, { label: "p", num: true }],
      result.methods.map((m) => {
        const c = m.contrasts.find((x) => x.outcome === outcome);
        return [esc(m.label), mean(c.exposed_mean), mean(c.control_mean_adjusted), `<strong>${info.fmt(c.lift * info.k)}</strong>`,
          `${info.fmt(c.ci_low * info.k)} to ${info.fmt(c.ci_high * info.k)}`, FMT.p(c.p_value)];
      }),
    );
  };
  const outcomes = result.config.outcome_columns.map((o) => ({ value: o, label: pretty(o) }));
  const first = seg($("w-lift-outcome"), "lift-outcome", outcomes, show);
  whenVisible($("w-lift"), () => show(first));
}

// -------------------------------------------------------------- subgroups
{
  const chart = estimateRows($("w-subgroups"), { labelWidth: 150, rowH: 50 });
  const m = result.methods.find((x) => x.method === "ipw") || result.methods[0];
  const show = (outcome) => {
    const overall = m.contrasts.find((c) => c.outcome === outcome);
    const info = contrastRows(outcome, (k) =>
      m.subgroups.filter((s) => s.outcome === outcome).map((s) => ({
        key: s.subgroup_level, label: s.subgroup_level, note: `${s.n_exposed} exposed, ${s.n_control} control`,
        value: s.lift * k, lo: s.ci_low * k, hi: s.ci_high * k, hollow: !s.significant })));
    chart.set({
      rows: [{ key: "all", label: "Everyone", note: `${overall.n_exposed} exposed`, value: overall.lift * info.k, lo: overall.ci_low * info.k, hi: overall.ci_high * info.k, hollow: !overall.significant }, ...info.rows],
      fmt: info.fmt, xTitle: `Lift in ${pretty(outcome).toLowerCase()} (${info.unit}), ${m.label}`,
    });
  };
  const first = seg($("w-subgroup-outcome"), "subgroup-outcome", result.config.outcome_columns.slice(0, 4).map((o) => ({ value: o, label: pretty(o) })), show);
  whenVisible($("w-subgroups"), () => show(first));
}
