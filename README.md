# GUARD++ — Version 1.0.0.3

Chrome Manifest V3 extension for authorized integrity monitoring of Moodle quizzes on
`lms.southernleytestateu.edu.ph`. Works for **any** quiz; nothing is tied to a quiz ID.
Proprietary — see LICENSE and NOTICE. Keep this source private.

## Behaviour

| Moment | What happens |
|---|---|
| Student opens a quiz attempt (`attempt.php` / `summary.php`) | A session starts automatically for that attempt. Blocking turns on. |
| During the attempt | **Pure block, no alerts:** restricted sites show the "Access denied" page; all background traffic from those sites (APIs, websockets, embeds) is blocked outright; AI search modes (`udm=50`, Bing Chat/Copilot Search) are blocked by the browser. Copy / cut / paste / drag-drop / right-click / text selection / DevTools-print-save-source shortcuts are silently prevented. Nothing pops up. A small passive label on the quiz page says protection is active (`showBanner` in `config.js`). |
| Student submits | Protection ends on `review.php` for that attempt, or on `view.php` once the LMS confirms the attempt is finished. |
| Safety nets | Released after `inactivityMinutes` without quiz-page activity or after `maxSessionHours`. |

3 restricted-site attempts flags a session for **human review**. Nothing is penalised automatically.

## Hardening added in 1.0.0.3

- **Hard block instead of alerts:** notifications and toasts removed (and the `notifications` permission). Sub-resources of blocked sites are blocked at the network layer, so tabs that were already open stop working too.
- **Tamper evidence:** `MONITORING_GAP` is logged if monitoring is interrupted (extension disabled, browser closed) during an attempt; blocking rules are re-checked every minute and restored (`RULES_RESTORED`) if they go missing.
- **Evidence protection:** deleting sessions/history needs an **administrator PIN** (PBKDF2, rate-limited). With no PIN set, deleting is disabled. Set one with `node tools/set-admin-pin.js <PIN>`.
- **Stronger page enforcement:** listeners attach at window level (ahead of page scripts); text that appears without any keyboard/paste input is flagged (`PROGRAMMATIC_TEXT_CHANGE`); automation flag and multi-display detection.
- **Message hardening:** content messages accepted only from the top frame of the protected attempt; destructive actions only from extension pages; explicit extension-page CSP.
- Optional `uninstallUrl` hook (opens a page when the extension is removed).
- Version is `1.0.0.3`. Edit `config.js`, then run `node tools/sync-manifest.js`.

## Can students uninstall it?

An extension cannot protect itself from being removed. What works is **browser policy**: install it with
Chrome/Edge enterprise policy and the Remove/Disable buttons disappear ("Installed by your administrator").
The separate **GUARD++ Installer** package does this (and optionally locks down Incognito, DevTools, other
extensions, built-in AI features). It requires the extension to be published on the Chrome Web Store as
**Unlisted**, and it protects school/lab computers. A student with administrator rights on their own PC can
still undo local policies. See the installer's `README-SETUP.txt`.

## Limitations

Another browser/device, a phone, or software outside the browser can't be seen. Records live in the student's
browser (export them; a backend is the real fix). Disabling text selection can affect assistive-technology
users: provide an accommodation path. Chrome policy names for built-in AI features vary by version; unknown
ones are ignored.
