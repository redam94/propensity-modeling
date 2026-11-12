// Renders the API reference from site/assets/data/api.json, which scripts/build_site_data.py
// generates by introspecting the package. Nothing on this page is written by hand.
const esc = window.Site.esc;
const api = await fetch("assets/data/api.json").then((r) => r.json());
const body = document.getElementById("api-body");
const toc = document.getElementById("api-toc");

const models = api.schemas.groups.flatMap((g) => g.models);
const KNOWN = new Set([...models.map((m) => m.name), ...api.schemas.aliases.map((a) => a.name)]);
const DATACLASSES = {};
api.modules.forEach((m) => m.members.forEach((x) => { if (x.kind === "dataclass") DATACLASSES[x.name] = `${m.name}-${x.name}`; }));

/** Escape a type string and link any schema or alias names inside it. */
function typeHtml(t) {
  return esc(t || "").replace(/\b[A-Z][A-Za-z]+\b/g, (name) =>
    KNOWN.has(name) ? `<a href="#${name}">${name}</a>` : DATACLASSES[name] ? `<a href="#${DATACLASSES[name]}">${name}</a>` : name);
}

/** Docstrings use reST-style ``code`` and :func:`x` roles; render them as inline code. */
function docHtml(doc) {
  return esc(doc || "")
    .replace(/:(?:func|class|mod|meth):`~?([^`]+)`/g, "<code>$1</code>")
    .replace(/``([^`]+)``/g, "<code>$1</code>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>");
}

function signature(fn) {
  const parts = fn.params.map((p) => `${p.name}${p.type ? ": " + p.type : ""}${"default" in p ? " = " + p.default : ""}`);
  const ret = fn.returns ? ` -> ${fn.returns}` : "";
  const oneLine = `${fn.name}(${parts.join(", ")})${ret}`;
  return oneLine.length <= 84 ? oneLine : `${fn.name}(\n${parts.map((p) => "    " + p + ",").join("\n")}\n)${ret}`;
}

const source = (s) => (s ? `<p class="api-meta">Defined in <a href="${s.url}">${esc(s.path)}${s.line ? ":" + s.line : ""}</a></p>` : "");
const anchor = (id) => `<a class="anchor" href="#${id}" aria-label="Link to this entry">#</a>`;

