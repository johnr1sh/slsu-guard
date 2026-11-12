importScripts("config.js");

const C = GUARD_CONFIG;
const RULE_REDIRECT_ID = 77001;   // main-frame navigations -> "Access denied" page
const RULE_BLOCK_ID = 77002;      // everything else from the same sites is blocked outright
const RULE_PATH_BASE = 77010;     // path/query rules (AI search modes)
const RULE_ID_MAX = 77099;
const GAP_SECONDS = 150;          // monitoring gap longer than this is logged
const WATCHDOG_ALARM = "guardplus-watchdog";

// Events that are never trimmed when a session hits the event cap.
const CRITICAL_EVENTS = new Set([
  "SESSION_STARTED", "SESSION_RESUMED", "SESSION_ENDED",
  "RESTRICTED_SITE_BLOCKED", "RESTRICTED_TAB_FOUND_AT_START", "REVIEW_THRESHOLD_REACHED",
  "QUIZ_TAB_CLOSED", "NAVIGATED_AWAY_FROM_ATTEMPT", "MONITORING_GAP", "RULES_RESTORED"
]);

// Event types a content script may report.
const CONTENT_EVENT_TYPES = new Set([
  "QUIZ_PAGE_HIDDEN", "QUIZ_PAGE_VISIBLE", "WINDOW_FOCUS_LOST", "WINDOW_FOCUS_RETURNED",
  "COPY_BLOCKED", "CUT_BLOCKED", "PASTE_BLOCKED", "DROP_BLOCKED", "CONTEXT_MENU_BLOCKED",
  "SHORTCUT_BLOCKED", "PRINT_ATTEMPT", "LARGE_TEXT_INSERTION", "PROGRAMMATIC_TEXT_CHANGE",
  "ANSWER_FIELD_CHANGED", "AUTOMATION_FLAG", "MULTIPLE_DISPLAYS"
]);

const defaultState = {
  active: false,
  manual: false,
  sessionId: null,
  startedAt: null,
  cmid: null,
  attemptId: null,
  quizTabId: null,
  resumeUrl: null,
  lastQuizActivityAt: null,
  violationCount: 0,
  reviewRequired: false,
  lastBlocked: null,
  aliveAt: null,
  pinFailures: 0,
  pinLockUntil: 0
};

/* ---------- URL helpers ---------- */

const parseUrl = raw => { try { return new URL(raw); } catch { return null; } };
const isDigits = v => typeof v === "string" && /^\d{1,12}$/.test(v);
const iso = () => new Date().toISOString();

// Classify an LMS URL. Works for any quiz; ids come from the URL itself.
function classify(raw) {
  const u = parseUrl(raw);
  if (!u || u.origin !== C.lmsOrigin) return null;
  const p = u.pathname;
  const q = u.searchParams;
  if (p.endsWith(C.paths.attempt) || p.endsWith(C.paths.summary)) {
    return { kind: "attempt", attemptId: q.get("attempt"), cmid: q.get("cmid") };
  }
  if (p.endsWith(C.paths.review)) return { kind: "review", attemptId: q.get("attempt"), cmid: q.get("cmid") };
  if (p.endsWith(C.paths.view)) return { kind: "view", cmid: q.get("id"), attemptId: null };
  return { kind: "other", path: p, cmid: null, attemptId: null };
}

// Only the origin and path are ever stored; query strings can hold session data.
function cleanUrl(raw) {
  const u = parseUrl(raw);
  return u ? `${u.origin}${u.pathname}` : "Unknown page";
}

function buildResumeUrl(cmid, attemptId) {
  if (isDigits(attemptId) && isDigits(cmid)) return `${C.lmsOrigin}${C.paths.attempt}?attempt=${attemptId}&cmid=${cmid}`;
  if (isDigits(cmid)) return `${C.lmsOrigin}${C.paths.view}?id=${cmid}`;
  return C.lmsOrigin + "/";
}

/* ---------- Restricted-site helpers ---------- */

const enabledGroups = () => C.blockedSites.filter(g => g.enabled);
const enabledDomains = () => [...new Set(enabledGroups().flatMap(g => g.domains))];
const enabledPathRules = () => (C.blockedPaths || []).filter(r => r.enabled);

