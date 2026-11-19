# Contributing

The project is currently a private, experimental extension. Access is controlled by its owner. A software license has not yet been selected; discuss substantial contributions and reuse terms before proceeding.

## Before a change

Read the [architecture](docs/ARCHITECTURE.md), [privacy boundaries](PRIVACY.md) and [development guide](docs/DEVELOPMENT.md). Use a focused branch and preserve checkpoint tags.

Explain the concrete failing flow and resulting improvement. Keep selection, submission, streaming, completion and rendering concerns separate where possible.

## Bug reports

Include extension/browser version, reproduction steps, expected/actual behaviour, first question or follow-up, whether the helper has the missing answer, and reviewed diagnostic codes. For layout, include viewport/zoom/sidebar conditions and a redacted harmless example.

Do not post private conversations, credentials, browser profiles or raw storage dumps. Even private repositories can have multiple readers and retained history.

## Patches

1. Make a bounded change and explain its root cause.
2. Add a meaningful regression for changed behaviour or safety boundaries.
3. Run relevant checks; state exactly what was verified.
4. Describe remaining signed-in manual testing.
5. Do not claim live compatibility or speed from fixtures alone.

Preserve these constraints unless a deliberate design discussion changes them:

- One owned helper, one tangent and one in-flight question.
- Positive Temporary verification and document-local continuity.
- No replay of ambiguous native sends.
- No extension AI server, token extraction or private endpoints.
- Bounded state/extraction and safe rendering of untrusted content.
- No runtime dependencies, external fonts or content analytics.
- The compact pill and the intent to keep the original conversation readable.

## Performance

Measure preparation, submission, native answer DOM text, extraction, forwarding and panel update separately. Match prompts/settings and repeat trials. Note visibility and diagnostic tooling. Prefer an evidenced bottleneck over an unmeasured timer or keep-alive change.

## Pull requests

State the problem, resulting behaviour, validation and limits. For selectors, explain the observed native structure and how hidden/legacy or unrelated controls are excluded.
