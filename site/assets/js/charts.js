// Chart components shared by the concept pages and the walkthrough.
// Every chart is drawn at the container's real pixel width (so text never shrinks) and redraws on resize.
// Colours come from CSS custom properties, so charts follow the light/dark theme without re-rendering.
import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm";

export { d3 };

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

// ---------------------------------------------------------------- tooltip
let tipEl = null;
export const tip = {
  show(html, event) {
    if (!tipEl) {
      tipEl = document.createElement("div");
      tipEl.className = "tooltip";
      tipEl.setAttribute("role", "status");
      document.body.appendChild(tipEl);
    }
    tipEl.innerHTML = html;
    tipEl.classList.add("is-on");
    const r = tipEl.getBoundingClientRect();
    const x = Math.min(window.innerWidth - r.width - 8, Math.max(8, event.clientX + 14));
    const y = event.clientY - r.height - 14 < 8 ? event.clientY + 18 : event.clientY - r.height - 14;
    tipEl.style.left = x + "px";
    tipEl.style.top = y + "px";
  },
  hide() {
    if (tipEl) tipEl.classList.remove("is-on");
  },
};

function hover(sel, html) {
  sel
    .on("mousemove", function (event, d) { tip.show(html(d, this), event); })
    .on("mouseleave", () => tip.hide());
}

/** Run fn once, the first time el scrolls into view. */
export function whenVisible(el, fn, margin = "0px 0px -15% 0px") {
  if (!("IntersectionObserver" in window)) return fn();
  const io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) {
      io.disconnect();
      fn();
    }
  }, { rootMargin: margin });
  io.observe(el);
}

/**
 * Base chart: owns the <svg>, the margin convention and resize handling.
 * draw(ctx, data) is called with ctx = { g, w, h, t } where t(selection) returns a transition
 * when the update should animate and the plain selection otherwise.
 */
export function makeChart(el, { height = 320, margin = {}, label = "" } = {}, draw) {
  const m = { top: 16, right: 16, bottom: 36, left: 16, ...margin };
  const root = d3.select(el).classed("chart", true);
  const svg = root.append("svg").attr("role", "img").attr("aria-label", label);
  const g = svg.append("g");
  let data = null;

  function render(animate) {
    if (data === null) return;
    const mm = typeof margin === "function" ? { ...m, ...margin(el.clientWidth) } : { ...m };
    if (data && data.xTitle) mm.bottom = Math.max(mm.bottom, 52);
    const width = Math.max(260, el.clientWidth);
    const H = typeof height === "function" ? height(data, width) : height;
    svg.attr("width", width).attr("height", H).attr("viewBox", `0 0 ${width} ${H}`);
    g.attr("transform", `translate(${mm.left},${mm.top})`);
    const go = animate && !reduceMotion.matches;
    const t = (sel, dur = 650) => (go ? sel.transition().duration(dur).ease(d3.easeCubicOut) : sel);
    // cx is the horizontal centre of the whole figure in plot coordinates, for centring axis titles.
    draw({ svg, g, w: width - mm.left - mm.right, h: H - mm.top - mm.bottom, cx: width / 2 - mm.left, t, animate: go }, data);
  }

  let lastW = 0;
  new ResizeObserver(() => {
    if (Math.abs(el.clientWidth - lastW) < 2) return;
    lastW = el.clientWidth;
    render(false);
  }).observe(el);

  return {
    set(next, animate = true) {
      data = next;
      lastW = el.clientWidth;
      render(animate);
    },
    describe(text) {
      svg.attr("aria-label", text);
    },
  };
}

function ensure(parent, selector, tag, cls) {
  let s = parent.select(selector);
  if (s.empty()) s = parent.append(tag).attr("class", cls);
  return s;
}

const pct = (v, d = 1) => (v * 100).toFixed(d) + "%";

// ------------------------------------------------------------ mirrorHist
/**
 * Mirrored propensity-score histogram: exposed bars up, control bars down.
 * data: { edges, exposed, control, support?: [lo, hi], ghost?: { exposed, control }, unit?: string }
 */