function restrictedInfo(raw) {
  const u = parseUrl(raw);
  if (!u || u.protocol !== "https:") return null;
  for (const group of enabledGroups()) {
    for (const d of group.domains) {
      if (u.hostname === d || u.hostname.endsWith("." + d)) {
        return { host: u.hostname, domain: d, category: group.category };
      }
    }
  }
  for (const r of enabledPathRules()) {
    if (u.hostname !== r.domain && !u.hostname.endsWith("." + r.domain)) continue;
    const queryOk = r.query && Object.entries(r.query).every(([k, v]) => u.searchParams.get(k) === v);
    const pathOk = r.pathStartsWith && u.pathname.startsWith(r.pathStartsWith);
    if (queryOk || pathOk) return { host: u.hostname, domain: r.domain, category: r.category };
  }
  return null;
}

// Everything except the top-level page is blocked outright (no page, no prompt).
const SUBRESOURCE_TYPES = ["sub_frame", "stylesheet", "script", "image", "font", "object",
  "xmlhttprequest", "ping", "media", "websocket", "other"];

async function setBlocking(enabled) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.filter(r => r.id >= RULE_REDIRECT_ID && r.id <= RULE_ID_MAX).map(r => r.id);
  const domains = enabledDomains();
  const addRules = [];
  if (enabled && domains.length) {
    addRules.push({
      id: RULE_REDIRECT_ID, priority: 2,
      action: { type: "redirect", redirect: { extensionPath: "/blocked.html" } },
      condition: { requestDomains: domains, resourceTypes: ["main_frame"] }
    });
    addRules.push({
      id: RULE_BLOCK_ID, priority: 1,
      action: { type: "block" },
      condition: { requestDomains: domains, resourceTypes: SUBRESOURCE_TYPES }
    });
  }
  if (enabled) {
    enabledPathRules().forEach((r, i) => addRules.push({
      id: RULE_PATH_BASE + i, priority: 3,
      action: { type: "block" },
      condition: { urlFilter: r.urlFilter, requestDomains: [r.domain], resourceTypes: ["main_frame", "sub_frame"] }
    }));
  }
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
}

// Rules are re-checked every minute: if they vanish during an exam they are put back.
async function ensureBlockingIntact() {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const want = 2 * (enabledDomains().length ? 1 : 0) + enabledPathRules().length;
  const have = existing.filter(r => r.id >= RULE_REDIRECT_ID && r.id <= RULE_ID_MAX).length;
  if (have === want) return false;
  await setBlocking(true);
  return true;
}

/* ---------- Serialized storage ----------
   Every read-modify-write goes through one promise queue so concurrent events
   (blur + visibilitychange, two navigation listeners, ...) can never overwrite each other. */

let queue = Promise.resolve();

async function load() {
  const d = await chrome.storage.local.get(["guardState", "guardSessions"]);
  return { state: { ...defaultState, ...(d.guardState || {}) }, sessions: d.guardSessions || [], dirty: false };
}

async function persist(data) {
  const items = { guardState: data.state };
  if (data.dirty) items.guardSessions = data.sessions;   // skip the big write for state-only changes
  await chrome.storage.local.set(items);
}

function mutate(fn) {
  const run = queue.then(async () => {
    const data = await load();
    const result = await fn(data);
    await persist(data);
    return result;
  });
  queue = run.catch(() => {});
  return run;
}

function snapshot() {
  const run = queue.then(load);
  queue = run.catch(() => {});
  return run;
}

/* ---------- Session model ---------- */

const currentSession = data => data.sessions.find(s => s.id === data.state.sessionId) || null;

function trimEvents(events) {
  while (events.length > C.maxEventsPerSession) {
    const i = events.findIndex(e => !CRITICAL_EVENTS.has(e.type));
    events.splice(i >= 0 ? i : 1, 1);
  }
}

function pushEvent(data, session, type, details = {}) {
  const now = iso();
  session.events.push({ id: crypto.randomUUID(), type, timestamp: now, details });
  session.lastActivityAt = now;
  trimEvents(session.events);
  data.dirty = true;
}

