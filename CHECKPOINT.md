# Stable checkpoint: tmp.chat v0.1.6

Recorded: 4 November 2026 (Asia/Calcutta).
Git tag: `stable-v0.1.6`.

This captures the working version before first-question startup optimizations.
The user reports reliable live streaming, follow-ups, formatting and conversation
identity. Their observed first-question latency is approximately 15–20 seconds,
with subsequent questions approximately 2–5 seconds. These are user observations,
not a controlled performance benchmark.

Application code is unchanged by checkpoint creation. Source, icons, tests,
development scripts, manifest, package metadata and product documentation are
tracked. Generated packages, test artifacts, browser profiles, research exports
and secrets are excluded. The tag records source files, not a signed-in browser
session or temporary conversation.

## Open the stable version without disturbing ongoing work

From this repository in PowerShell:

```powershell
git worktree add --detach '..\tmp.chat-stable-v0.1.6' stable-v0.1.6
```

Use a new destination if that folder already exists. The stable copy can be
loaded as an unpacked extension. To use it in Edge, disable the development copy,
load the stable folder and refresh ChatGPT. No dependency installation is needed.

If the existing working directory is clean, `git switch --detach stable-v0.1.6`
also opens the checkpoint in place. Preserve later uncommitted work first. Avoid
`git reset --hard` and `git clean` when recovering work.

## Backup and recovery

Checkpoint creation also produces these ignored local backup files:

- `.backups/tmp.chat-stable-v0.1.6.bundle`: Git history and checkpoint references.
- `.backups/tmp.chat-stable-v0.1.6-source.zip`: the tracked checkpoint files.

To recover into a new folder from the bundle:

```powershell
git clone '.backups\tmp.chat-stable-v0.1.6.bundle' '..\tmp.chat-recovered'
git -C '..\tmp.chat-recovered' switch --detach stable-v0.1.6
```

Keep an additional copy of the bundle on another drive or backup service for
protection against loss of this entire folder. No remote is configured or upload
performed as part of this checkpoint. Do not move or force-update the stable tag.