function fieldsTable(fields, ownerId) {
  if (!fields.length) return "";
  const rows = fields.map((f) => {
    const def = f.required ? '<span class="pill pill--req">required</span>' : `<code>${esc(f.default ?? "")}</code>`;
    const extra = (f.constraints || []).length ? ` <span class="pill">${esc(f.constraints.join(", "))}</span>` : "";
    return `<tr id="${ownerId}-${f.name}" class="api-field"><td><code>${esc(f.name)}</code>${f.inherited ? ' <span class="pill">inherited</span>' : ""}</td>` +
      `<td><code>${typeHtml(f.type)}</code></td><td>${def}${extra}</td><td>${docHtml(f.description)}</td></tr>`;
  });
  return `<div class="table-wrap"><table><thead><tr><th>Field</th><th>Type</th><th>Default</th><th>Description</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}

function functionEntry(fn, id) {
  const params = fn.params.length
    ? `<div class="table-wrap"><table><thead><tr><th>Parameter</th><th>Type</th><th>Default</th></tr></thead><tbody>${fn.params
        .map((p) => `<tr><td><code>${esc(p.name)}</code></td><td><code>${typeHtml(p.type)}</code></td><td>${p.required ? '<span class="pill pill--req">required</span>' : `<code>${esc(p.default)}</code>`}</td></tr>`)
        .join("")}</tbody></table></div>`
    : "";
  return `<article class="api-entry" id="${id}" data-name="${esc(fn.name)}">
    <h3><code>${esc(fn.name)}()</code>${fn.exported ? '<span class="pill">exported from propensity_lift</span>' : ""}${anchor(id)}</h3>
    <pre class="api-sig"><code>${typeHtml(signature(fn))}</code></pre>
    ${fn.doc ? `<p class="api-doc">${docHtml(fn.doc)}</p>` : ""}
    ${params}
    ${fn.returns ? `<p class="api-meta">Returns <code>${typeHtml(fn.returns)}</code></p>` : ""}
    ${source(fn.source)}
  </article>`;
}

function classEntry(c, id, label) {
  const methods = (c.methods || []).length
    ? `<p class="api-meta">${c.methods.map((m) => `<code>${esc(m.name)}${m.kind === "method" ? esc(m.signature || "()") : ""}</code>${m.kind === "property" ? " (property)" : ""}${m.doc ? ": " + docHtml(m.doc) : ""}`).join("<br>")}</p>`
    : "";
  return `<article class="api-entry" id="${id}" data-name="${esc(c.name)}">
    <h3><code>${esc(c.name)}</code><span class="pill">${label}</span>${(c.bases || []).map((b) => `<span class="pill">extends <a href="#${b}">${b}</a></span>`).join("")}${anchor(id)}</h3>
    ${c.doc ? `<p class="api-doc">${docHtml(c.doc)}</p>` : ""}
    ${fieldsTable(c.fields, id)}
    ${methods}
    ${source(c.source)}
  </article>`;
}

// ------------------------------------------------------------------ build
const sections = [];
const tocGroups = [];

// Overview
sections.push(`<section id="overview" data-title="Package overview">
  <h2>Package</h2>
  <div class="prose">
    <p>The distribution is <code>${esc(api.distribution)}</code> and the import name is <code>${esc(api.package)}</code>. This reference describes version <strong>${esc(api.version)}</strong> and is generated from the source, so it lists exactly what the code defines.</p>
  </div>
  <figure class="code"><pre data-lang="python"><code>from propensity_lift import AnalysisConfig, load_table, profile_dataframe, run_analysis</code></pre></figure>
  <div class="table-wrap"><table><thead><tr><th>Start here</th><th>What it does</th></tr></thead><tbody>
    ${api.modules.flatMap((m) => m.members.filter((x) => x.exported).map((x) => [m, x]))
      .map(([m, x]) => `<tr><td><a href="#${m.name}-${x.name}"><code>${esc(x.name)}()</code></a></td><td>${docHtml((x.doc || m.role).split("\n\n")[0])}</td></tr>`).join("")}
    <tr><td><a href="#AnalysisConfig"><code>AnalysisConfig</code></a></td><td>Every option for a run.</td></tr>
    <tr><td><a href="#AnalysisResult"><code>AnalysisResult</code></a></td><td>Everything a run returns.</td></tr>
  </tbody></table></div>
  <p class="api-meta">All ${api.exports.length} names exported from the package root: ${api.exports.map((n) => {
    const target = KNOWN.has(n) ? n : (api.modules.flatMap((m) => m.members.filter((x) => x.name === n).map(() => `${m.name}-${n}`))[0] || "");
    return target ? `<a href="#${target}"><code>${esc(n)}</code></a>` : `<code>${esc(n)}</code>`;
  }).join(", ")}.</p>
</section>`);
tocGroups.push({ title: "Start", links: [["overview", "Package"]] });

// Schemas
api.schemas.groups.forEach((g, gi) => {
  const id = `schemas-${gi}`;
  sections.push(`<section id="${id}" data-title="${esc(g.title)}"><h2>${esc(g.title)}</h2>${gi === 0 ? `<div class="prose"><p>The config and result models are <a href="https://docs.pydantic.dev/">pydantic</a> models defined in <code>propensity_lift.schemas</code>. They serialise with <code>model_dump_json()</code> and load with <code>model_validate()</code>. The HTTP API and the web interface use the same shapes.</p></div>` : ""}
    ${g.models.map((m) => classEntry(m, m.name, "model")).join("")}</section>`);
  tocGroups.push({ title: g.title, links: g.models.map((m) => [m.name, m.name]) });
});

// Type aliases
sections.push(`<section id="types" data-title="Type aliases"><h2>Type aliases</h2>
  <div class="prose"><p>Literal types that constrain config fields and label results.</p></div>
  <div class="table-wrap"><table><thead><tr><th>Name</th><th>Allowed values</th></tr></thead><tbody>
  ${api.schemas.aliases.map((a) => `<tr id="${a.name}" class="api-field"><td><code>${esc(a.name)}</code></td><td>${a.values.length ? a.values.map((v) => `<code>${esc(JSON.stringify(v))}</code>`).join(" ") : `<code>${typeHtml(a.type)}</code>`}</td></tr>`).join("")}
  </tbody></table></div></section>`);
tocGroups.push({ title: "Types", links: [["types", "Type aliases"]] });

// Modules
api.modules.forEach((m) => {
  const id = `mod-${m.name}`;
  const constants = m.constants.length
    ? `<div class="table-wrap"><table><thead><tr><th>Constant</th><th>Value</th></tr></thead><tbody>${m.constants.map((c) => `<tr><td><code>${esc(c.name)}</code></td><td><code>${esc(c.value.length > 120 ? c.value.slice(0, 117) + "…" : c.value)}</code></td></tr>`).join("")}</tbody></table></div>`
    : "";
  sections.push(`<section id="${id}" data-title="${esc(m.import)}">
    <div class="api-module-head"><h2><code style="background:none;padding:0">${esc(m.import)}</code></h2><p>${docHtml(m.doc || m.role)}</p>
    <p class="api-meta"><a href="${m.source.url}">${esc(m.source.path)}</a></p></div>
    ${constants}
    ${m.members.map((x) => (x.kind === "function" ? functionEntry(x, `${m.name}-${x.name}`) : classEntry(x, `${m.name}-${x.name}`, "dataclass"))).join("")}
  </section>`);
});
tocGroups.push({ title: "Modules", links: api.modules.map((m) => [`mod-${m.name}`, m.name, m.role]) });

// CLI
sections.push(`<section id="cli" data-title="Command line"><h2>Command line</h2>
  <div class="prose"><p>Installing the package adds a <code>propensity-lift</code> command. This is its own help output.</p></div>
  ${api.cli.map((c) => `<article class="api-entry" data-name="${esc(c.command)}"><h3><code>${esc(c.command)}</code></h3><pre class="api-sig"><code>${esc(c.help)}</code></pre></article>`).join("")}
  <p class="api-meta">Exit status is 0 on success and 2 when the file or config is invalid; the message goes to standard error.</p></section>`);

// HTTP
if (api.http.length) {
  sections.push(`<section id="http" data-title="HTTP API"><h2>HTTP API</h2>
    <div class="prose"><p>The FastAPI service in <code>backend/</code> wraps the same library. Routes are read from its OpenAPI document; interactive docs are served at <code>/docs</code> when it is running.</p></div>
    <div class="table-wrap"><table><thead><tr><th>Method</th><th>Path</th><th>Parameters and body</th><th>Responses</th></tr></thead><tbody>
    ${api.http.map((r) => {
      const params = r.params.map((p) => `<code>${esc(p.name)}</code> <span class="pill">${p.in}${p.required ? ", required" : ""}</span>`);
      if (r.body) params.push(`body: <code>${typeHtml(r.body)}</code>`);
      const responses = r.responses.map((x) => `<code>${x.status}</code>${x.schema ? ` <code>${typeHtml(x.schema)}</code>` : ""}`).join("<br>");
      return `<tr class="api-field"><td><span class="pill pill--${r.method.toLowerCase()}">${r.method}</span></td><td><code>${esc(r.path)}</code><br><span style="color:var(--muted)">${esc(r.summary)}</span></td><td>${params.join("<br>") || "—"}</td><td>${responses}</td></tr>`;
    }).join("")}
    </tbody></table></div>
    <p class="api-meta">Validation errors raised by this service return 422 with <code>detail</code> as a string. Malformed request bodies return FastAPI's standard 422 with <code>detail</code> as a list.</p></section>`);
}
tocGroups.push({ title: "Interfaces", links: [["cli", "Command line"], ...(api.http.length ? [["http", "HTTP API"]] : [])] });

