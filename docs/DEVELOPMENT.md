# Development

[← Overview](../README.md) · [Architecture](ARCHITECTURE.md) · [Contributing](../CONTRIBUTING.md)

## Setup

Use Node.js **22 or later**. There are no npm dependencies, framework bundle or required build step.

```sh
git clone https://github.com/Sha1em/tmp.chat.git
cd tmp.chat
npm run check
npm test
```

The repository is private; Git must authenticate as an account with access. Never put tokens into remote URLs or commit them into configuration.

Load the repository root as an unpacked extension. After runtime edits, reload the extension and refresh ChatGPT. Keep/copy useful tangents and start a new one before testing a changed helper adapter.

## Verification

| Command | Purpose |
| --- | --- |
| `npm run check` | Parse runtime scripts, validate manifest/icons and check host/dependency boundaries. |
| `npm test` | Run Node's unit/regression tests. |
| `npm run test:browser` | Isolated Chromium, real extension, offline ChatGPT fixtures. |
| `npm run package` | Create the allowlisted extension ZIP in `dist/`. |

On restricted Windows PowerShell, use `npm.cmd`. No `npm install` is required.

Focused browser suites:

```sh
node scripts/browser-smoke.cjs --helper-only
node scripts/browser-smoke.cjs --startup-only
node scripts/browser-smoke.cjs --streaming-only
```

Set `TMP_CHAT_BROWSER` to an Edge/Chromium executable if automatic detection fails:

```powershell
$env:TMP_CHAT_BROWSER = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
npm.cmd run test:browser
```

Tests use their own profile. ChatGPT requests are intercepted and served from local fixtures. Screenshots/timings go to ignored `.test-artifacts/` directories. Do not publish personal profiles or captured private chats as artifacts.

### Evidence boundaries

| Evidence | What it establishes |
| --- | --- |
| Unit tests | Tested logic and modeled failure states. |
| Browser fixtures | Integration against controlled DOM/hydration/scheduling scenarios. |
| Fixture timings | Time in that particular artificial workload/configuration. |
| Signed-in testing | A specific real account/browser flow worked at that time. |

Fixtures do not prove current ChatGPT compatibility, universal latency, every native format or server-side retention. Keep these claims separate.

## Manual acceptance

1. Reload the extension and refresh the source page.
2. Select one assistant passage and open `tmp.chat()`.
3. Ask a harmless first question while leaving the helper inactive; check first text and the final answer.
4. Ask a contextual follow-up in the same conversation.
5. Check code indentation and text after the code block.
6. Minimize, expand and resize; inspect collisions with text, media and the native composer.
7. Inspect unsupported content through the existing helper.
8. Preserve useful text, then test the intended Keep/Discard lifecycle.

For performance comparisons, match question, context size and actual native model/effort. Repeat trials and report variability, helper visibility, energy settings and DevTools attachment. Measure submission separately from extraction/forwarding. A panel DOM update is not physical paint.

## Packaging

```sh
npm run package
```

The file list is explicit in [`scripts/package.cjs`](../scripts/package.cjs). Tests, profiles, research exports and backups are excluded. `dist/` is generated and untracked.

The package contains the extension and selected root documents, rather than this entire documentation tree. Read architecture/development guides in the repository. GitHub's **Download ZIP** contains tracked source/docs, not generated `dist/` output.

## Branches and recovery

| Ref | Purpose |
| --- | --- |
| GitHub `main` | v0.1.7 runtime plus repository documentation. |
| `checkpoint-v0.1.7` | Working-source checkpoint before publication documentation. |
| `stable-v0.1.6` | Earlier conservative recovery checkpoint. |
| `fix/hidden-submission-v0.1.9` | Experimental native readiness/submission investigation. |

Use a focused branch. Preserve recovery tags and avoid force-pushing them. The rejected v0.1.8 experiment is not the recommended default.

Inspect a checkpoint without changing current work:

```sh
git worktree add --detach ../tmp-chat-v0.1.7 checkpoint-v0.1.7
```

Choose a new destination if it exists. Recovery does not require `git reset --hard` or `git clean`.

## Native adapters

Native setup/selectors are concentrated in `agent.js`; selection in `lib/selection.js`; complete-answer extraction in `lib/answer.js`.

Prefer a bounded change with a reproducing regression. Native pages may contain hidden legacy editors, remounted composers, delayed roles, rewritten text and split response containers. Preserve exact draft ownership, Temporary verification and continuity.

Do not reduce latency by bypassing verification, replaying uncertain sends, extracting credentials, calling private endpoints or synthesizing activity to evade browser scheduling protections.

## Repository hygiene

`.gitignore` excludes generated output, browser profiles, local backups/research, credentials and editor configuration. It does not remove previously committed secrets; inspect history before sharing new refs.

Log fixed phases, timings, counts, visibility and codes. Do not log selected text, prompts/answers, native IDs, authentication data or page dumps. See [troubleshooting](TROUBLESHOOTING.md).
