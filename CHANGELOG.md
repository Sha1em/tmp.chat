# Changelog

Notable checkpoints and experiments. Version numbers do not imply store publication or universal compatibility with the current ChatGPT website.

## Repository publication — 19 November 2026

- Default to the v0.1.7 runtime, adding a reader-focused README and local documentation assets.
- Add architecture, development, troubleshooting and contribution guides.
- Preserve checkpoint tags and separate experimental native-submission work.
- Make no application runtime changes for this publication.

## v0.1.9 — Experimental submission work

- Expand observation for in-place composer/control hydration.
- Revalidate composer, owned draft and fresh Send control after the submission checkpoint.
- Add bounded startup diagnostics and regressions.
- Retain the earlier UI/streaming implementation.
- **Status:** experimental; no confirmed live first-response speed gain.

See `fix/hidden-submission-v0.1.9` and its implementation report. This runtime is not on the default branch.

## v0.1.8 — Rejected latency experiment

- Investigated early-answer discovery and hidden-tab timing.
- Real-world regressions led to rollback.
- **Status:** not recommended; retained locally outside the published default branch.

## v0.1.7 — Working startup checkpoint

- Prepare one helper on deliberate panel opening while the user reads/types.
- Use the intended committed document and native readiness rather than waiting for every resource.
- Share preparation with Send; conservatively expire verified-empty unused helpers.
- Preserve v0.1.6 continuity, formatting, streaming and the minimized pill.
- **Remaining concern:** first-question latency; fixture timings are not live-service guarantees.

Preserved as `checkpoint-v0.1.7`. See [STARTUP-v0.1.7.md](STARTUP-v0.1.7.md).

## v0.1.6 — Conservative recovery checkpoint

- Correct identity verification for the observed canonical-route transition.
- Verify a basic signed-in first question and contextual follow-ups on the tested Edge account.
- Preserve streaming, formatting and the native-feeling panel.

Preserved as `stable-v0.1.6`. See [CHECKPOINT.md](CHECKPOINT.md).

## Earlier work

Earlier iterations established selection/manual entry, panel/pill, native Temporary Chat automation, safe formatting and streaming. [Technical notes](docs/TECHNICAL_NOTES.md) retain detailed historical observations; they are not current live-compatibility guarantees.