export function mirrorHist(el, opts = {}) {
  return makeChart(el, { height: opts.height || 340, margin: { top: 10, right: 8, bottom: 44, left: 8 }, label: opts.label || "Mirrored histogram of propensity scores" }, (ctx, d) => {
    const { g, w, h, t } = ctx;
    const x = d3.scaleLinear([0, 1], [0, w]);
    const all = [...d.exposed, ...d.control, ...(d.ghost ? [...d.ghost.exposed, ...d.ghost.control] : [])];
    const max = (opts.fixedMax || d3.max(all) || 1) * 1.05;
    const mid = h / 2;
    const y = d3.scaleLinear([0, max], [0, mid - 6]).clamp(true);
    const bw = (i) => Math.max(1, x(d.edges[i + 1]) - x(d.edges[i]) - 1.5);

    const sup = ensure(g, ".support", "g", "support");
    const hasSup = Array.isArray(d.support) && d.support[1] > d.support[0];
    const supRect = ensure(sup, "rect", "rect", "").style("fill", "var(--support-soft)");
    t(supRect).attr("x", hasSup ? x(d.support[0]) : 0).attr("width", hasSup ? x(d.support[1]) - x(d.support[0]) : 0)
      .attr("y", 0).attr("height", h).style("opacity", hasSup ? 1 : 0);

    const axis = ensure(g, ".x-axis", "g", "x-axis").attr("transform", `translate(0,${h})`);
    axis.call(d3.axisBottom(x).tickValues([0, 0.25, 0.5, 0.75, 1]).tickFormat(d3.format(".2~f")).tickSizeOuter(0).tickPadding(8));
    ensure(g, ".axis-title", "text", "axis-title").attr("x", w / 2).attr("y", h + 38).attr("text-anchor", "middle")
      .text(opts.xTitle || "Propensity score: estimated probability of being exposed");
    ensure(g, ".midline", "line", "midline").attr("x1", 0).attr("x2", w).attr("y1", mid).attr("y2", mid).style("stroke", "var(--line)");

    const side = (key, dir) => {
      const sel = g.selectAll(`rect.bar-${key}`).data(d[key]);
      const enter = sel.enter().append("rect").attr("class", `bar-${key}`).attr("rx", 1.5)
        .style("fill", `var(--${key})`).attr("x", (_, i) => x(d.edges[i]) + 0.75).attr("width", (_, i) => bw(i))
        .attr("y", mid).attr("height", 0);
      const merged = enter.merge(sel);
      t(merged).attr("x", (_, i) => x(d.edges[i]) + 0.75).attr("width", (_, i) => bw(i))
        .attr("y", (v) => (dir < 0 ? mid - 1 - y(v) : mid + 1)).attr("height", (v) => y(v));
      sel.exit().remove();
      hover(merged, (v, node) => {
        const i = merged.nodes().indexOf(node);
        const who = key === "exposed" ? "Exposed" : "Control";
        return `<b>${who}</b>Score ${d.edges[i].toFixed(2)}–${d.edges[i + 1].toFixed(2)}: ${pct(v)} of ${d.unit || "the group"}`;
      });
    };
    side("exposed", -1);
    side("control", 1);

    // Outline of the unadjusted shape, shown behind weighted or matched bars.
    const outline = (vals, dir) => {
      let p = "";
      vals.forEach((v, i) => {
        const yy = dir < 0 ? mid - 1 - y(v) : mid + 1 + y(v);
        p += `${i ? "L" : "M"}${x(d.edges[i])},${yy}L${x(d.edges[i + 1])},${yy}`;
      });
      return p;
    };
    ["exposed", "control"].forEach((key, k) => {
      const path = ensure(g, `.ghost-${key}`, "path", `ghost-${key}`).style("fill", "none")
        .style("stroke", "var(--ink)").style("stroke-width", 1.25).style("stroke-dasharray", "3 3");
      if (d.ghost) t(path).attr("d", outline(d.ghost[key], k ? 1 : -1)).style("opacity", 0.55);
      else path.style("opacity", 0);
    });

    ensure(g, ".lab-e", "text", "lab-e label-strong").attr("x", 4).attr("y", 14).style("fill", "var(--exposed)").text("Exposed");
    ensure(g, ".lab-c", "text", "lab-c label-strong").attr("x", 4).attr("y", h - 8).style("fill", "var(--control)").text("Control");
  });
}

