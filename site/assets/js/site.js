/* Shared chrome for every page: navbar, search, footer, scroll reveals, code blocks.
   Loaded as a classic script directly after <header id="nav"> so the navbar exists at first paint. */
(function () {
  "use strict";

  var PAGES = [
    { href: "index.html", label: "Overview" },
    { href: "framing.html", label: "Frame the question" },
    { href: "identification.html", label: "Identification" },
    { href: "methods.html", label: "Methods" },
    { href: "walkthrough.html", label: "Walkthrough" },
    { href: "use-cases.html", label: "Use cases" },
    { href: "api.html", label: "API reference" },
  ];
  var REPO = "https://github.com/redam94/propensity-modeling";
  var BRAIN = "https://redam94.github.io/second-brain/";

  var here = location.pathname.split("/").pop() || "index.html";
  var ICON_SEARCH =
    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5"/><path d="m13 13 4.5 4.5"/></svg>';
  var MARK =
    '<svg class="brand-mark" viewBox="0 0 24 24" aria-hidden="true"><circle cx="8.6" cy="12" r="6.6" fill="var(--exposed)" opacity=".92"/><circle cx="15.4" cy="12" r="6.6" fill="var(--control)" opacity=".92" style="mix-blend-mode:multiply"/></svg>';

  document.documentElement.classList.remove("no-js");

  // ------------------------------------------------------------------ nav
  var nav = document.getElementById("nav");
  if (nav) {
    var isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
    nav.className = "nav";
    nav.innerHTML =
      '<div class="nav-inner">' +
      '<a class="brand" href="index.html">' + MARK + "<span>propensity_lift</span></a>" +
      '<ul class="nav-links" id="nav-links">' +
      PAGES.map(function (p) {
        return '<li><a href="' + p.href + '"' + (p.href === here ? ' aria-current="page"' : "") + ">" + p.label + "</a></li>";
      }).join("") +
      "</ul>" +
      '<div class="nav-tools">' +
      '<button class="search-btn" type="button" id="search-open" aria-label="Search the documentation">' +
      ICON_SEARCH + "<span>Search</span><kbd>" + (isMac ? "⌘K" : "Ctrl K") + "</kbd></button>" +
      '<button class="menu-btn" type="button" id="menu-btn" aria-label="Menu" aria-expanded="false" aria-controls="nav-links">' +
      '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M2 6h14M2 12h14"/></svg></button>' +
      "</div></div>";
  }

  function ready(fn) {
    if (document.readyState !== "loading") fn();
    else document.addEventListener("DOMContentLoaded", fn);
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  ready(function () {
    // nav behaviour
    var menuBtn = document.getElementById("menu-btn");
    if (menuBtn) {
      menuBtn.addEventListener("click", function () {
        var open = nav.classList.toggle("is-open");
        menuBtn.setAttribute("aria-expanded", String(open));
      });
    }
    var onScroll = function () {
      if (nav) nav.classList.toggle("is-scrolled", window.scrollY > 8);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });

    buildFooter();
    buildSearch();
    setupReveal();
    setupCode();
    setupRanges();
    setupToc();
  });

  // --------------------------------------------------------------- footer
  function buildFooter() {
    var el = document.getElementById("footer");
    if (!el) return;
    el.className = "footer";
    el.innerHTML =
      '<div class="wrap"><div class="footer-grid">' +
      "<div><h2>Understand</h2><ul>" +
      '<li><a href="framing.html">Frame the question</a></li>' +
      '<li><a href="identification.html">Identification</a></li>' +
      '<li><a href="methods.html">Methods</a></li></ul></div>' +
      "<div><h2>Use</h2><ul>" +
      '<li><a href="walkthrough.html">Walkthrough</a></li>' +
      '<li><a href="use-cases.html">Use cases</a></li>' +
      '<li><a href="api.html">API reference</a></li></ul></div>' +
      "<div><h2>Project</h2><ul>" +
      '<li><a href="' + REPO + '">Source on GitHub</a></li>' +
      '<li><a href="' + REPO + '/blob/main/docs/ARCHITECTURE.md">Architecture notes</a></li>' +
      '<li><a href="' + REPO + '/issues">Report a problem</a></li></ul></div>' +
      "<div><h2>Background reading</h2><ul>" +
      '<li><a href="' + BRAIN + '">Second Brain knowledge base</a></li>' +
      '<li><a href="' + BRAIN + 'Research/Econometrics/Identification-Strategies/Propensity-Score-Matching/_Index">Propensity score matching notes</a></li></ul></div>' +
      "</div>" +
      '<p class="footer-note">The charts on the concept pages run small simulations in your browser, so their numbers change a little with each setting. ' +
      "The walkthrough figures come from a real run of the package on its bundled sample data.</p></div>";
  }

  // --------------------------------------------------------------- search
  var index = null;
  var indexPromise = null;

  function sectionTitle(sec) {
    var h = sec.querySelector("h1, h2, h3");
    return sec.getAttribute("data-title") || (h ? h.textContent : "") || "";
  }

  function indexPage(page) {
    return fetch(page.href)
      .then(function (r) { return r.ok ? r.text() : ""; })
      .then(function (html) {
        var doc = new DOMParser().parseFromString(html, "text/html");
        var out = [];
        var h1 = doc.querySelector("h1");
        var desc = doc.querySelector('meta[name="description"]');
        out.push({
          page: page.label, url: page.href, title: h1 ? h1.textContent.trim() : page.label,
          text: desc ? desc.getAttribute("content") : "", weight: 3,
        });
        doc.querySelectorAll("main [id]").forEach(function (sec) {
          if (!/^(SECTION|ARTICLE)$/.test(sec.tagName)) return;
          var title = sectionTitle(sec).replace(/\s+/g, " ").trim();
          if (!title) return;
          var clone = sec.cloneNode(true);
          clone.querySelectorAll("script, style, svg, [data-nosearch]").forEach(function (n) { n.remove(); });
          // Nested sections are indexed on their own; drop them from the parent's text.
          clone.querySelectorAll("section[id], article[id]").forEach(function (n) { n.remove(); });
          out.push({
            page: page.label, url: page.href + "#" + sec.id, title: title,
            text: clone.textContent.replace(/\s+/g, " ").trim(), weight: 1,
          });
        });
        return out;
      })
      .catch(function () { return []; });
  }

  function indexApi() {
    return fetch("assets/data/api.json")
      .then(function (r) { return r.json(); })
      .then(function (api) {
        var out = [];
        var page = "API reference";
        api.modules.forEach(function (m) {
          out.push({ page: page, url: "api.html#mod-" + m.name, title: m.import, text: m.role + ". " + m.doc, code: true, weight: 2 });
          m.members.forEach(function (f) {
            out.push({
              page: page, url: "api.html#" + m.name + "-" + f.name, title: f.name + (f.kind === "function" ? "()" : ""),
              text: (f.signature ? f.name + f.signature + " — " : "") + (f.doc || m.role), code: true, weight: f.exported ? 4 : 2,
            });
          });
        });
        api.schemas.groups.forEach(function (g) {
          g.models.forEach(function (model) {
            out.push({
              page: page, url: "api.html#" + model.name, title: model.name,
              text: (model.doc || g.title) + " Fields: " + model.fields.map(function (f) { return f.name; }).join(", "),
              code: true, weight: 4,
            });
            model.fields.forEach(function (f) {
              if (f.inherited) return;
              out.push({
                page: page, url: "api.html#" + model.name + "-" + f.name, title: model.name + "." + f.name,
                text: f.type + (f.description ? " — " + f.description : ""), code: true, weight: 1.5,
              });
            });
          });
        });
        api.schemas.aliases.forEach(function (a) {
          out.push({ page: page, url: "api.html#" + a.name, title: a.name, text: a.type, code: true, weight: 2 });
        });
        api.http.forEach(function (r) {
          out.push({ page: page, url: "api.html#http", title: r.method + " " + r.path, text: r.summary || "HTTP endpoint", code: true, weight: 2 });
        });
        api.cli.forEach(function (c) {
          out.push({ page: page, url: "api.html#cli", title: c.command, text: c.help.replace(/\s+/g, " "), code: true, weight: 2 });
        });
        return out;
      })
      .catch(function () { return []; });
  }

  function loadIndex() {
    if (!indexPromise) {
      var jobs = PAGES.filter(function (p) { return p.href !== "api.html"; }).map(indexPage);
      jobs.push(indexApi());
      indexPromise = Promise.all(jobs).then(function (parts) {
        index = [].concat.apply([], parts).map(function (d) {
          d.lt = d.title.toLowerCase();
          d.lx = (d.text || "").toLowerCase();
          return d;
        });
        return index;
      });
    }
    return indexPromise;
  }

  // Light stemming so "confounder" finds "confounding" and "weights" finds "weighting".
  function stem(t) {
    return t.length > 5 ? t.replace(/(ing|ers|er|ed|es|s)$/, "") : t;
  }

  function query(q) {
    var tokens = q.toLowerCase().split(/[\s.]+/).filter(Boolean).map(stem);
    if (!tokens.length || !index) return [];
    var exact = q.toLowerCase().trim();
    var hits = [];
    index.forEach(function (d) {
      var score = 0;
      var matched = 0;
      for (var i = 0; i < tokens.length; i++) {
        var t = tokens[i];
        var ti = d.lt.indexOf(t);
        var xi = d.lx.indexOf(t);
        if (ti < 0 && xi < 0) continue;
        matched++;
        if (ti === 0) score += 14;
        else if (ti > 0) score += /[\s._(-]/.test(d.lt[ti - 1]) ? 10 : 6;
        if (xi >= 0) score += 1 + Math.min(3, d.lx.split(t).length - 1) * 0.5;
      }
      if (!matched) return;
      if (d.lt === exact || d.lt === exact + "()") score += 30;
      hits.push({ doc: d, matched: matched, score: score * d.weight });
    });
    // Entries matching every word come first; partial matches only fill in when there are few of those.
    hits.sort(function (a, b) { return b.matched - a.matched || b.score - a.score; });
    var full = hits.filter(function (h) { return h.matched === tokens.length; });
    return (full.length >= 3 ? full : hits).slice(0, 14);
  }

  function mark(text, tokens) {
    var out = esc(text);
    tokens.forEach(function (t) {
      if (t.length < 2) return;
      out = out.replace(new RegExp("(" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")(?![^<]*>)", "gi"), "<mark>$1</mark>");
    });
    return out;
  }

  function snippet(d, tokens) {
    var text = d.text || "";
    var pos = -1;
    for (var i = 0; i < tokens.length && pos < 0; i++) pos = d.lx.indexOf(tokens[i]);
    var start = Math.max(0, pos - 50);
    var s = (start > 0 ? "…" : "") + text.slice(start, start + 150);
    return mark(s, tokens);
  }

  function buildSearch() {
    var overlay = document.createElement("div");
    overlay.className = "search";
    overlay.id = "search";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Search the documentation");
    overlay.innerHTML =
      '<div class="search-panel"><div class="search-field">' + ICON_SEARCH +
      '<input id="search-input" type="search" placeholder="Search concepts, methods, fields…" autocomplete="off" spellcheck="false" aria-controls="search-results">' +
      '<button class="search-close" type="button" id="search-close">Esc</button></div>' +
      '<ul class="search-results" id="search-results" role="listbox"></ul></div>';
    document.body.appendChild(overlay);

    var input = overlay.querySelector("#search-input");
    var list = overlay.querySelector("#search-results");
    var openBtn = document.getElementById("search-open");
    var active = -1;
    var lastFocus = null;

    var SUGGEST = [
      ["Why a high AUC is a warning", "identification.html#overlap"],
      ["Which variables belong in the model", "framing.html#dag"],
      ["ATT, ATE and ATO", "methods.html#estimands"],
      ["AnalysisConfig", "api.html#AnalysisConfig"],
      ["Run the sample analysis", "walkthrough.html#run"],
    ];

    function renderSuggest() {
      list.innerHTML =
        '<li class="search-group">Try</li>' +
        SUGGEST.map(function (s) {
          return '<li class="search-hit" role="option"><a href="' + s[1] + '"><span class="search-hit-title">' + s[0] + "</span></a></li>";
        }).join("");
      active = -1;
    }

    function render() {
      var q = input.value.trim();
      if (!q) return renderSuggest();
      if (!index) {
        list.innerHTML = '<li class="search-empty">Building the index…</li>';
        return;
      }
      var tokens = q.toLowerCase().split(/[\s.]+/).filter(Boolean).map(stem);
      var hits = query(q);
      if (!hits.length) {
        list.innerHTML =
          '<li class="search-empty">Nothing matches “' + esc(q) + "”. Try a method name such as <a href=\"methods.html#ipw\">IPW</a>, " +
          'or a config field such as <a href="api.html#AnalysisConfig-caliper">caliper</a>.</li>';
        active = -1;
        return;
      }
      var html = "";
      var lastPage = "";
      hits.forEach(function (h) {
        var d = h.doc;
        if (d.page !== lastPage) {
          html += '<li class="search-group">' + esc(d.page) + "</li>";
          lastPage = d.page;
        }
        var title = mark(d.title, tokens);
        html +=
          '<li class="search-hit" role="option"><a href="' + d.url + '"><span class="search-hit-title">' +
          (d.code ? "<code>" + title + "</code>" : title) + '</span><span class="search-hit-text">' + snippet(d, tokens) + "</span></a></li>";
      });
      list.innerHTML = html;
      setActive(0);
    }

    function hitsEls() {
      return Array.prototype.slice.call(list.querySelectorAll(".search-hit"));
    }
    function setActive(i) {
      var els = hitsEls();
      if (!els.length) return;
      active = (i + els.length) % els.length;
      els.forEach(function (el, k) {
        el.classList.toggle("is-active", k === active);
        el.setAttribute("aria-selected", String(k === active));
      });
      els[active].scrollIntoView({ block: "nearest" });
    }

    function open() {
      lastFocus = document.activeElement;
      overlay.classList.add("is-open");
      if (nav) nav.classList.remove("is-open");
      input.value = "";
      renderSuggest();
      void overlay.offsetWidth; // apply visibility now, so focus lands before the first keystroke
      input.focus();
      setTimeout(function () { input.focus(); }, 60);
      loadIndex().then(function () { if (input.value.trim()) render(); });
    }
    function close() {
      overlay.classList.remove("is-open");
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    }

    if (openBtn) openBtn.addEventListener("click", open);
    overlay.querySelector("#search-close").addEventListener("click", close);
    overlay.addEventListener("click", function (e) { if (e.target === overlay) close(); });
    input.addEventListener("input", render);
    list.addEventListener("click", function (e) {
      // Same-page hash links do not reload, so the overlay has to close itself.
      if (e.target.closest("a")) setTimeout(close, 0);
    });
    overlay.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { e.preventDefault(); close(); }
      else if (e.key === "ArrowDown") { e.preventDefault(); setActive(active + 1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setActive(active - 1); }
      else if (e.key === "Enter") {
        var els = hitsEls();
        var el = els[active < 0 ? 0 : active];
        if (el) { e.preventDefault(); el.querySelector("a").click(); }
      } else if (e.key === "Tab") {
        // Keep focus inside the dialog.
        e.preventDefault();
        input.focus();
      }
    });
    document.addEventListener("keydown", function (e) {
      var typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || "");
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) { e.preventDefault(); open(); }
      else if (e.key === "/" && !typing && !overlay.classList.contains("is-open")) { e.preventDefault(); open(); }
    });
  }

  // --------------------------------------------------------------- reveal
  function setupReveal() {
    var els = Array.prototype.slice.call(document.querySelectorAll("[data-reveal]"));
    if (!els.length) return;
    // Headlines reveal by clipping an inner wrapper (see the note in site.css).
    els.forEach(function (el) {
      if (!/\b(headline|display)\b/.test(el.className) || el.querySelector(".reveal-inner")) return;
      var inner = document.createElement("span");
      inner.className = "reveal-inner";
      while (el.firstChild) inner.appendChild(el.firstChild);
      el.appendChild(inner);
    });
    // Stagger siblings that enter together.
    var seen = new Map();
    els.forEach(function (el) {
      var n = seen.get(el.parentNode) || 0;
      if (!el.style.getPropertyValue("--i")) el.style.setProperty("--i", String(Math.min(n, 6)));
      seen.set(el.parentNode, n + 1);
    });
    if (!("IntersectionObserver" in window)) {
      els.forEach(function (el) { el.classList.add("is-in"); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          en.target.classList.add("is-in");
          io.unobserve(en.target);
        }
      });
    }, { rootMargin: "0px 0px -12% 0px", threshold: 0.05 });
    els.forEach(function (el) { io.observe(el); });
  }

  // ----------------------------------------------------------------- code
  var KEYWORDS = "from|import|as|def|return|for|in|if|else|elif|None|True|False|lambda|with|not|and|or|class|is|while|try|except|raise";
  var GRAMMARS = {
    python: new RegExp(
      "(#.*$)|(\"\"\"[\\s\\S]*?\"\"\"|f?\"(?:[^\"\\\\\\n]|\\\\.)*\"|f?'(?:[^'\\\\\\n]|\\\\.)*')|\\b(\\d+(?:\\.\\d+)?)\\b|\\b(" + KEYWORDS + ")\\b|\\b([A-Za-z_]\\w*)(?=\\()", "gm"),
    bash: /(#.*$)|("(?:[^"\\\n]|\\.)*"|'[^'\n]*')|()(\s--?[a-zA-Z][\w-]*)|(^\s*(?:uv|make|pip|git|curl|cd|npm|python|propensity-lift)\b)/gm,
    json: /()("(?:[^"\\\n]|\\.)*"(?=\s*:))|(-?\b\d+(?:\.\d+)?\b)|\b(true|false|null)\b|("(?:[^"\\\n]|\\.)*")/gm,
  };
  var CLASSES = ["tok-com", "tok-str", "tok-num", "tok-key", "tok-fn"];
  var JSON_CLASSES = ["tok-com", "tok-fn", "tok-num", "tok-key", "tok-str"];

  function highlight(text, lang) {
    var re = GRAMMARS[lang];
    if (!re) return esc(text);
    var classes = lang === "json" ? JSON_CLASSES : CLASSES;
    var out = "";
    var last = 0;
    re.lastIndex = 0;
    var m;
    while ((m = re.exec(text))) {
      if (m[0] === "") { re.lastIndex++; continue; }
      out += esc(text.slice(last, m.index));
      var cls = "";
      for (var g = 1; g <= 5; g++) if (m[g] !== undefined && m[g] !== "") { cls = classes[g - 1]; break; }
      out += cls ? '<span class="' + cls + '">' + esc(m[0]) + "</span>" : esc(m[0]);
      last = m.index + m[0].length;
    }
    return out + esc(text.slice(last));
  }

  function setupCode(root) {
    (root || document).querySelectorAll("pre[data-lang]:not([data-done])").forEach(function (pre) {
      pre.setAttribute("data-done", "");
      var code = pre.querySelector("code") || pre;
      var text = code.textContent.replace(/^\n/, "").replace(/\s+$/, "");
      code.innerHTML = highlight(text, pre.getAttribute("data-lang"));
      var fig = pre.closest(".code");
      if (!fig || fig.classList.contains("output")) return;
      var head = fig.querySelector(".code-head");
      if (!head) {
        head = document.createElement("div");
        head.className = "code-head";
        head.innerHTML = "<span>" + ({ python: "Python", bash: "Shell", json: "JSON" }[pre.getAttribute("data-lang")] || "") + "</span>";
        fig.insertBefore(head, pre);
      }
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "code-copy";
      btn.textContent = "Copy";
      btn.addEventListener("click", function () {
        var done = function () {
          btn.textContent = "Copied";
          setTimeout(function () { btn.textContent = "Copy"; }, 1400);
        };
        if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, function () {});
      });
      head.appendChild(btn);
    });
  }

  // --------------------------------------------------------------- ranges
  function setupRanges(root) {
    (root || document).querySelectorAll('input[type="range"]').forEach(function (r) {
      var paint = function () {
        var min = Number(r.min || 0), max = Number(r.max || 100);
        r.style.setProperty("--fill", ((Number(r.value) - min) / (max - min)) * 100 + "%");
      };
      paint();
      r.addEventListener("input", paint);
    });
  }

  // ------------------------------------------------------------------ toc
  function setupToc() {
    var links = Array.prototype.slice.call(document.querySelectorAll('.doc-toc a[href^="#"]'));
    if (!links.length || !("IntersectionObserver" in window)) return;
    var byId = {};
    links.forEach(function (a) { byId[decodeURIComponent(a.getAttribute("href").slice(1))] = a; });
    var visible = new Set();
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) visible.add(en.target.id);
        else visible.delete(en.target.id);
      });
      var first = null;
      links.forEach(function (a) {
        var id = decodeURIComponent(a.getAttribute("href").slice(1));
        if (!first && visible.has(id)) first = a;
      });
      if (first) {
        links.forEach(function (a) { a.classList.toggle("is-active", a === first); });
        if (first.scrollIntoView && first.closest(".doc-toc").scrollHeight > first.closest(".doc-toc").clientHeight) {
          first.scrollIntoView({ block: "nearest" });
        }
      }
    }, { rootMargin: "-56px 0px -55% 0px" });
    Object.keys(byId).forEach(function (id) {
      var el = document.getElementById(id);
      if (el) io.observe(el);
    });
  }

  window.Site = { esc: esc, highlight: highlight, setupCode: setupCode, setupRanges: setupRanges, setupToc: setupToc, setupReveal: setupReveal, REPO: REPO, BRAIN: BRAIN };
})();