function beginSession(data, page, url, tabId, reason) {
  const now = iso();
  // Reopening the same attempt keeps its strikes: closing the quiz tab must not reset the counter.
  const prior = page.attemptId ? data.sessions.find(s => s.attemptId === page.attemptId) : null;
  const session = {
    id: crypto.randomUUID(),
    startedAt: now,
    endedAt: null,
    endReason: null,
    lastActivityAt: now,
    cmid: page.cmid || null,
    attemptId: page.attemptId || null,
    quizTitle: null,
    sourcePage: cleanUrl(url),
    violationCount: prior?.violationCount || 0,
    reviewRequired: prior?.reviewRequired || false,
    resumedFrom: prior?.id || null,
    events: [{ id: crypto.randomUUID(), type: "SESSION_STARTED", timestamp: now, details: { reason, cmid: page.cmid, attemptId: page.attemptId } }]
  };
  if (prior) {
    session.events.push({
      id: crypto.randomUUID(), type: "SESSION_RESUMED", timestamp: now,
      details: { note: "Attempt reopened; previous restricted-attempt count was carried over." }
    });
  }
  Object.assign(data.state, {
    active: true,
    manual: false,
    sessionId: session.id,
    startedAt: now,
    cmid: page.cmid || null,
    attemptId: page.attemptId || null,
    quizTabId: tabId ?? null,
    resumeUrl: buildResumeUrl(page.cmid, page.attemptId),
    lastQuizActivityAt: Date.now(),
    aliveAt: Date.now(),
    violationCount: session.violationCount,
    reviewRequired: session.reviewRequired,
    lastBlocked: null
  });
  data.sessions.unshift(session);
  data.dirty = true;
  return session;
}

function endInPlace(data, reason) {
  const session = currentSession(data);
  if (session) {
    session.endedAt = iso();
    session.endReason = reason;
    pushEvent(data, session, "SESSION_ENDED", { reason });
  }
  Object.assign(data.state, {
    active: false, manual: false, sessionId: null, startedAt: null, cmid: null, attemptId: null,
    quizTabId: null, resumeUrl: null, lastQuizActivityAt: null, aliveAt: null, violationCount: 0,
    reviewRequired: false, lastBlocked: null
  });
  // Keep storage bounded: drop the oldest finished sessions.
  while (data.sessions.length > C.maxSessionsStored) {
    let i = -1;
    for (let k = data.sessions.length - 1; k >= 0; k--) if (data.sessions[k].endedAt) { i = k; break; }
    if (i < 0) break;
    data.sessions.splice(i, 1);
  }
  data.dirty = true;
}

function logEvent(type, details = {}, opts = {}) {
  return mutate(data => {
    const { state } = data;
    if (!state.active) return null;
    const session = currentSession(data);
    if (!session) return null;
    pushEvent(data, session, type, details);
    let crossed = false;
    if (opts.strike) {
      state.violationCount += 1;
      session.violationCount = state.violationCount;
      if (!state.reviewRequired && state.violationCount >= C.strikeThreshold) {
        state.reviewRequired = true;
        session.reviewRequired = true;
        crossed = true;
        pushEvent(data, session, "REVIEW_THRESHOLD_REACHED", {
          note: `${C.strikeThreshold} or more restricted-site attempts. Instructor review is recommended; this is not an automatic finding of misconduct.`
        });
      }
    }
    if (opts.blocked) state.lastBlocked = { ...opts.blocked, at: iso(), count: state.violationCount };
    return { count: state.violationCount, crossed, reviewRequired: state.reviewRequired };
  });
}

/* ---------- Lifecycle ---------- */

async function sweepOpenTabs() {
  // Already-open AI tabs keep working after the rule is added, so move them to the warning page.
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    const info = tab.url ? restrictedInfo(tab.url) : null;
    if (!info) continue;
    await logEvent("RESTRICTED_TAB_FOUND_AT_START", { domain: info.host, category: info.category },
      { blocked: { domain: info.host, category: info.category } });
    try { await chrome.tabs.update(tab.id, { url: chrome.runtime.getURL("blocked.html") }); } catch (_) {}
  }
}

