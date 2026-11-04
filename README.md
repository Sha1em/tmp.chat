# tmp.chat

Explore the tangent. Keep the thread.

A small Chrome/Edge extension that opens a contextual side conversation in the unused space beside a ChatGPT answer. It uses one dedicated, inactive ChatGPT tab and mirrors its answer into a custom panel.

**Version 0.1.6 addresses the follow-up verification failure reproduced in signed-in Edge.** ChatGPT replaces the initial Temporary Chat marker with a Save chat control and uses different IDs in native message metadata and its canonical URL. The extension now records that route during the initial verified answer and recognizes the current native Temporary Chat header. Added message metadata is compared by namespace rather than one changing priority key. UI and v0.1.4 streaming remain unchanged. The selection action remains **tmp.chat()**. Automated browser tests use offline fixtures and do not establish live compatibility. This is website automation, not an official OpenAI integration.

## Install locally

1. Open `chrome://extensions` or `edge://extensions`.
2. Turn on **Developer mode**.
3. Choose **Load unpacked** and select this project folder, which contains `manifest.json`.
4. Open or refresh [ChatGPT](https://chatgpt.com) and sign in normally.

When updating an existing installation, replace its files (or select the newly extracted folder), click **Reload** on the extension card, and **refresh the ChatGPT tabs**. Reloading the extension alone does not replace content scripts already running in an open page.

Start a fresh tangent after updating from an older version. An already open helper can retain its old adapter until its document reloads; re-injecting the same guarded adapter does not replace its active request. Keep or copy anything useful before discarding an old tangent.

The ZIP in `dist/` can be extracted into its own folder and loaded the same way. No server, build step, npm install, API key, or separate extension account is needed. The extension has not been published to an extension store.

## Use

1. Highlight text within one ChatGPT assistant answer.
2. Choose **tmp.chat()** beside the selection.
3. Ask your question in the margin panel. `Enter` sends; `Shift+Enter` adds a line.
4. On the first send, tmp.chat opens one dedicated **inactive tab**, requests Temporary Chat, verifies a temporary-mode UI marker, inserts the context and question, and sends once.
5. Answers stream into the panel. Follow-ups reuse the same temporary chat, without copying the original context again.

If selection is unavailable, open tmp.chat from its toolbar icon and type a question immediately. **Add context · optional** accepts pasted text. Sending creates the same single temporary conversation; it does not open the helper just to display the panel. An existing tangent in another tab cannot be replaced by this fallback.

The extra tab is visible in your browser's tab bar. It does not take focus unless you choose **Open ChatGPT** or **Keep in ChatGPT**. It uses the signed-in account's ordinary capabilities and limits; it does not create a free quota or change your plan.

- **Minimize / Escape:** preserve the tangent and collapse the panel.
- **Copy:** copy the visible side conversation, without the hidden context prompt.
- **Keep in ChatGPT:** hand the background tab back to you and open it. **Choose ChatGPT's own Save chat action to save it in history.** The extension does not claim it has been saved and will no longer close that tab.
- **Discard:** confirm dismissal, close the dedicated tab, and clear the extension's session data.
- **Stop:** ask the native ChatGPT UI to stop generating.
- **Toolbar icon:** reopen or minimize tmp.chat on a ChatGPT page.

One tangent is supported at a time across your ChatGPT tabs. A new selection cannot silently replace an existing conversation.

## Answers and response speed

Answers are brief by default, with short paragraphs, bullets, and small code examples when useful. Follow-ups can request more detail. This prompt is guidance to ChatGPT, not a guarantee of response length or format.

The panel preserves supported answer parts in order, including paragraphs, headings, lists, links, tables, and code blocks. Div-based CodeMirror and Monaco editors are normalized into static code with line breaks and indentation. Native Run buttons, syntax-colouring machinery, and interactive components are not copied. Interactive diagrams, maps, images, and other unsupported visuals show a notice with **View in ChatGPT**, which opens the existing helper without keeping, saving, or releasing the tangent. Text around an unsupported visual is retained. If extraction reaches its size or structure limit, **Open full answer** makes that limit visible.

Text streams while ChatGPT generates it; the panel does not wait for the entire answer before showing text. Structured formatting is reconciled at completion. Model thinking time, helper startup, and network latency can still delay the first visible text.

**Response speed** defaults to **Use current ChatGPT setting**, which makes no speed-control changes. **Prefer Instant** is an optional browser-local preference that looks for an Instant option in the helper's native composer effort menu before sending. It does not use the global model picker or substitute another named model. If no supported control or Instant option is found, it leaves the current setting and reports that Instant was unavailable. If it clicks an option but cannot verify the result, it pauses before sending and asks you to inspect the helper. Availability and native labels vary by account and rollout. ChatGPT may share preferences across chats, so choosing Instant may also affect its defaults outside the helper. The extension cannot guarantee a tab-specific setting or eliminate startup/network delays. This new automation requires signed-in manual verification.

## Layout

The panel is 344 pixels wide. It measures visible text lines, images and other media, tables, and the native composer. When enough right-side whitespace is available, tmp.chat uses it. Otherwise it reserves only the space needed on the shared conversation shell, then verifies the resulting layout. If content cannot move safely or the reading column would become too narrow, it collapses to the same horizontal pill instead of showing an overlapping panel.

Light/dark themes follow ChatGPT. The panel and selection action have isolated styles. Minimizing, compact fallback, and closing release all reserved space and restore the site's original inline layout properties. The minimized pill retains its icon, tmp.chat label, and expand icon.

Layout measurement is bounded to 4,000 text nodes. If a very large page exceeds that limit, tmp.chat stays compact rather than treating unchecked content as empty space.

Version 0.1.2 preserves this layout and the horizontal pill. Some live overlap situations reported during testing still need separate investigation; this release prioritizes connecting questions, detecting answers, and selection.

## Reliability and efficiency

- No runtime dependencies, external fonts, analytics, content servers, private ChatGPT endpoints, or authentication-token extraction.
- The helper is created only on the first question, not when you select text or open the panel.
- One helper and one in-flight question; follow-ups reuse both the tab and conversation.
- Context is capped at 2,400 selected characters, 4,200 nearby characters, and 1,600 characters from the original user question. Questions are capped at 4,000 characters.
- A bounded assistant role can identify early response text without waiting for native copy/search enrichment. The verified active answer is cached; a structural observer detects replacement of the answer or its container.
- First available text is extracted directly from a relevant DOM mutation callback. Later updates use elapsed-time coalescing at a target of 120 milliseconds; a new meaningful mutation can flush even when a hidden-tab timer is overdue. There is no perpetual page-scraping loop. Browser freezing and native model/network delays remain outside this guarantee.
- Stream messages carry appended text or a replacement when ChatGPT revises text. Sequence/offset checks reject duplicate or missing deltas and recover existing output without repeating native submission. The panel appends to the active text node and preserves completed bubbles when a follow-up is added. It does not reprocess history or resize the composer on each ordinary text patch.
- Structured formatting is rendered at completion using an allowlist of elements and safe links; a final format-only change also updates the bubble. Code whitespace, ordering, bounds and rich-content fallbacks remain in the canonical extractor.
- Stream snapshots are coalesced in browser-session storage; final states are flushed immediately. Transcript state is bounded to 30 question/answer turns and a 240,000-character threshold for starting another turn, with a 64,000-character answer cap.
- The helper is protected against automatic tab discarding while owned. A heartbeat and watchdog run only during requests.
- Ambiguous send failures are never automatically replayed. **Check again** observes an existing attempt, or retries setup only after a positively reported pre-send failure.
- Follow-ups verify continuity in the same helper document using retained message evidence or a previously known native conversation ID corroborated by bounded live turns. Query changes alone do not invalidate that proof. Adopting a canonical `/c/id` from the initial page requires that exact native ID and a positive Temporary Chat marker. Different concrete conversations, contradictory identity, explicit Temporary Chat-off state, missing evidence, and a reloaded adapter remain blocked. Verification repeats after setup waits and immediately before Send.
- Source-tab closure and navigation away from ChatGPT clean up the helper, unless it has been explicitly handed back to you.

Loading a second ChatGPT page still costs browser memory and startup time. “Dependency-free” does not mean that page has no cost.

## If a request needs attention

Choose **Open ChatGPT** to inspect the dedicated tab. Finish sign-in, a native confirmation, or Temporary Chat setup there, then return and choose **Check again**. The extension will not bypass verification screens or guess whether a failed send should be repeated.

The panel now shows the current connection step and a short error code. Page-load and adapter-readiness checks are separate from waiting for ChatGPT's composer. Temporary Chat must be positively verified before inserting context. If a setup dialog asks you to choose personalized or unpersonalized behavior, choose that preference yourself; the extension does not choose it for you.

| Error code | What to inspect |
| --- | --- |
| `HELPER_LOAD_TIMEOUT` / `HELPER_NAVIGATION` | Helper navigation or page loading. |
| `HELPER_INJECTION` / `HELPER_HANDSHAKE` | Whether the helper's extension adapter attached and acknowledged readiness. |
| `SIGN_IN_REQUIRED` | Native sign-in or an authentication gate. |
| `TEMPORARY_UNVERIFIED` / `TEMPORARY_CHOICE_REQUIRED` | Temporary Chat state or a native setup choice. |
| `SPEED_UNVERIFIED` | An opt-in Instant click could not be verified. Inspect the helper, or choose the current setting before checking again; nothing was sent. |
| `CONVERSATION_CHANGED` | The helper's previous conversation identity could not be verified. Return to the original conversation. Check can retry a positively unsent follow-up once its identity is restored; ambiguous attempts remain observation-only. |
| `COMPOSER_NOT_FOUND` / `DRAFT_INSERT_FAILED` | The editable input or draft insertion. |
| `SEND_NOT_READY` | The draft exists but native Send is not ready; no send was attempted. |
| `SEND_UNCONFIRMED` | Send was clicked, but the resulting turn was not recognized. Check only observes that attempt. |
| `RESPONSE_NOT_FOUND` / `RESPONSE_TIMEOUT` | A missing or unfinished assistant response after an existing send attempt. |

For ambiguous attempts, **Check again** refreshes the local DOM adapters and observes the same request. It never dispatches the prompt again. A positively reported pre-send setup failure can be deliberately retried with Check.

If the native page reloads during a temporary conversation, the extension refuses to send follow-ups into an unverified replacement conversation. Keep/copy the available text, then discard and begin a new tangent. Browser restart clears the extension's session transcript. Restored helper tabs without their identifying marker may need manual closure.

The adapter deliberately refuses to send context if it cannot positively verify Temporary Chat. Composer and setup selectors are near the top of `agent.js`; shared selection detection is in `lib/selection.js`, and complete-answer extraction is in `lib/answer.js`. The newer renderer is recognized by explicit native speaker headings and bounded assistant containers. Available native message keys are compared locally to distinguish new answers from old remounts; their values are never logged or sent to an extension server. Support for attachments, voice, native branching, and parallel tangents is outside this version.

## Diagnostics

Open Edge DevTools on the ChatGPT tab, enable **Verbose** console messages, and filter for `tmp.chat`. Selection diagnostics report the event source, accepted/rejected reason, DOM strategy, and structural metadata for rejected ranges. They contain tag names, known speaker roles, and lengths, not selected text, element IDs, or full labels. Input diagnostics report enabled/disabled states; messaging diagnostics report command names and success/failure. The last 60 UI records are also available as `__tmpChatDiagnostics` when the console execution context is set to this extension's content script.

Inspect the extension's service worker from `edge://extensions` for worker diagnostics. The helper tab logs agent setup, submission state, cancellation, and error codes. Readiness probes contain only document state, known booleans, and bounded counts for visible/hidden editors, dialogs, and message roots. Native error text is classified locally rather than copied into logs. **These diagnostics do not include selected text, questions, answers, or credentials.**

Streaming diagnostics add bounded first-occurrence timestamps: helper `stream:observe`, `stream:root`, `stream:extract`, and `stream:emit`; worker `stream:first-receive`, `stream:first-handle`, and `stream:first-forward`; panel `stream:first-receive` and `stream:first-commit`. Helper completion includes extraction/discovery counts. An observe mark may precede nonempty text; extraction marks indicate actual text. These describe extension processing, not model token-generation time or physical pixel presentation. `stream:gap` means the panel requested an existing-output snapshot. Diagnostics contain timings, visibility, counts and lengths only.

Helper `conversation:canonical-bound` records that the first owned answer established its canonical route. `conversation:verified` logs only whether a canonical route was adopted, whether stable native identity was available, and a matching-anchor count. `conversation:rejected` records a fixed reason such as `route`, `anchor`, `native-identity`, `canonical-route`, `temporary-off`, or `document`. The last 60 content-free agent records are available as `__tmpChatAgentDiagnostics` in the helper's extension execution context; readiness/error probes also retain the allowlisted `continuationReason`. Native conversation/message IDs, paths and query strings are never logged. The continuity proof remains in helper memory; reload does not reconstruct it from a Temporary Chat marker alone.

The `selection:detected` reason is useful when a native ChatGPT selection toolbar appears but tmp.chat does not: `not-assistant` indicates an unrecognized response wrapper; `cross-message` means the selection spans separate turns; `outside-document`/`excluded-ui` protects extension fields and native editors. `rpc:failed` indicates an extension messaging or worker-state problem.

On October 31, 2026, v0.1.2 signed-in Edge testing verified the intended helper URL, visible Temporary Chat state, manual question submission, recovery of its existing answer without replay, a fresh highlight-to-answer flow without Check, and a subsequent real answer in the same temporary conversation. The native Ask ChatGPT action and the extension's then-labelled Ask tmp.chat action were visible together. Minimizing showed the preserved horizontal pill and released the source column. The main conversation's composer was left empty and no messages were sent into it. Browser inspection later stopped during cleanup because Computer Use could not verify the current Edge URL; cleanup after that point was not verified.

On November 3, 2026, signed-in Edge reproduced v0.1.5's first-answer success followed by `CONVERSATION_CHANGED`. The helper's live diagnostic reason was `canonical-route`; structural checks confirmed the canonical URL, an opaque native conversation ID distinct from its URL ID, no old Temporary marker, and a visible Save chat button in the main header. After reloading the final v0.1.6 correction, a fresh question returned `11` and a contextual follow-up returned `22` in the same tmp.chat tangent, without Check or replay. This verifies the reported basic follow-up flow on that account. Longer hidden-tab periods, complete multi-part answers, current code editor markup, rich-content fallbacks, streaming/final formatting, and optional Instant selection—including whether the native setting affects other chats—also need current verification. Broader testing includes sign-in/setup gates, limits, long/tool-rich responses, reported image/zoom/sidebar overlap cases, and native Save chat after Keep. Fixture tests are not evidence of live compatibility. The separate completion heuristic and final-delivery reliability backlog remains open.

## Development and verification

The same signed-in v0.1.6 tangent also completed a second contextual follow-up, returning `23` after `11` and `22`. The installed extension was reloaded and the source tab refreshed before this test; the original chat's composer remained empty.

Node.js 22 or later is sufficient. No dependencies need installing.

The v0.1.2 baseline passed manifest/runtime checks, 62 unit tests, the integrated offline Edge regression suite, and ZIP integrity checks. Run the commands below for the current version. The signed-in results above are separate from fixture tests.

```sh
npm run check
npm test
npm run test:browser
npm run package
```

For the focused offline streaming suite, run `node scripts/browser-smoke.cjs --streaming-only`. It holds native generation open, requires partial text before completion, and tests missing metadata, attribute-only discovery, character-data updates, root/main replacement, rewrites, code whitespace, missed patches, minimize/restore and freeze/resume. It asserts a visible source and hidden helper. Exploratory first-text and page-work counters are written to `.test-artifacts/streaming-timings.json`; these headless/debugger-attached fixture measurements are not signed-in benchmarks.

On Windows PowerShell with restricted script execution, use `npm.cmd` instead of `npm`.

The browser smoke test launches an isolated headless Edge/Chromium profile. **All ChatGPT requests are intercepted and served from local fixtures.** It loads the real unpacked extension and tests the service worker, lazy tab creation, composer insertion, streaming, duplicate-send protection, follow-ups, safe response rendering, responsive layout, dark mode, minimization, and discard cleanup. UI regressions use pointer hit-testing and keyboard/text-input events and include a native-style toolbar that immediately clears selection, the observed native speaker/response wrappers without legacy selectors, manual drafts and sending, cross-tab ownership refresh, media/composer collisions, and layout restoration. Helper regressions cover delayed SPA editors, hidden legacy textareas, visible ProseMirror input, personalization-choice blocking/resume, and ambiguous send confirmation without replay. Rich-answer cases include multiple sibling response sources, exact div-editor code whitespace, text after unsupported visuals, final format-only reconciliation, and opening the existing helper without releasing the tangent. Copy uses a fixture clipboard stub so the test does not overwrite your clipboard. Screenshots are written to `.test-artifacts/`.

On another machine, set `TMP_CHAT_BROWSER` to your Chromium browser executable if it is not detected automatically. Unit tests cover context bounds, layout, rendering limits, worker restart, ownership, ambiguous sends, and cleanup.

See [PRIVACY.md](PRIVACY.md) for data handling and permissions.
