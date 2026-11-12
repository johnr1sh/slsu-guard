const $ = id => document.getElementById(id);

const names = {
  SESSION_STARTED: "Protection started",
  SESSION_RESUMED: "Attempt reopened (strikes carried over)",
  SESSION_ENDED: "Protection ended",
  RESTRICTED_SITE_BLOCKED: "Restricted website blocked",
  RESTRICTED_TAB_FOUND_AT_START: "Restricted tab already open at start (redirected)",
  REVIEW_THRESHOLD_REACHED: "Review threshold reached",
  THREE_STRIKE_REVIEW_THRESHOLD: "Review threshold reached",
  QUIZ_TAB_CLOSED: "Quiz tab closed",
  NAVIGATED_AWAY_FROM_ATTEMPT: "Left the attempt page (attempt unfinished)",
  OTHER_LMS_PAGE_OPENED: "Other LMS page opened",
  QUIZ_PAGE_HIDDEN: "Quiz page hidden",
  QUIZ_PAGE_VISIBLE: "Quiz page visible",
  WINDOW_FOCUS_LOST: "Browser window lost focus",
  WINDOW_FOCUS_RETURNED: "Browser window regained focus",
  COPY_BLOCKED: "Copy blocked",
  CUT_BLOCKED: "Cut blocked",
  PASTE_BLOCKED: "Paste blocked",
  DROP_BLOCKED: "Drag-and-drop blocked",
  CONTEXT_MENU_BLOCKED: "Right-click blocked",
  SHORTCUT_BLOCKED: "Restricted shortcut blocked",
  PRINT_ATTEMPT: "Print attempt",
  LARGE_TEXT_INSERTION: "Large text insertion (not via paste)",
  ANSWER_FIELD_CHANGED: "Answer field changed",
  PROGRAMMATIC_TEXT_CHANGE: "Text changed without typing (script/extension)",
  MONITORING_GAP: "Monitoring was interrupted (extension off or browser closed)",
  RULES_RESTORED: "Blocking rules were missing and were restored",
  AUTOMATION_FLAG: "Browser reports automation control",
  MULTIPLE_DISPLAYS: "More than one display detected",
  // events recorded by v2.x
  COPY_EVENT: "Copy event", CUT_EVENT: "Cut event", PASTE_EVENT: "Paste event",
  TARGET_QUIZ_PAGE_OPENED: "Target quiz page opened", QUIZ_FORM_SUBMIT_EVENT: "Quiz submission event"
};

const CLIPBOARD = new Set(["COPY_BLOCKED", "CUT_BLOCKED", "PASTE_BLOCKED", "DROP_BLOCKED", "COPY_EVENT", "CUT_EVENT", "PASTE_EVENT"]);

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function duration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

// Summaries are indicators only. "Away" merges tab-hidden and window-blur into one interval.
function summarize(s) {
  const out = { restricted: 0, clipboard: 0, shortcuts: 0, awayCount: 0, awayMs: 0, largeInserts: 0, integrity: 0 };
  let awayStart = null;
  for (const e of s.events) {
    const t = e.type;
    if (t === "RESTRICTED_SITE_BLOCKED") out.restricted++;
    else if (CLIPBOARD.has(t)) out.clipboard++;
    else if (t === "SHORTCUT_BLOCKED" || t === "CONTEXT_MENU_BLOCKED" || t === "PRINT_ATTEMPT") out.shortcuts++;
    else if (t === "LARGE_TEXT_INSERTION" || t === "PROGRAMMATIC_TEXT_CHANGE") out.largeInserts++;
    else if (t === "MONITORING_GAP" || t === "RULES_RESTORED" || t === "AUTOMATION_FLAG") out.integrity++;
    else if (t === "QUIZ_PAGE_HIDDEN" || t === "WINDOW_FOCUS_LOST") {
      if (awayStart === null) { awayStart = Date.parse(e.timestamp); out.awayCount++; }
    } else if (t === "QUIZ_PAGE_VISIBLE" || t === "WINDOW_FOCUS_RETURNED") {
      if (awayStart !== null) { out.awayMs += Date.parse(e.timestamp) - awayStart; awayStart = null; }
    }
  }
  if (awayStart !== null && s.endedAt) out.awayMs += Date.parse(s.endedAt) - awayStart;
  return out;
}

function detailText(e) {
  const d = e.details || {};
  const parts = [];
  if (d.domain) parts.push(d.category ? `${d.domain} (${d.category})` : d.domain);
  if (d.shortcut) parts.push(d.shortcut);
  if (d.characterCount) parts.push(`${d.characterCount} characters`);
  if (d.characters) parts.push(`+${d.characters} characters`);
  if (d.page) parts.push(d.page);
  if (d.minutes !== undefined) parts.push(`${d.minutes} min`);
  if (d.reason) parts.push(d.reason);
  if (d.note) parts.push(d.note);
  return parts.join(" · ");
}

let cached = [];

async function askPin() {
  const r = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
  if (!r?.pinRequired) return "";
  return prompt("Administrator PIN required to delete history:");   // null when cancelled
}