async function afterStart() {
  await setBlocking(true);
  await sweepOpenTabs();
}

async function endSession(reason, { expectAttemptId = null } = {}) {
  const ended = await mutate(data => {
    const { state } = data;
    if (!state.active) return false;
    if (expectAttemptId && state.attemptId !== expectAttemptId) return false;
    endInPlace(data, reason);
    return true;
  });
  if (ended) await setBlocking(false);
  return ended;
}

// The review page is only trusted for the attempt we are protecting: opening someone
// else's (or an old) review page must not switch protection off.
async function onReviewPage(page) {
  await endSession("Review page for this attempt detected; the attempt is submitted.", {
    expectAttemptId: page.attemptId
  });
}

// Moodle sends students to view.php (not review.php) after submitting when review is disabled.
// Ask the LMS whether the attempt is really finished before releasing protection.
async function attemptIsFinished(cmid, attemptId) {
  if (!isDigits(cmid) || !isDigits(attemptId)) return null;
  try {
    const res = await fetch(`${C.lmsOrigin}${C.paths.review}?attempt=${attemptId}&cmid=${cmid}`,
      { credentials: "include", cache: "no-store", redirect: "follow" });
    const u = parseUrl(res.url);
    if (!u || u.origin !== C.lmsOrigin) return null;
    if (u.pathname.endsWith(C.paths.review)) return res.ok ? true : null;
    if (u.pathname.endsWith(C.paths.view)) return true;          // finished, review not allowed
    if (u.pathname.endsWith(C.paths.attempt) || u.pathname.endsWith(C.paths.summary)) return false; // still in progress
    return null;                                                  // login page / unknown: stay protected
  } catch {
    return null;
  }
}

async function onViewPage(page) {
  const { state } = await snapshot();
  if (!state.active || state.manual || state.cmid !== page.cmid) return;
  const finished = await attemptIsFinished(state.cmid, state.attemptId);
  if (finished === true) {
    await endSession("Quiz page reopened after the attempt was finished.", {
      expectAttemptId: state.attemptId
    });
  } else {
    await logEvent("NAVIGATED_AWAY_FROM_ATTEMPT", { to: "quiz-info-page" });
  }
}

async function onAttemptPage(url, page, tabId) {
  if (!isDigits(page.attemptId)) return;
  const out = await mutate(data => {
    const { state } = data;
    if (state.active && state.attemptId === page.attemptId) {
      state.quizTabId = tabId;
      state.lastQuizActivityAt = Date.now();     // state-only change: no big write
      return { started: false };
    }
    if (state.active) endInPlace(data, "Another quiz attempt was opened.");
    beginSession(data, page, url, tabId, "Quiz attempt page detected.");
    return { started: true };
  });
  if (out.started) await afterStart();
}

async function onOtherLmsPage(page) {
  const { state } = await snapshot();
  if (!state.active || page.path.includes("/mod/quiz/")) return;
  await logEvent("OTHER_LMS_PAGE_OPENED", { page: page.path });
}

async function handleLmsNavigation(url, tabId) {
  const page = classify(url);
  if (!page) return;
  if (page.kind === "attempt") return onAttemptPage(url, page, tabId);
  if (page.kind === "review") return onReviewPage(page);
  if (page.kind === "view") return onViewPage(page);
  return onOtherLmsPage(page);
}

async function onRestrictedNavigation(info) {
  // Pure block: the page is already blocked. The attempt is only recorded, silently.
  await logEvent(
    "RESTRICTED_SITE_BLOCKED",
    { domain: info.host, category: info.category },
    { strike: true, blocked: { domain: info.host, category: info.category } }
  );
}

/* ---------- Browser listeners ---------- */

// The original URL is only visible *before* the redirect, so strikes are counted here.
const recentBlocks = new Map();
chrome.webNavigation.onBeforeNavigate.addListener(details => {
  if (details.frameId !== 0) return;
  const info = restrictedInfo(details.url);
  if (!info) return;
  const key = `${details.tabId}:${info.domain}`;
  const now = Date.now();
  if (now - (recentBlocks.get(key) || 0) < 2500) return;   // one navigation = one strike
  recentBlocks.set(key, now);
  onRestrictedNavigation(info).catch(console.error);
});

