# v0.1.9: hidden-helper submission

Based on `checkpoint-v0.1.7` (`a3417e4`), on branch
`fix/hidden-submission-v0.1.9`. The rejected v0.1.8 branch and both older
checkpoint tags remain intact. No v0.1.8 completion or delivery changes are
included. This is a targeted submission fix, not a proven live latency result.

## Observation and research

The user reports that activating the helper appears to cause the question to
load and submit. This shifts the investigation to preparation/submission before
answer mirroring. It does not establish whether native hydration, draft input,
Send enablement, or native request processing is delayed.

The source contains no intentional foreground gate, requestAnimationFrame, or
polling loop before Send. It does contain two reproducible defects:

1. `until()` subscribed to structure and some attributes, but not existing text
   nodes or composer/control identity attributes. An existing node can become a
   recognized editor, Send button or Temporary Chat heading without inserting
   another node. The old wait misses those changes until some unrelated mutation
   or its deadline. A foreground-triggered native update could accidentally wake
   it, but that exact live sequence has not been captured.
2. The Send element was captured before awaiting the worker's durable submission
   checkpoint. Native editor/button replacement during that await could leave a
   detached Send element or a changed draft. The old code clicked without
   resolving and verifying the live controls again.

A third safety gap was found: `emit()` catches transport errors, but the old
submission path did not require a successful checkpoint acknowledgement before
clicking. The new path refuses to click without that acknowledgement.

Browser background scheduling can also delay the native page itself. The fix
neither changes visibility nor bypasses browser scheduling. Relevant references:
[Chrome background timers](https://developer.chrome.com/blog/timer-throttling-in-chrome-88/),
[page lifecycle](https://developer.chrome.com/docs/web-platform/page-lifecycle-api),
and [DOM mutation observers](https://dom.spec.whatwg.org/#mutation-observers).

## Implementation

- Extend readiness subscriptions to character data and relevant identity,
  accessibility and visibility attributes. The observers are disconnected when
  their wait completes or is cancelled. No timer-based readiness polling added.
- Resolve the live composer and enabled Send, verify the exact owned draft,
  Temporary Chat, continuation and absence of native generation after the
  durable checkpoint. Revalidate synchronously before the one click.
- A remount retaining the exact draft can proceed using the new live controls.
  Changed/cleared drafts are never reconstructed or overwritten automatically.
- Require the checkpoint acknowledgement to succeed before native Send.
- Explicit failures before any click restore the worker's prior continuation
  state. Only an explicit Check can retry that setup. A clicked or ambiguous
  request still cannot be replayed automatically.
- Keep response discovery, 120 ms batching, answer extraction, completion rules,
  final formatting, model preference, UI, permissions and helper ownership from
  v0.1.7.

## Local stage timestamps

Preparation and the current request each retain at most 24 stage entries in the
helper adapter. Fields are fixed phase, epoch time, local monotonic elapsed
milliseconds and visibility. No question, context, native identity, URL or token
is recorded. They stay in memory and are not uploaded or checkpointed.

Stages distinguish preparation received/composer ready/Temporary verified/ready;
request received/composer ready/Temporary verified/draft inserted/Send ready;
checkpoint start/end/native click/click return/submission evidence/failure.
Existing worker startup logs cover tab creation, navigation and injection.

From the extension's **service-worker DevTools console**, the following read-only
expression obtains these marks through ordinary extension messaging, without
activating the helper. Collect after the affected attempt to avoid having
DevTools attached during the primary measurement. Do not paste the transcript
or storage object into a public report.

```js
(async () => {
  const saved = await chrome.storage.session.get('tmp.chat.session');
  const owned = saved['tmp.chat.session'];
  if (!owned?.helperTabId) return { ok: false, reason: 'No owned helper' };
  return chrome.tabs.sendMessage(
    owned.helperTabId,
    { type: 'tmp:startup' },
    owned.helperDocumentId ? { documentId: owned.helperDocumentId } : undefined
  );
})()
```

`native-send` records the click attempt, not network acceptance. Submission
evidence is the new user turn, answer or native Stop state; it is not a server
timestamp. An observer callback can itself be delayed by renderer scheduling.
These marks can locate the extension stage, not measure model token generation.

## Verification and remaining acceptance

Unit regressions exercise in-place readiness changes using filter-aware mutation
delivery, remounts during delayed checkpoint acknowledgement, changed drafts,
Temporary Chat loss, native busy state, failed acknowledgements, cancellation,
definite pre-click recovery and bounded content-free marks.

The new `--submission-only` browser suite uses the real unpacked extension and
native DOM mutations on intercepted local fixtures. It checks editor/Send label
changes and an existing Temporary heading text node, without activating the
helper; retained formatting, follow-up reuse, exact draft and one-click behavior;
and editor/button replacement during a delayed checkpoint acknowledgement.
Helper state reads in these cases do not manufacture a user gesture.

Validation completed on 9 November 2026:

- `npm.cmd run check`: manifest and all seven runtime scripts valid.
- `npm.cmd test`: 183 tests passed, zero failures.
- `node scripts/browser-smoke.cjs --submission-only`: both new submission cases
  passed; helper remained hidden/inactive and native Send was clicked once.
- `npm.cmd run test:browser`: full offline Edge suite passed, including streaming,
  code whitespace, final formatting, continuation, selection, responsive layout,
  controls, ownership, cancellation and cleanup.
- `git diff --check`: passed. `content.js`, `lib/answer.js`, `lib/core.js`,
  selection and layout source match the v0.1.7 checkpoint.

The controlled final Send-label change to native fixture submission measured
16 ms in the focused run and 259 ms during the full suite. These are individual
synthetic samples, not a baseline comparison, percentile or live response time.
The current generated report is `.test-artifacts/submission-0.1.9.json`.

The harness is headless and debugger-attached. It does not reproduce ordinary
signed-in Edge scheduling. No live 5-second guarantee or CPU reduction is claimed.

Computer Use could inspect the user's ChatGPT page but stopped at a browser
navigation because it could not verify the current URL. No extension reload or
signed-in question submission was completed through Computer Use.

Manual acceptance: keep/copy useful tangents, reload the extension, refresh
ChatGPT and begin a fresh tangent. Submit while keeping the helper inactive.
Check first text, final code formatting, automatic completion and a follow-up.
If delayed, preserve the local marks before discarding; compare where the
question was waiting. Native page hydration that actually depends on foreground
execution may remain unresolved by these changes.

## Rollback

With a clean working tree, `git switch perf/startup-v0.1.7` restores the previous
source without deleting this branch. `checkpoint-v0.1.7` remains its exact tag;
`stable-v0.1.6` is also unchanged. Avoid destructive resets and cleanup commands.
Reload the extension and refresh ChatGPT after switching versions.