body.innerHTML = sections.join("");
toc.innerHTML =
  '<input class="doc-filter" id="api-filter" type="search" placeholder="Filter the reference" aria-label="Filter the reference" autocomplete="off" spellcheck="false">' +
  tocGroups.map((g) => `<p class="doc-toc-group">${esc(g.title)}</p><ul>${g.links.map(([id, label]) => `<li><a href="#${id}">${esc(label)}</a></li>`).join("")}</ul>`).join("");

window.Site.setupCode(body);
window.Site.setupToc();

// ----------------------------------------------------------------- filter
const filter = document.getElementById("api-filter");
const empty = document.getElementById("api-empty");
filter.addEventListener("input", () => {
  const q = filter.value.trim().toLowerCase();
  let shown = 0;
  body.querySelectorAll("section").forEach((sec) => {
    const entries = sec.querySelectorAll(".api-entry");
    let any = false;
    entries.forEach((e) => {
      const on = !q || e.textContent.toLowerCase().includes(q);
      e.hidden = !on;
      any = any || on;
    });
    if (!entries.length) any = !q || sec.textContent.toLowerCase().includes(q);
    sec.hidden = !any;
    if (any) shown++;
  });
  empty.hidden = shown > 0;
  if (!shown) empty.querySelector("span").textContent = filter.value.trim();
});

// Anchors exist only after rendering, so honour the URL hash now (and on later in-page navigation).
function flash() {
  const target = location.hash && document.getElementById(decodeURIComponent(location.hash.slice(1)));
  if (!target) return;
  target.scrollIntoView({ block: "start" });
  target.classList.add("is-target");
  setTimeout(() => target.classList.remove("is-target"), 2200);
}
flash();
window.addEventListener("hashchange", flash);