chrome.webNavigation.onCommitted.addListener(details => {
  if (details.frameId !== 0) return;
  handleLmsNavigation(details.url, details.tabId).catch(console.error);
});

chrome.tabs.onRemoved.addListener(async tabId => {
  const { state } = await snapshot();
  if (state.active && state.quizTabId === tabId) {
    await logEvent("QUIZ_TAB_CLOSED", {});
    await mutate(data => { data.state.quizTabId = null; });
  }
});

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== WATCHDOG_ALARM) return;
  const { state } = await snapshot();
  const now = Date.now();
  if (!state.active) {
    await mutate(data => { data.state.aliveAt = now; });
    return;
  }
  // Tamper evidence: if monitoring was interrupted (extension disabled, browser closed), say so.
  const gap = state.aliveAt ? (now - state.aliveAt) / 1000 : 0;
  if (gap > GAP_SECONDS) await logEvent("MONITORING_GAP", { minutes: Math.round(gap / 6) / 10 });
  if (await ensureBlockingIntact()) await logEvent("RULES_RESTORED", {});
  await mutate(data => { data.state.aliveAt = now; });

  const idleMin = (now - (state.lastQuizActivityAt || now)) / 60000;
  const ageHr = (now - Date.parse(state.startedAt)) / 3600000;
  if (idleMin > C.inactivityMinutes) {
    await endSession(`No quiz-page activity for ${C.inactivityMinutes} minutes; protection released.`);
  } else if (ageHr > C.maxSessionHours) {
    await endSession(`Maximum session length (${C.maxSessionHours} h) reached; protection released.`);
  }
});

async function resync() {
  const { state } = await snapshot();
  await setBlocking(state.active);
  chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 1 });
  if (C.uninstallUrl) { try { chrome.runtime.setUninstallURL(C.uninstallUrl); } catch (_) {} }
}
chrome.runtime.onStartup.addListener(() => resync().catch(console.error));
chrome.runtime.onInstalled.addListener(() => resync().catch(console.error));

/* ---------- Messages ---------- */

function cleanDetails(details) {
  const out = {};
  if (!details || typeof details !== "object") return out;
  for (const [k, v] of Object.entries(details).slice(0, 8)) {
    if (typeof v === "string") out[k] = v.slice(0, 80);
    else if (typeof v === "number" || typeof v === "boolean") out[k] = v;
  }
  return out;
}

const isExtensionPage = sender => !!sender.url && sender.url.startsWith(chrome.runtime.getURL(""));

/* ---------- Administrator PIN (protects deleting history) ---------- */

const hexToBytes = hex => new Uint8Array(hex.match(/../g).map(h => parseInt(h, 16)));
const bytesToHex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");

async function pinMatches(pin) {
  const cfg = C.adminPin;
  if (!cfg?.hash || !cfg?.salt || typeof pin !== "string" || !pin) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: hexToBytes(cfg.salt), iterations: cfg.iterations || 210000 }, key, 256);
  const got = bytesToHex(bits);
  let diff = got.length ^ cfg.hash.length;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ (cfg.hash.charCodeAt(i) || 0);
  return diff === 0;
}

// Returns null when allowed, otherwise an error message.
async function authorizeDestructive(pin) {
  if (C.testMode) return null;
  if (!C.adminPin?.hash) return "Deleting history is disabled. An administrator must set a PIN (tools/set-admin-pin.js).";
  const { state } = await snapshot();
  if (Date.now() < state.pinLockUntil) return "Too many wrong PIN attempts. Try again in a few minutes.";
  const ok = await pinMatches(pin);
  await mutate(data => {
    if (ok) { data.state.pinFailures = 0; return; }
    data.state.pinFailures += 1;
    if (data.state.pinFailures >= 5) { data.state.pinFailures = 0; data.state.pinLockUntil = Date.now() + 5 * 60000; }
  });
  return ok ? null : "Incorrect administrator PIN.";
}

