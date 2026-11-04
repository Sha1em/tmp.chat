# tmp.chat data handling

This extension has no operator-controlled AI server, conversation database, tracking endpoint, or analytics. The packaged JavaScript runs in your browser.

When you ask a question, tmp.chat copies a bounded selection, surrounding text, and the originating user question into a dedicated ChatGPT Temporary Chat. ChatGPT sends that information to OpenAI through its normal website. AI processing does not occur entirely on your computer. Your ChatGPT account limits, workspace rules, and OpenAI's policies continue to apply.

The selected context and side transcript are held in extension memory and `chrome.storage.session`, which is browser-session storage rather than permanent local storage. They survive an extension worker restart, and are removed when you discard a tangent, hand it back to ChatGPT, close its source tab, navigate the source away from ChatGPT, or end the browser session. There is no extension transcript history. Saving or copying text yourself creates a copy under your control.

The response-speed preference is stored separately in `chrome.storage.local` so it can survive browser restarts. It contains only the choice to use the current ChatGPT setting or prefer Instant; it contains no conversation content. Using the current setting makes no speed-control changes. If you opt into Prefer Instant, the extension may operate the native helper composer effort control. ChatGPT may share that preference with other chats; the extension cannot promise a tab-specific setting.

Minimizing does not discard a conversation. The source tab, extension, and helper must stay available to resume it. The helper is a real inactive browser tab, visible in the tab bar, and consumes resources.

Discarding closes the extension-owned helper tab. It does not promise immediate erasure of OpenAI's server-side records. OpenAI documents that Temporary Chats stay out of history unless saved and that copies may be retained for up to 30 days for safety. See [OpenAI's Temporary Chat documentation](https://help.openai.com/en/articles/8914046-temporary-chat-in-chatgpt).

**Keep in ChatGPT** transfers control of the helper tab back to you. It does not automatically save the conversation. Choose ChatGPT's native Save chat action if you want to retain it. Once handed back, the extension does not close that tab or manage its conversation.

**View in ChatGPT** and **Open full answer** only focus the existing helper tab. They do not save the conversation or transfer ownership; Discard and source-tab cleanup still apply afterward. Interactive visuals are not executed in the panel. Unsupported content and extraction limits show an explicit notice while supported text is mirrored.

The extension reads and modifies only `https://chatgpt.com/*`. It does not read other websites, extract authentication tokens, or use private ChatGPT API endpoints. It uses the native composer and rendered response. The optional native Instant choice described above may affect ChatGPT preferences; the extension does not operate the global model picker. Conversation content is treated as untrusted input; mirrored output is restricted to text and a small allowlist of formatting elements and HTTP/HTTPS links.

If automatic selection fails, you can type a question and optionally paste context into the panel. The pasted context follows the same size bounds and data handling as automatically selected context. Diagnostic console records contain only command names, connection stages, error codes, known booleans, bounded counts, and structural selection metadata (such as tag names and known speaker roles). They do not contain conversation text, native message/conversation identifier values, full element labels, or credentials, and are not transmitted to an analytics service. Native page errors are classified locally rather than copied into logs. Temporary Chat setup or personalization choices are left to you.

Streaming diagnostics additionally record first-occurrence processing timestamps, visibility, coarse lengths and operation counts. Available native message and conversation keys are compared within helper-tab memory to distinguish responses and verify follow-up continuity; those native key values are not added to diagnostic records or extension-session storage. Conversation verification logs only fixed reason codes, known booleans and anchor counts, never native IDs, paths or query strings. The continuity proof is local to the current helper document and is not reconstructed after a page reload. Output sequence numbers and session revisions are extension-generated metadata used to detect missed updates and restore existing output. Recovery never repeats an ambiguous native question submission.

## Permissions

- **Host access to chatgpt.com:** inject the selection action and panel; operate the dedicated ChatGPT page; read its rendered answer.
- **scripting:** inject the small automation adapter into the extension-owned helper tab.
- **storage:** keep bounded ephemeral session state across service-worker suspension, and retain the content-free response-speed preference locally.
- **alarms:** detect a stalled request while the extension worker is sleeping. The watchdog is removed when the request finishes or the tangent is discarded.

No `<all_urls>`, browser-history, cookies, debugger, downloads, native-messaging, or response-header override permission is requested.
