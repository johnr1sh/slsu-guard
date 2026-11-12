const $ = id => document.getElementById(id);

async function refresh() {
  const r = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
  if (!r?.ok) return;
  const { state, current, threshold, testMode, categories } = r;

  $("statusTitle").textContent = state.active ? "Protection is active" : "Protection is off";
  $("statusText").textContent = state.active
    ? (current?.quizTitle ? `Monitoring: ${current.quizTitle}` : "This quiz attempt is being monitored.")
    : "Protection turns on automatically when you open a quiz attempt.";
  $("statusDot").classList.toggle("active", state.active);
  $("strikes").textContent = `${state.violationCount} / ${threshold}`;
  $("eventCount").textContent = current?.eventCount || 0;

  // Manual controls exist for testing only. In a real exam build they are hidden.
  $("startBtn").hidden = !testMode || state.active;
  $("stopBtn").hidden = !testMode || !state.active;

  const list = $("siteList");
  list.textContent = "";
  categories.forEach(name => { const li = document.createElement("li"); li.textContent = name; list.appendChild(li); });
}

$("startBtn").addEventListener("click", async () => {
  const result = await chrome.runtime.sendMessage({ type: "START_MANUAL" });
  $("message").textContent = result.ok ? "Test session started." : result.error;
  refresh();
});
$("stopBtn").addEventListener("click", async () => {
  if (!confirm("Stop the GUARD++ test session?")) return;
  const result = await chrome.runtime.sendMessage({ type: "STOP_MANUAL" });
  $("message").textContent = result.ok ? "Test session stopped." : result.error;
  refresh();
});
$("dashboardBtn").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") }));
refresh();
