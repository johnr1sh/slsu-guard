// GUARD++ shared configuration.
// Loaded by the service worker (importScripts), the content script, and extension pages.
//
// IMPORTANT: Chrome needs host permission for every blocked domain. After editing
// `blockedSites` run:   node tools/sync-manifest.js
// so manifest.json host_permissions stay in sync with this file.

const GUARD_CONFIG = Object.freeze({
  version: "1.0.0.4",

  // The only site GUARD++ activates on. Works for ANY quiz on this LMS.
  lmsOrigin: "https://lms.southernleytestateu.edu.ph",

  // Moodle page types (matched by path suffix, so a /moodle/ sub-path install also works).
  paths: {
    attempt: "/mod/quiz/attempt.php",
    summary: "/mod/quiz/summary.php",
    review: "/mod/quiz/review.php",
    view: "/mod/quiz/view.php"
  },

  strikeThreshold: 3,          // restricted-site attempts before the session is flagged for review
  maxEventsPerSession: 1500,   // noisy events are trimmed first; key events are always kept
  maxSessionsStored: 30,       // oldest finished sessions are dropped (export before this happens)
  inactivityMinutes: 60,       // release protection if the quiz tab sends no heartbeat for this long
  maxSessionHours: 8,          // absolute safety cap so blocking can never get stuck on

  // Test mode shows manual Start/Stop buttons in the popup. KEEP FALSE for real exams:
  // otherwise any student could press Stop.
  testMode: false,

  showBanner: true,            // quiet, always-visible "protection active" label on the quiz page (no popups)
  uninstallUrl: "",            // optional: page opened when the extension is removed (e.g. a logging endpoint)

  // Administrator PIN that unlocks "Clear history" / "Delete session" in the report page.
  // Leave empty to disable deleting altogether (outside testMode). Set it with:
  //   node tools/set-admin-pin.js <PIN>
  adminPin: { salt: "", hash: "", iterations: 210000 },

  // Behaviour on the quiz attempt page while a session is active.
  enforcement: {
    blockCopyCut: true,
    blockPaste: true,            // also covers context-menu paste, middle-click paste, drag-and-drop
    blockDrop: true,
    blockContextMenu: true,      // right-click menu
    blockTextSelection: true,    // question text cannot be highlighted (answer fields still work)
    blockShortcuts: true,        // F12, Ctrl+Shift+I/J/C, Ctrl+U, Ctrl+P, Ctrl+S
    largeInsertionThreshold: 80  // log (not block) any single input that adds this many characters
  },

  // Path/query rules for AI features that live on otherwise-normal sites (best effort).
  // These are blocked outright by the browser (no page, no alert).
  blockedPaths: [
    { category: "AI search modes", enabled: true, domain: "google.com", query: { udm: "50" }, urlFilter: "udm=50" },
    { category: "AI search modes", enabled: true, domain: "bing.com", pathStartsWith: "/chat", urlFilter: "||bing.com/chat" },
    { category: "AI search modes", enabled: true, domain: "bing.com", pathStartsWith: "/copilotsearch", urlFilter: "||bing.com/copilotsearch" }
  ],

  // Sites blocked while a session is active. The page itself is redirected to the "Access denied"
  // screen; every background request (API calls, websockets, embeds) is blocked outright.
  blockedSites: [
    {
      category: "AI assistants",
      enabled: true,
      domains: [
        "chatgpt.com", "chat.openai.com", "openai.com",
        "gemini.google.com", "aistudio.google.com", "notebooklm.google.com", "bard.google.com",
        "claude.ai",
        "copilot.microsoft.com",
        "perplexity.ai",
        "chat.deepseek.com", "deepseek.com",
        "grok.com", "x.ai",
        "meta.ai",
        "poe.com",
        "you.com",
        "chat.mistral.ai",
        "character.ai",
        "phind.com",
        "blackbox.ai",
        "chat.qwen.ai",
        "kimi.com"
      ]
    },
    {
      category: "Answer & homework-help sites",
      enabled: true,
      domains: [
        "chegg.com", "coursehero.com", "brainly.com", "studocu.com", "quizlet.com",
        "bartleby.com", "studypool.com", "numerade.com", "gauthmath.com", "socratic.org"
      ]
    },
    {
      // Off by default: legitimate for many courses. Enable per exam policy.
      category: "Math & homework solvers",
      enabled: false,
      domains: ["wolframalpha.com", "symbolab.com", "mathway.com", "photomath.com"]
    },
    {
      category: "Translators & paraphrasers",
      enabled: false,
      domains: ["translate.google.com", "deepl.com", "quillbot.com"]
    }
  ]
});