// ----------------------------------------------------------- estimateRows
/**
 * Horizontal estimates with optional intervals, replicate samples and a truth line.
 * data: { rows: [{ label, value, lo?, hi?, samples?, color?, shape?, hollow?, note? }], truth?, truthLabel?, domain?, fmt?, zero? }
 */
export function estimateRows(el, opts = {}) {
  const rowH = opts.rowH || 44;
  const left = (width) => ({ left: Math.min(opts.labelWidth || 170, Math.round(width * 0.36)) });
  return makeChart(el, { height: (d) => d.rows.length * rowH + (d.xTitle ? 78 : 62), margin: (w) => ({ top: 26, right: 58, ...left(w) }), label: opts.label || "Estimates" }, (ctx, d) => {
    const { g, w, h, t } = ctx;
    const fmt = d.fmt || ((v) => (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(2));
    const tickFmt = d.tickFmt || ((v) => (v > 0 ? "+" : v < 0 ? "−" : "") + d3.format("~g")(Math.abs(v)));
    const vals = d.rows.flatMap((r) => [r.value, r.lo, r.hi, ...(r.samples || [])]).filter((v) => Number.isFinite(v));
    if (Number.isFinite(d.truth)) vals.push(d.truth);
    if (d.zero !== false) vals.push(0);
    let dom = d.domain || d3.extent(vals);
    if (!d.domain) {
      const pad = (dom[1] - dom[0]) * 0.12 || 0.1;
      dom = [dom[0] - pad, dom[1] + pad];
    }
    const x = d3.scaleLinear(dom, [0, w]).clamp(true);
    const y = (i) => i * rowH + rowH / 2;

    const axis = ensure(g, ".x-axis", "g", "x-axis").attr("transform", `translate(0,${h})`);
    t(axis).call(d3.axisBottom(x).ticks(Math.max(3, Math.floor(w / 90))).tickFormat(tickFmt).tickSizeOuter(0).tickPadding(8));
    const grid = ensure(g, ".grid", "g", "grid");
    grid.call(d3.axisBottom(x).ticks(Math.max(3, Math.floor(w / 90))).tickSize(h).tickFormat(""));
    grid.select(".domain").remove();
    if (d.xTitle) ensure(g, ".axis-title", "text", "axis-title").attr("x", ctx.cx).attr("y", h + 42).attr("text-anchor", "middle").text(d.xTitle);

    const zero = ensure(g, ".zero", "line", "zero").style("stroke", "var(--faint)");
    t(zero).attr("x1", x(0)).attr("x2", x(0)).attr("y1", 0).attr("y2", h).style("opacity", d.zero === false || dom[0] > 0 || dom[1] < 0 ? 0 : 1);

    const truth = ensure(g, ".truth", "g", "truth");
    const hasTruth = Number.isFinite(d.truth);
    const tl = ensure(truth, "line", "line", "").style("stroke", "var(--support)").style("stroke-width", 2).style("stroke-dasharray", "5 4");
    const tt = ensure(truth, "text", "text", "").style("fill", "var(--support)").style("font-weight", 600).attr("y", -10);
    truth.style("opacity", hasTruth ? 1 : 0);
    if (hasTruth) {
      t(tl).attr("x1", x(d.truth)).attr("x2", x(d.truth)).attr("y1", -4).attr("y2", h);
      const near = x(d.truth) > w - 70;
      t(tt).attr("x", x(d.truth)).attr("text-anchor", near ? "end" : x(d.truth) < 50 ? "start" : "middle");
      tt.text(d.truthLabel || "True effect");
    }

    const rows = g.selectAll("g.row").data(d.rows, (r) => r.key || r.label);
    rows.exit().remove();
    const enter = rows.enter().append("g").attr("class", "row").attr("transform", (_, i) => `translate(0,${y(i)})`);
    enter.append("text").attr("class", "row-label label-strong").attr("x", -14).attr("dy", "0.35em").attr("text-anchor", "end");
    enter.append("text").attr("class", "row-note").attr("x", -14).attr("dy", "1.7em").attr("text-anchor", "end").style("font-size", "11px");
    enter.append("g").attr("class", "samples");
    enter.append("line").attr("class", "ci").style("stroke-width", 2).style("stroke-linecap", "round");
    enter.append("path").attr("class", "pt");
    enter.append("text").attr("class", "row-value label-strong").attr("dy", "0.35em");
    const all = enter.merge(rows);
    t(all).attr("transform", (_, i) => `translate(0,${y(i)})`);
    all.select(".row-label").text((r) => r.label).attr("dy", (r) => (r.note ? "-0.15em" : "0.35em"));
    all.select(".row-note").text((r) => r.note || "");
    const col = (r) => r.color || "var(--ink)";
    all.each(function (r) {
      const row = d3.select(this);
      const pts = row.select(".samples").selectAll("circle").data(r.samples || []);
      pts.exit().remove();
      const merged = pts.enter().append("circle").attr("r", 2.6).attr("cx", x(r.value))
        .attr("cy", (_, i) => (((i * 7919) % 17) / 17 - 0.5) * 20).style("opacity", 0.32).merge(pts);
      merged.style("fill", col(r));
      t(merged).attr("cx", (v) => x(v));
      const hasCi = Number.isFinite(r.lo) && Number.isFinite(r.hi);
      t(row.select(".ci").style("stroke", col(r)).style("opacity", hasCi ? 0.9 : 0))
        .attr("x1", hasCi ? x(r.lo) : x(r.value)).attr("x2", hasCi ? x(r.hi) : x(r.value));
      const sym = d3.symbol().type(r.shape === "diamond" ? d3.symbolDiamond : d3.symbolCircle).size(r.shape === "diamond" ? 120 : 150)();
      const pt = row.select(".pt").attr("d", sym).style("stroke", col(r)).style("stroke-width", 2)
        .style("fill", r.hollow ? "var(--bg-alt)" : col(r));
      t(pt).attr("transform", `translate(${x(r.value)},0)`);
      const reach = (r.samples || []).reduce((mx, v) => Math.max(mx, x(v)), x(r.value));
      const end = hasCi ? Math.max(x(r.hi), reach) : reach;
      t(row.select(".row-value")).attr("x", Math.min(w + 8, end + 12));
      row.select(".row-value").text(fmt(r.value)).style("fill", col(r));
    });
    hover(all, (r) => `<b>${r.label}</b>${fmt(r.value)}${Number.isFinite(r.lo) ? ` (${fmt(r.lo)} to ${fmt(r.hi)})` : ""}${r.tip ? "<br>" + r.tip : ""}`);
  });
}

// --------------------------------------------------------------- lovePlot
/**
 * Love plot of absolute standardised mean differences before and after adjustment.
 * data: { rows: [{ label, before, after, hidden? }], threshold?: 0.1 }
 */
export function lovePlot(el, opts = {}) {
  const rowH = opts.rowH || 26;
  return makeChart(el, { height: (d) => d.rows.length * rowH + 58, margin: (w) => ({ top: 20, right: 20, bottom: 38, left: Math.min(opts.labelWidth || 200, Math.round(w * 0.42)) }), label: opts.label || "Covariate balance before and after adjustment" }, (ctx, d) => {
    const { g, w, h, t } = ctx;
    const thr = d.threshold ?? 0.1;
    const max = Math.max(opts.minMax || 0.3, d3.max(d.rows, (r) => Math.max(Math.abs(r.before), Math.abs(r.after))) * 1.08);
    const x = d3.scaleLinear([0, max], [0, w]);
    const y = (i) => i * rowH + rowH / 2;

    const axis = ensure(g, ".x-axis", "g", "x-axis").attr("transform", `translate(0,${h})`);
    t(axis).call(d3.axisBottom(x).ticks(Math.max(3, Math.floor(w / 80))).tickSizeOuter(0).tickPadding(8));
    ensure(g, ".axis-title", "text", "axis-title").attr("x", ctx.cx).attr("y", h + 36).attr("text-anchor", "middle").text("Absolute standardised mean difference");
    const th = ensure(g, ".thr", "g", "thr");
    t(ensure(th, "line", "line", "").style("stroke", "var(--bias)").style("stroke-dasharray", "4 4"))
      .attr("x1", x(thr)).attr("x2", x(thr)).attr("y1", -6).attr("y2", h);
    t(ensure(th, "text", "text", "").style("fill", "var(--bias)").attr("y", -9).attr("text-anchor", "middle").text(String(thr))).attr("x", x(thr));

    const rows = g.selectAll("g.row").data(d.rows, (r) => r.label);
    rows.exit().remove();
    const enter = rows.enter().append("g").attr("class", "row").attr("transform", (_, i) => `translate(0,${y(i)})`);
    enter.append("line").attr("class", "guide").attr("x1", 0).style("stroke", "var(--line-soft)");
    enter.append("text").attr("class", "row-label").attr("x", -12).attr("dy", "0.35em").attr("text-anchor", "end");
    enter.append("line").attr("class", "move").style("stroke", "var(--faint)").style("stroke-width", 1.25);
    enter.append("circle").attr("class", "before").attr("r", 5).style("fill", "var(--bg-alt)").style("stroke-width", 1.75).attr("cx", (r) => x(Math.abs(r.before)));
    enter.append("circle").attr("class", "after").attr("r", 5).attr("cx", (r) => x(Math.abs(r.before)));
    const all = enter.merge(rows);
    t(all).attr("transform", (_, i) => `translate(0,${y(i)})`);
    all.select(".guide").attr("x2", w);
    all.select(".row-label").text((r) => (r.label.length > 30 ? r.label.slice(0, 29) + "…" : r.label))
      .style("fill", (r) => (r.hidden ? "var(--bias)" : "var(--ink-2)")).style("font-weight", (r) => (r.hidden ? 600 : 400));
    t(all.select(".before").style("stroke", (r) => (r.hidden ? "var(--bias)" : "var(--faint)"))).attr("cx", (r) => x(Math.abs(r.before)));
    t(all.select(".after").style("fill", (r) => (Math.abs(r.after) > thr ? "var(--bias)" : "var(--ink)"))).attr("cx", (r) => x(Math.abs(r.after)));
    t(all.select(".move")).attr("x1", (r) => x(Math.abs(r.before))).attr("x2", (r) => x(Math.abs(r.after)));
    hover(all, (r) => `<b>${r.label}</b>Before ${r.before.toFixed(3)}<br>After ${r.after.toFixed(3)}`);
  });
}

// ------------------------------------------------------------ weightCurve
/** Weight given to a respondent as a function of their propensity score, for both groups. data: { kind, cap } */
export function weightCurve(el, opts = {}) {
  const FN = {
    none: [() => 1, () => 1],
    att: [() => 1, (e) => e / (1 - e)],
    ate: [(e) => 1 / e, (e) => 1 / (1 - e)],
    overlap: [(e) => 1 - e, (e) => e],
  };
  return makeChart(el, { height: opts.height || 250, margin: { top: 30, right: 12, bottom: 42, left: 40 }, label: "Weight as a function of the propensity score" }, (ctx, d) => {
    const { g, w, h, t } = ctx;
    const cap = d.cap || 8;
    const x = d3.scaleLinear([0, 1], [0, w]);
    const y = d3.scaleLinear([0, cap], [h, 0]).clamp(true);
    ensure(g, ".x-axis", "g", "x-axis").attr("transform", `translate(0,${h})`)
      .call(d3.axisBottom(x).tickValues([0, 0.25, 0.5, 0.75, 1]).tickFormat(d3.format(".2~f")).tickSizeOuter(0).tickPadding(8));
    ensure(g, ".y-axis", "g", "y-axis").call(d3.axisLeft(y).ticks(4).tickSizeOuter(0).tickPadding(6));
    ensure(g, ".axis-title", "text", "axis-title").attr("x", w / 2).attr("y", h + 38).attr("text-anchor", "middle").text("Propensity score");
    ensure(g, ".y-title", "text", "y-title axis-title").attr("x", -34).attr("y", -14).text("Weight");
    const grid = d3.range(0.02, 0.981, 0.01);
    const line = d3.line().x((e) => x(e)).y((e, _, arr) => y(arr.fn(e))).curve(d3.curveMonotoneX);
    const fns = FN[d.kind] || FN.none;
    ["exposed", "control"].forEach((key, k) => {
      const pts = Object.assign(grid.slice(), { fn: fns[k] });
      const path = ensure(g, `.wc-${key}`, "path", `wc-${key}`).style("fill", "none").style("stroke", `var(--${key})`).style("stroke-width", 2.5);
      t(path).attr("d", line(pts));
    });
  });
}

// ------------------------------------------------------------ calibration
/** Decile calibration of the propensity model. data: { points: [[meanPredicted, observedRate, n], ...] } */
export function calibrationPlot(el) {
  return makeChart(el, { height: 330, margin: { top: 38, right: 16, bottom: 44, left: 46 }, label: "Calibration of the propensity model by decile" }, (ctx, d) => {
    const { g, w, h, t } = ctx;
    const x = d3.scaleLinear([0, 1], [0, w]);
    const y = d3.scaleLinear([0, 1], [h, 0]);
    ensure(g, ".x-axis", "g", "x-axis").attr("transform", `translate(0,${h})`).call(d3.axisBottom(x).ticks(5).tickSizeOuter(0).tickPadding(8));
    ensure(g, ".y-axis", "g", "y-axis").call(d3.axisLeft(y).ticks(5).tickSizeOuter(0).tickPadding(6));
    ensure(g, ".axis-title", "text", "axis-title").attr("x", w / 2).attr("y", h + 38).attr("text-anchor", "middle").text("Mean predicted propensity (decile)");
    ensure(g, ".y-title", "text", "y-title axis-title").attr("x", -40).attr("y", -20).text("Share actually exposed");
    ensure(g, ".diag", "line", "diag").attr("x1", x(0)).attr("y1", y(0)).attr("x2", x(1)).attr("y2", y(1)).style("stroke", "var(--faint)").style("stroke-dasharray", "4 4");
    const pts = g.selectAll("circle.cal").data(d.points);
    const merged = pts.enter().append("circle").attr("class", "cal").attr("r", 6).style("fill", "var(--ink)").attr("cx", (p) => x(p[0])).attr("cy", y(0)).merge(pts);
    t(merged, 900).attr("cx", (p) => x(p[0])).attr("cy", (p) => y(p[1]));
    pts.exit().remove();
    hover(merged, (p) => `<b>Decile of ${Math.round(p[2])} respondents</b>Predicted ${pct(p[0])}<br>Observed ${pct(p[1])}`);
  });
}

// ---------------------------------------------------------------- barList
/** Plain HTML bar list. rows: [{ label, value, text }] */
export function barList(el, rows, { color = "var(--ink)" } = {}) {
  const max = d3.max(rows, (r) => r.value) || 1;
  el.innerHTML = "";
  el.style.display = "grid";
  el.style.gap = "9px";
  rows.forEach((r, i) => {
    const row = document.createElement("div");
    row.style.cssText = "display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 12px;font-size:13px;align-items:baseline";
    row.innerHTML =
      `<span style="color:var(--ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.label}</span>` +
      `<span style="color:var(--muted);font-variant-numeric:tabular-nums">${r.text}</span>` +
      `<span style="grid-column:1/-1;height:6px;border-radius:6px;background:var(--line-soft);overflow:hidden">` +
      `<i style="display:block;height:100%;width:0;border-radius:6px;background:${color};transition:width .9s cubic-bezier(.28,.11,.32,1) ${i * 40}ms"></i></span>`;
    el.appendChild(row);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      row.querySelector("i").style.width = (r.value / max) * 100 + "%";
    }));
  });
}

/** Animate a number inside el towards value. */
export function countTo(el, value, fmt = (v) => v.toFixed(0), duration = 500) {
  const from = Number(el.dataset.v ?? value);
  el.dataset.v = String(value);
  if (reduceMotion.matches || !Number.isFinite(from) || from === value) {
    el.textContent = fmt(value);
    return;
  }
  const start = performance.now();
  const tick = (now) => {
    const k = Math.min(1, (now - start) / duration);
    const e = 1 - Math.pow(1 - k, 3);
    el.textContent = fmt(from + (value - from) * e);
    if (k < 1 && el.dataset.v === String(value)) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** Debounce to the next animation frame so slider drags stay smooth. */
export function onFrame(fn) {
  let queued = false;
  return (...args) => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn(...args);
    });
  };
}
