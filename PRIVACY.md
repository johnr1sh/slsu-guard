# GUARD++ Privacy and Responsible Use

> GUARD++ is a student-created project, not an official SLSU administration system. Records stay in the browser on your own device.

GUARD++ is designed for visible, authorized use during Moodle quiz attempts at SLSU. A small label on the quiz page tells students it is active.

## Data stored locally (browser extension storage only)
- Session start/end times and reason; quiz module id (`cmid`), attempt id, quiz page title
- Restricted-site domain, category and timestamp
- Browser focus/visibility indicators; quiz tab closed; other LMS page paths opened during the attempt (no query strings)
- Blocked copy / cut / paste / drag-drop / right-click / shortcut attempts (no content), paste length only
- Answer-field change indicators and large-insertion character counts (never the text)
- Whether the review threshold was reached
- Integrity indicators: monitoring interruptions, blocking rules restored, text that changed without typing (character count only), automation flag, more than one display detected

## Not collected
Passwords or tokens, answer text, clipboard contents, keystroke sequences, screenshots, webcam/microphone, browsing history outside restricted-site attempts during an active attempt.

## Important
A blocked attempt or indicator is not proof of cheating. Reaching the threshold only flags a session for human review. GUARD++ never bans or penalizes students automatically.
Before deployment: obtain authorization, publish a notice and retention policy, limit report access, test accessibility impacts, and provide human review and an appeal path.
