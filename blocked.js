const $ = id => document.getElementById(id);
let resumeUrl = GUARD_CONFIG.lmsOrigin + "/";

(async () => {
  try {
    const r = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
    if (!r?.ok) return;
    const { state, threshold } = r;
    if (state.resumeUrl) resumeUrl = state.resumeUrl;
    if (state.lastBlocked) {
      $("siteInfo").textContent = `${state.lastBlocked.domain} (${state.lastBlocked.category}) is restricted during this examination.`;
    }
    $("strikeInfo").textContent = state.active ? "This attempt has been recorded." : "";
  } catch (_) { /* leave the default text */ }
})();

$("proceedBtn").addEventListener("click", () => { location.href = resumeUrl; });
$("dontBtn").addEventListener("click", () => {
  chrome.tabs.getCurrent(tab => {
    if (tab?.id !== undefined) chrome.tabs.remove(tab.id);
    else window.close();
  });
});