async function render() {
  const data = await chrome.storage.local.get(["guardState", "guardSessions"]);
  const state = data.guardState || { active: false };
  cached = data.guardSessions || [];
  const flaggedOnly = $("flaggedOnly").checked;

  const attempts = cached.reduce((n, s) => n + s.events.filter(e => e.type === "RESTRICTED_SITE_BLOCKED").length, 0);
  const flagged = cached.filter(s => s.reviewRequired || s.violationCount >= GUARD_CONFIG.strikeThreshold).length;
  $("sessions").textContent = cached.length;
  $("attempts").textContent = attempts;
  $("flagged").textContent = flagged;
  $("active").textContent = state.active ? "Active" : "Off";

  const shown = cached.filter(s => !flaggedOnly || s.reviewRequired);
  if (!shown.length) {
    $("sessionList").innerHTML = `<div class="empty">${cached.length ? "No flagged sessions." : "No examination sessions recorded yet."}</div>`;
    return;
  }

  $("sessionList").innerHTML = shown.map(s => {
    const st = summarize(s);
    const label = s.quizTitle || (s.cmid ? `Quiz #${s.cmid}` : "Quiz session");
    const active = state.sessionId === s.id;
    return `
    <article class="session">
      <div class="session-head">
        <div>
          <h2>${esc(label)}</h2>
          <p>Attempt ${esc(s.attemptId || "n/a")} · session ${esc(s.id.slice(0, 8))} · ${new Date(s.startedAt).toLocaleString()}</p>
          <small>${s.endedAt ? `Ended ${new Date(s.endedAt).toLocaleString()} — ${esc(s.endReason || "")}` : (active ? "Session in progress" : "Session not cleanly ended")}</small>
        </div>
        <div class="session-badges">
          <span class="count">${s.violationCount || 0} restricted attempts</span>
          ${s.reviewRequired ? '<span class="flag">REVIEW REQUIRED</span>' : ""}
        </div>
      </div>
      <div class="chips">
        <span class="chip">Clipboard/drag blocked: <b>${st.clipboard}</b></span>
        <span class="chip">Shortcuts / right-click: <b>${st.shortcuts}</b></span>
        <span class="chip">Left quiz page: <b>${st.awayCount}×</b>${st.awayCount ? ` (${duration(st.awayMs)})` : ""}</span>
        <span class="chip">Bulk text inserts: <b>${st.largeInserts}</b></span>
        <span class="chip">Integrity warnings: <b>${st.integrity}</b></span>
      </div>
      <details><summary>View ${s.events.length} recorded events</summary>
        <div class="events">${[...s.events].reverse().map(e => `
          <div class="event">
            <span class="event-dot"></span>
            <div><strong>${esc(names[e.type] || e.type)}</strong><small>${new Date(e.timestamp).toLocaleString()}</small>
            <small>${esc(detailText(e))}</small></div>
          </div>`).join("")}</div>
      </details>
      ${active ? "" : `<div class="session-actions"><button class="quiet" data-delete="${esc(s.id)}">Delete this session</button></div>`}
    </article>`;
  }).join("");
}

$("sessionList").addEventListener("click", async e => {
  const id = e.target?.dataset?.delete;
  if (!id || !confirm("Delete this session from local history?")) return;
  const pin = await askPin();
  if (pin === null) return;
  const r = await chrome.runtime.sendMessage({ type: "DELETE_SESSION", sessionId: id, pin });
  if (!r.ok) alert(r.error);
});

$("flaggedOnly").addEventListener("change", render);
$("jsonBtn").addEventListener("click", () => download("guard-plus-report.json", JSON.stringify(cached, null, 2), "application/json"));
$("csvBtn").addEventListener("click", () => {
  // Prefix risky leading characters so spreadsheet apps never treat a cell as a formula.
  const safe = v => { const s = String(v ?? ""); return /^[=+\-@\t\r]/.test(s) ? "'" + s : s; };
  const quote = v => `"${safe(v).replace(/"/g, '""')}"`;
  const rows = [["session_id", "quiz_cmid", "attempt_id", "quiz_title", "started_at", "ended_at", "end_reason", "event", "timestamp", "details"]];
  cached.forEach(s => s.events.forEach(e => rows.push([
    s.id, s.cmid || "", s.attemptId || "", s.quizTitle || "", s.startedAt, s.endedAt || "", s.endReason || "",
    e.type, e.timestamp, JSON.stringify(e.details || {})
  ])));
  download("guard-plus-report.csv", rows.map(r => r.map(quote).join(",")).join("\r\n"), "text/csv;charset=utf-8");
});
$("clearBtn").addEventListener("click", async () => {
  if (!confirm("Delete all local GUARD++ session history?")) return;
  const pin = await askPin();
  if (pin === null) return;
  const r = await chrome.runtime.sendMessage({ type: "CLEAR_HISTORY", pin });
  if (!r.ok) alert(r.error);
  render();
});

render();
chrome.storage.onChanged.addListener(render);