function statusPayload(state, sessions) {
  const current = sessions.find(s => s.id === state.sessionId) || null;
  return {
    ok: true,
    state: {
      active: state.active, manual: state.manual, violationCount: state.violationCount,
      reviewRequired: state.reviewRequired, lastBlocked: state.lastBlocked,
      resumeUrl: state.resumeUrl, cmid: state.cmid
    },
    current: current ? { eventCount: current.events.length, quizTitle: current.quizTitle, startedAt: current.startedAt } : null,
    threshold: C.strikeThreshold,
    testMode: C.testMode,
    pinRequired: !C.testMode,
    categories: enabledGroups().map(g => g.category),
    enforcement: C.enforcement
  };
}

async function handleMessage(message, sender) {
  if (sender.id !== chrome.runtime.id) return { ok: false };
  const type = message?.type;

  // ----- from the LMS content script -----
  if (type === "CONTENT_HELLO" || type === "CONTENT_EVENT" || type === "CONTENT_HEARTBEAT") {
    if (sender.frameId !== 0) return { ok: false };
    const page = classify(sender.tab?.url);
    if (!page) return { ok: false };
    const { state } = await snapshot();
    const onProtectedPage = state.active && state.cmid === page.cmid &&
      ((page.kind === "attempt" && page.attemptId === state.attemptId) || (state.manual && page.kind === "view"));

    if (type === "CONTENT_HELLO") {
      if (onProtectedPage && typeof message.title === "string") {
        await mutate(data => {
          const s = currentSession(data);
          if (s && !s.quizTitle) { s.quizTitle = message.title.slice(0, 120); data.dirty = true; }
        });
      }
      return { ok: true, enforce: !!onProtectedPage, rules: C.enforcement, showBanner: C.showBanner };
    }
    if (!onProtectedPage) return { ok: false };

    if (type === "CONTENT_HEARTBEAT") {
      await mutate(data => { data.state.lastQuizActivityAt = Date.now(); });
      return { ok: true };
    }
    if (!CONTENT_EVENT_TYPES.has(message.eventType)) return { ok: false };
    await logEvent(message.eventType, cleanDetails(message.details));
    await mutate(data => { data.state.lastQuizActivityAt = Date.now(); });
    return { ok: true };
  }

  // ----- from extension pages only (popup, dashboard, warning page) -----
  if (!isExtensionPage(sender)) return { ok: false, error: "Not allowed." };

  if (type === "GET_STATUS") {
    const { state, sessions } = await snapshot();
    return statusPayload(state, sessions);
  }

  if (type === "START_MANUAL") {
    if (!C.testMode) return { ok: false, error: "Manual controls are disabled in this build." };
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const page = classify(tab?.url);
    if (!page || page.kind !== "view" || !isDigits(page.cmid)) {
      return { ok: false, error: "Open a quiz information page first (…/mod/quiz/view.php?id=…)." };
    }
    const out = await mutate(data => {
      if (data.state.active) return { started: false };
      beginSession(data, { ...page, attemptId: `manual-${Date.now()}` }, tab.url, tab.id, "Manually started (test mode).");
      data.state.manual = true;
      return { started: true };
    });
    if (out.started) await afterStart();
    return { ok: true };
  }

  if (type === "STOP_MANUAL") {
    if (!C.testMode) return { ok: false, error: "Manual controls are disabled in this build." };
    await endSession("Manually stopped (test mode).");
    return { ok: true };
  }

  if (type === "DELETE_SESSION") {
    const denied = await authorizeDestructive(message.pin);
    if (denied) return { ok: false, error: denied };
    return mutate(data => {
      if (data.state.sessionId === message.sessionId) return { ok: false, error: "Stop the active session before deleting it." };
      data.sessions = data.sessions.filter(s => s.id !== message.sessionId);
      data.dirty = true;
      return { ok: true };
    });
  }

  if (type === "CLEAR_HISTORY") {
    const denied = await authorizeDestructive(message.pin);
    if (denied) return { ok: false, error: denied };
    return mutate(data => {
      if (data.state.active) return { ok: false, error: "Wait until the quiz is submitted and monitoring ends." };
      data.sessions = [];
      data.dirty = true;
      return { ok: true };
    });
  }

  return { ok: false, error: "Unknown request." };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch(error => sendResponse({ ok: false, error: error.message }));
  return true;
});
