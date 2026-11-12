(() => {
  if (window.__guardPlusLoaded) return;
  window.__guardPlusLoaded = true;
  if (window !== window.top) return;   // same-origin editor iframes are bound from the top frame below

  let showBanner = true;
  let enforce = false;                 // true only while the background says this exact attempt is protected
  let rules = GUARD_CONFIG.enforcement;
  const lastSent = new Map();
  const fieldLength = new WeakMap();
  const lastChange = new WeakMap();

  /* ---------- messaging ---------- */

  function send(eventType, details = {}, throttleMs = 0) {
    if (throttleMs) {
      const now = Date.now();
      if (now - (lastSent.get(eventType) || 0) < throttleMs) return;
      lastSent.set(eventType, now);
    }
    try {
      const p = chrome.runtime.sendMessage({ type: "CONTENT_EVENT", eventType, details });
      if (p && p.catch) p.catch(() => {});
    } catch (_) { /* extension reloaded */ }
  }

  async function hello() {
    try {
      const r = await chrome.runtime.sendMessage({ type: "CONTENT_HELLO", title: document.title });
      enforce = !!r?.enforce;
      if (r?.rules) rules = r.rules;
      if (typeof r?.showBanner === "boolean") showBanner = r.showBanner;
    } catch (_) { enforce = false; }
    applyMode();
  }

  /* ---------- visible feedback (shadow DOM so Moodle CSS cannot touch it) ---------- */

  function shadowHost(id, css, html) {
    let host = document.getElementById(id);
    if (host) return host;
    host = document.createElement("div");
    host.id = id;
    host.style.cssText = "all:initial;position:fixed;z-index:2147483647;pointer-events:none;" + css;
    host.attachShadow({ mode: "open" }).innerHTML = html;
    document.documentElement.appendChild(host);
    return host;
  }

  const FONT = "font:600 12px/1.45 system-ui,Segoe UI,Arial,sans-serif;";

  function banner(on) {
    const existing = document.getElementById("guardplus-banner");
    if (!on) { existing?.remove(); return; }
    if (existing) return;
    shadowHost("guardplus-banner", "left:12px;bottom:12px;",
      `<style>.b{${FONT}background:#fff;color:#102b57;border:1px solid #cbd6e2;border-left:4px solid #102b57;
        padding:8px 12px;border-radius:6px;box-shadow:0 4px 14px rgba(16,43,87,.18);max-width:320px}
        .b small{display:block;font-weight:400;color:#526174;font-size:11px}</style>
        <div class="b">GUARD++ exam protection is active
        <small>AI and answer sites are blocked, copy/paste is disabled, and activity is recorded for instructor review.</small></div>`);
  }

  // Pure block: the action is simply prevented and recorded. No popup, no message.
  function report(type, details) {
    send(type, details, 750);
  }

  /* ---------- protection style (selection off, answer fields still usable) ---------- */

  const STYLE_ID = "guardplus-style";
  const STYLE_CSS = `
    html.guardplus-on body, html.guardplus-on body * { -webkit-user-select:none !important; user-select:none !important; }
    html.guardplus-on input, html.guardplus-on textarea,
    html.guardplus-on [contenteditable=""], html.guardplus-on [contenteditable="true"],
    html.guardplus-on [contenteditable=""] *, html.guardplus-on [contenteditable="true"] * {
      -webkit-user-select:text !important; user-select:text !important; }`;

  function syncStyle(doc) {
    try {
      const root = doc.documentElement;
      if (!root) return;
      const want = enforce && rules.blockTextSelection;
      root.classList.toggle("guardplus-on", want);
      const el = doc.getElementById(STYLE_ID);
      if (want && !el) {
        const s = doc.createElement("style");
        s.id = STYLE_ID;
        s.textContent = STYLE_CSS;
        (doc.head || root).appendChild(s);
      } else if (!want && el) {
        el.remove();
      }
    } catch (_) {}
  }

  /* ---------- helpers ---------- */

  const isEditable = el => !!el && (el.isContentEditable || el.tagName === "TEXTAREA" ||
    (el.tagName === "INPUT" && !/^(button|submit|checkbox|radio|reset|image|file|hidden)$/i.test(el.type || "")));
  const textLength = el => ("value" in el && typeof el.value === "string") ? el.value.length : (el.textContent || "").length;
  const stop = e => { e.preventDefault(); e.stopImmediatePropagation(); };

  /* ---------- per-document handlers (top document + same-origin editor iframes) ---------- */

  function onKey(e) {
    if (!enforce || !rules.blockShortcuts) return;
    const mod = e.ctrlKey || e.metaKey;
    const devtoolsKey = ["KeyI", "KeyJ", "KeyC"].includes(e.code);
    let label = null;
    if (e.key === "F12") label = "Developer tools";
    else if (mod && e.shiftKey && devtoolsKey) label = "Developer tools";
    else if (e.metaKey && e.altKey && devtoolsKey) label = "Developer tools";
    else if (mod && e.code === "KeyU") label = "View source";
    else if (mod && e.code === "KeyP") label = "Print";
    else if (mod && e.code === "KeyS") label = "Save page";
    if (!label) return;
    stop(e);
    report("SHORTCUT_BLOCKED", { shortcut: label });
  }

  function onInput(e) {
    if (!enforce) return;
    const el = e.target;
    if (!isEditable(el)) return;
    const len = textLength(el);
    const prev = fieldLength.has(el) ? fieldLength.get(el) : len;
    fieldLength.set(el, len);
    // Text appearing in bulk without a paste event (autofill, other extensions, typing simulators). Logged only.
    if (len - prev >= rules.largeInsertionThreshold) send("LARGE_TEXT_INSERTION", { characters: len - prev });
    const now = Date.now();
    if (now - (lastChange.get(el) || 0) >= 1500) {
      lastChange.set(el, now);
      send("ANSWER_FIELD_CHANGED", { element: (el.tagName || "").toLowerCase(), inputType: el.type || "" });
    }
  }

  function bindDoc(doc) {
    try {
      const root = doc.documentElement;
      if (!root || root.__guardBound) return;   // a rewritten document has a new root, so it is re-bound
      root.__guardBound = true;
      const target = doc.defaultView || doc;   // window-level capture runs before any document-level handler
      const on = (type, fn) => target.addEventListener(type, fn, true);

      on("copy", e => {
        if (!enforce || !rules.blockCopyCut) return;
        stop(e);
        report("COPY_BLOCKED", {});
      });
      on("cut", e => {
        if (!enforce || !rules.blockCopyCut) return;
        stop(e);
        report("CUT_BLOCKED", {});
      });
      on("paste", e => {
        if (!enforce || !rules.blockPaste) return;
        let n = 0;
        try { n = (e.clipboardData?.getData("text") || "").length; } catch (_) {}   // length only, never stored
        stop(e);
        report("PASTE_BLOCKED", { characterCount: n, largePaste: n >= 500 });
      });
      on("beforeinput", e => {
        // Catches paste/drop that bypass the paste event (context menu, middle-click, drag text).
        if (!enforce || !rules.blockPaste) return;
        if (/^insertFrom(Paste|Drop|Yank)/.test(e.inputType || "")) {
          stop(e);
          report("PASTE_BLOCKED", { via: e.inputType });
        }
      });
      on("drop", e => {
        if (!enforce || !rules.blockDrop) return;
        stop(e);
        report("DROP_BLOCKED", {});
      });
      on("dragstart", e => { if (enforce && rules.blockTextSelection) e.preventDefault(); });
      on("contextmenu", e => {
        if (!enforce || !rules.blockContextMenu) return;
        stop(e);
        report("CONTEXT_MENU_BLOCKED", {});
      });
      on("keydown", onKey);
      on("input", onInput);
      on("focusin", e => { if (isEditable(e.target)) fieldLength.set(e.target, textLength(e.target)); });
      on("beforeprint", () => { if (enforce) send("PRINT_ATTEMPT", {}, 1000); });
      syncStyle(doc);
    } catch (_) {}
  }

  // Text that appears in a field without any input event (scripts, userscripts, other extensions).
  function checkFields(doc) {
    try {
      doc.querySelectorAll("textarea, input[type=text], [contenteditable=''], [contenteditable='true']").forEach(el => {
        if (!isEditable(el)) return;
        const len = textLength(el);
        if (!fieldLength.has(el)) { fieldLength.set(el, len); return; }
        const delta = len - fieldLength.get(el);
        fieldLength.set(el, len);
        if (delta >= rules.largeInsertionThreshold) send("PROGRAMMATIC_TEXT_CHANGE", { characters: delta }, 2000);
      });
    } catch (_) {}
  }

  let flagged = false;
  function oneTimeChecks() {
    if (!enforce || flagged) return;
    flagged = true;
    try { if (navigator.webdriver) send("AUTOMATION_FLAG", {}); } catch (_) {}
    try { if (window.screen && window.screen.isExtended) send("MULTIPLE_DISPLAYS", {}); } catch (_) {}
  }

  function scanDocuments() {
    bindDoc(document);
    syncStyle(document);
    if (enforce) checkFields(document);
    // Essay editors (TinyMCE) live in same-origin iframes whose documents are rewritten after load.
    document.querySelectorAll("iframe").forEach(frame => {
      try {
        const doc = frame.contentDocument;
        if (doc) { bindDoc(doc); syncStyle(doc); if (enforce) checkFields(doc); }
      } catch (_) { /* cross-origin frame: cannot be inspected */ }
    });
  }

  function applyMode() {
    scanDocuments();
    banner(enforce && showBanner);
    oneTimeChecks();
  }

  /* ---------- attention indicators (top window only) ---------- */

  let lost = false;
  document.addEventListener("visibilitychange", () => {
    if (!enforce) return;
    send(document.visibilityState === "hidden" ? "QUIZ_PAGE_HIDDEN" : "QUIZ_PAGE_VISIBLE");
  });
  window.addEventListener("blur", () => {
    // Clicking into the essay editor iframe also fires blur; hasFocus() stays true in that case.
    setTimeout(() => {
      if (enforce && !lost && !document.hasFocus()) { lost = true; send("WINDOW_FOCUS_LOST"); }
    }, 100);
  });
  window.addEventListener("focus", () => {
    if (enforce && lost) { lost = false; send("WINDOW_FOCUS_RETURNED"); }
  });

  /* ---------- start-up ---------- */

  hello();
  setTimeout(hello, 1500);     // covers the rare case where the session starts just after this script
  setTimeout(hello, 5000);
  setInterval(scanDocuments, 1500);
  setInterval(() => {
    if (!enforce) return;
    try {
      const p = chrome.runtime.sendMessage({ type: "CONTENT_HEARTBEAT" });
      if (p && p.catch) p.catch(() => {});
    } catch (_) {}
  }, 30000);

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.guardState) hello();
    });
  } catch (_) {}
})();
