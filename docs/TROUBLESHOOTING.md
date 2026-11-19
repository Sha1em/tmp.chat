# Troubleshooting

[← Overview](../README.md) · [Architecture](ARCHITECTURE.md) · [Privacy](../PRIVACY.md)

## Start here

1. Confirm the extension is enabled and the page is `https://chatgpt.com`.
2. After an update, reload the extension **and refresh the ChatGPT page**.
3. Preserve useful tangent text before a fresh test.
4. For a stalled request, use **Open ChatGPT** to inspect the existing helper. Avoid submitting the same question in both interfaces.
5. Complete native sign-in/setup yourself, then return to **Check again**.

Check observes uncertain existing attempts; it is not a general resend action.

## Common symptoms

| Symptom | What to check |
| --- | --- |
| Selection action absent | Select within one assistant answer, outside native editors. Use manual entry if the native markup changed. |
| Compact pill only | Widen the browser or inspect zoom/sidebar/media. Compact mode is preferred when safe space cannot be established. |
| Tangent open elsewhere | Return to its source and Keep or Discard. Minimize preserves ownership. |
| Tabs closed, but ownership remains | A stale-session edge case may be involved. Preserve accessible text and record the circumstances before clearing anything. |
| Slow first question | A fresh helper has startup costs. Visibility, model/effort and network behaviour can also matter. No universal speed target is established. |
| Instant unavailable | Native control/labels may be unsupported. Inspect manually; unavailable does not prove the current setting is slow. |
| Plain code while streaming | Structured formatting is reconciled at completion. |
| Missing diagram/image/map | Use **View in ChatGPT**. Interactive components are not executed in the panel. |
| Cut-off answer | Inspect the helper for the remainder. Note whether it has more text; extraction/completion and native generation are different stages. |
| Follow-up blocked after reload | The document-local continuity proof is gone. Preserve text and begin a fresh tangent. |

## Stages and codes

| Code | Meaning / next inspection |
| --- | --- |
| `HELPER_LOAD_TIMEOUT`, `HELPER_NAVIGATION` | Navigation/document did not reach the expected state. |
| `HELPER_INJECTION`, `HELPER_HANDSHAKE` | Adapter attachment or acknowledgement failed. |
| `HELPER_PREPARE_TIMEOUT` | Empty-helper preparation did not finish. |
| `HELPER_CHANGED`, `HELPER_NOT_EMPTY` | Prepared helper changed or acquired native content before the first question. |
| `SIGN_IN_REQUIRED` | Finish native sign-in yourself. |
| `TEMPORARY_UNVERIFIED`, `TEMPORARY_CHOICE_REQUIRED` | Temporary mode or a native personalization choice needs attention. |
| `SPEED_UNVERIFIED` | An Instant selection could not be verified; sending pauses. |
| `CONVERSATION_CHANGED` | Live evidence did not corroborate the owned conversation. Inspect it; do not bypass verification. |
| `COMPOSER_NOT_FOUND`, `DRAFT_INSERT_FAILED` | Native input unavailable or draft not accepted. |
| `SEND_NOT_READY` | Native Send was not ready; no submission attempted. |
| `SEND_UNCONFIRMED` | Click occurred but the turn was not confirmed. Observe the existing attempt. |
| `RESPONSE_NOT_FOUND`, `RESPONSE_TIMEOUT` | Existing attempt has no recognized answer or has not completed within the wait. |

Temporary Chat must be positively verified before context insertion. Native personalization/setup choices remain user decisions.

## Diagnostics

In source-tab DevTools, enable **Verbose** console messages and filter `tmp.chat`. Inspect the extension service worker from the extensions page for coordination records; the helper's extension execution context has adapter records.

| Area | Records | Interpretation |
| --- | --- | --- |
| Selection | `selection:detected` | Accepted/rejected reason and structural metadata. |
| Messages | `rpc:failed`, command/result | Extension route or command failure. |
| Startup | `startup:send`, `startup:phase`, `startup:prepared`, `startup:native-send` | Preparation and submission waits. |
| Streaming | `stream:observe`, `stream:root`, `stream:extract`, `stream:emit` | Activity, discovery, actual extraction and emission. |
| Forwarding | `stream:first-receive`, `stream:first-handle`, `stream:first-forward`, `stream:first-commit` | Delivery stages. |
| Continuity | `conversation:verified`, `conversation:rejected` | Fixed reason and bounded counts. |

An observer mark can precede nonempty answer text. A Send click is not a server-acceptance timestamp; panel commit is not physical paint. DevTools can change scheduling, so qualify timings measured with it attached.

The source/helper retain bounded metadata as `__tmpChatDiagnostics` / `__tmpChatAgentDiagnostics` in their respective extension execution contexts. Ordinary page JavaScript does not necessarily expose extension globals.

## Reporting

Include browser/extension version, failed step, code, first-question versus follow-up, and whether the helper has the missing answer. For latency, note visibility, actual model/effort, context size, DevTools and energy settings.

Share reviewed, content-free records only. Do not attach profiles, raw session storage, auth headers, complete private chats or unredacted screenshots. See [CONTRIBUTING.md](../CONTRIBUTING.md).
