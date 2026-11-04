# v0.1.7 startup optimization

Implemented 4 November 2026. Rollback source: `stable-v0.1.6`, commit `feb5bf3`.
The stable tag and its backup bundle are unchanged. See `CHECKPOINT.md` for
non-destructive recovery into a separate working directory.

## What changed

The old path created a helper only after Send, waited for tab status `complete`,
injected four adapter files and then waited for native UI setup. Warm questions
reused the page but still repeated injection. The user's observed 15–20-second
first question versus 2–5-second follow-ups suggested startup overhead. That
observation alone did not identify the exact live-service contribution.

The new path is:

```text
Deliberate selection-action click / toolbar opening
  -> create one inactive owned helper
  -> wait for committed ChatGPT document, not every page resource
  -> inject immediately and bind subsequent messages to its document ID
  -> wait for native composer and positively verified Temporary Chat
  -> leave native draft untouched; allow local reading and typing

Send
  -> join the same preparation task, or probe the prepared adapter
  -> repeat existing live Temporary/continuation/draft/speed checks
  -> durable submission acknowledgement and one native Send
  -> existing progressive streaming and final safe formatting
```

Highlighting alone, passive page loading and automatic dock restoration do not
start preparation. Follow-ups keep one tab and its in-memory continuity proof.
Preparation does not focus the editor, insert context, submit a question, select
personalization, change speed or consume a model response. Existing opt-in speed
handling runs on Send. An immediate Send waits for the shared task; it does not
create another helper. Document-targeted messaging cannot silently redirect a
pending send to a replacement document. A replacement agent cannot reconstruct
the proof needed for an existing conversation.

Preparation uses existing browser APIs and permissions. Chrome documents `url`
as the last committed main-frame URL, `injectImmediately` as early injection,
and `documentId` as a message target. See the official
[Tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs) and
[Scripting API](https://developer.chrome.com/docs/extensions/reference/api/scripting).
Native readiness and ownership checks remain necessary after injection.

## Unused helper lifecycle

A one-shot alarm makes an unsent helper eligible for cleanup approximately three
minutes after opening. It requires an inactive tab still at the original helper
URL, no pending navigation, no local request/dispatch, and an agent confirming an
empty native editor with no user/assistant messages or generation. Focused,
changed or unverifiable pages and native drafts are retained. Alarms may be late.
There is no keepalive or repeating idle scraper.

Expiry preserves the source panel's question, pasted context, selection and
minimized pill. Reopening or sending can prepare another helper. Discard/source
closure also cleans up an owned helper whose initial navigation is still pending;
the previous complete-page-only cleanup could leave that early tab behind.

## Measurements and limits

Before editing runtime code, the same isolated headless Edge harness measured the
v0.1.6 baseline. All ChatGPT requests were fulfilled with local fixtures. Each
helper had a deliberately held 2-second image load and the harness's existing
1-second interception setup. Native output was synthetic, with about 100 ms of
driver wait after observing submission. The test used an attached debugger.
These are DOM timestamps, not physical-paint or live ChatGPT timings.

Four final trials per version, two per typing condition:

| Condition / metric | v0.1.6 | v0.1.7 final validation |
| --- | --- | --- |
| Immediate Send -> native submission | 3,176–3,205 ms | 1,188–2,581 ms |
| 2.5 s typing pause, Send -> native submission | 3,210–3,230 ms | 80–93 ms |
| 2.5 s typing pause, Send -> first panel text | 3,361–3,399 ms | 243–245 ms |
| Document state at first text | complete in all four | interactive in all four |

The initial implementation comparison measured 98–108 ms for prepared submission
and 1,222–2,079 ms for immediate submission. A subsequent validation before the
last initial-send guard measured 94–184 ms and 1,714–2,982 ms respectively, with
helper-text-to-panel latency as high as 754 ms. All result sets are retained;
the final table is the run after the final safety guard, not the fastest run
selected from each condition. Final helper-text-to-panel latency was 18–122 ms.
No p95, universal speedup,
live first-answer guarantee or CPU reduction is inferred from these small samples.
The change removes an unnecessary full-load gate and overlaps actual startup
with user typing; it cannot accelerate model thinking or browser freezing.

Raw local evidence (ignored generated artifacts):

- `.test-artifacts/startup-0.1.6.json`: unchanged-runtime baseline.
- `.test-artifacts/startup-0.1.7-initial.json`: initial implementation comparison.
- `.test-artifacts/startup-0.1.7-pre-guard.json`: subsequent, more variable run.
- `.test-artifacts/startup-0.1.7.json`: final validation and native-expiry case.

The helper still costs a second ChatGPT page's memory. Preparation moves that
cost earlier; unused-helper expiry bounds normal unused lifetime. No whole-browser
CPU, memory or battery benchmark was performed. Setup observers disconnect when
ready or failed; ordinary streaming still uses the established active-answer path.

## Files and verification

- `background.js`: shared preparation job, committed-document wait, warm probes,
  document targeting, expiry/cleanup, and content-free startup timestamps.
- `agent.js`: separate preparation/empty-helper checks, protocol handshake,
  cancellable early DOM waits and native-send timestamp. A new initial-send guard
  refuses a prepared route that changed or acquired native messages. The response
  streaming watcher and the existing follow-up proof algorithm are retained.
- `content.js`: deliberate-opening preparation, preserved manual pasted context,
  pending-open cleanup and existing Keep applicability. Visual styles unchanged.
- `tests/agent.test.cjs`, `tests/background.test.cjs`: preparation, cancellation,
  document targeting, warm reuse, restart, setup recovery and safe expiry.
- `scripts/startup-regressions.cjs`, `scripts/browser-smoke.cjs`,
  `scripts/helper-regressions.cjs`, `scripts/ui-regressions.cjs`,
  `tests/fixture.cjs`: controlled benchmark, real expiry/draft/pill restoration,
  native submission timestamps and expectations for preparation on opening.
- `manifest.json`, `package.json`: version 0.1.7; permissions unchanged.
- `scripts/package.cjs`: includes existing checkpoint instructions in the ZIP.
- `README.md`, `PRIVACY.md`: preparation behavior, resource/privacy tradeoff,
  diagnostics, validation limits and update instructions.

161 unit tests and runtime checks pass. Focused offline helper and startup suites
pass, including real alarm-driven expiry with local drafts preserved. The complete
integrated browser suite passes against the final runtime. The package's 15 entries
are decompressed and compared byte-for-byte with source. All four shared libraries,
four icons, both CSS blocks and the complete streaming watcher match v0.1.6.

Current signed-in acceptance remains pending for v0.1.7: reload the extension,
refresh the source page and start a fresh tangent after keeping/copying old work.
Check quick Send, typing then Send, contextual follow-up, code formatting,
minimize/restore, unused-helper expiry, setup gates and cancellation. Record Send
to native submission separately from native generation and panel delivery. The
v0.1.6 signed-in success does not establish v0.1.7 live compatibility.
