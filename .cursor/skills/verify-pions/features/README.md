# Pions Feature Map

This directory contains detailed verification guides for Pions features. Each file describes how to drive, observe, and verify a specific capability.

## Feature priority

### PRIMARY USER PATH (Herdr required)

1. **[live-delegation.md](live-delegation.md)** — Live Pi worker delegation via `pions_delegate` (REQUIRED for end-to-end proof)

### REGRESSION GATES (automated checks)

2. **[automated-test-suite.md](automated-test-suite.md)** — Full automated test harness (`npm run check`)
3. **[build-and-extension.md](build-and-extension.md)** — Build artifacts and worker extension readiness
4. **[type-checking.md](type-checking.md)** — TypeScript compilation and type safety

### BEHAVIOR PROOF (no Herdr required)

5. **[formal-review-fail-closed.md](formal-review-fail-closed.md)** — Formal-review tools reject calls when unconfigured

## Critical understanding

**Live delegation is THE primary user path.** Automated tests prove code quality but do NOT prove visible delegation works. Without Herdr, you cannot verify the user experience end-to-end.

- **If Herdr is present on the Grok Bot box**: Live delegation proof is REQUIRED — **only** in session `verify-pions` on that box (never gmktec, Yasuhito default / firstmate / personal panes).
- **If Herdr is absent** (e.g. Cloud Agent): USER-PATH VERIFICATION IS BLOCKED. Do not fall back to gmktec or Yasuhito Herdr. Automated checks only provide partial regression gate coverage.

## How to use feature files

Each feature file includes:

- **Sub-features**: Specific behaviors within the feature
- **How to get to it**: User perspective on accessing/triggering the feature
- **Driving it with harness**: Exact commands to execute
- **Gotchas**: Common pitfalls, environment limitations, failure modes

## Harness types

- **Live Pi/Herdr** (`pions_delegate` on Grok Bot box, `verify-pions` session only) — PRIMARY USER PATH, requires Herdr on the box
- **npm scripts** (`npm run check`, `npm run build`, etc.) — Regression gates, work everywhere
- **Manual inspection** (`ls`, file checks) — Simple verification
- **Code review** (reading implementation/tests) — For behaviors that must fail closed

## Herdr-present vs Herdr-absent verification

### With Herdr on the Grok Bot box (pions eng's machine)

- **MUST prove live-delegation** (Feature 1) in session `verify-pions` on the box before claiming success
- Checkout: `/home/box/Work/pions` or `$HOME/Work/pions` on the box
- All CLI: `herdr --session verify-pions …`; start server with `herdr server --session verify-pions` if needed
- **gmktec:** do not use for daily smoke (Yasuhito default Herdr is forbidden)
- Automated checks (Features 2–4) serve as additional regression gates
- Formal-review-fail-closed (Feature 5) proves configuration rejection

### Without Herdr (e.g. most cloud VMs)

- **Live-delegation proof is BLOCKED**
- **Do NOT** fall back to gmktec or Yasuhito's default Herdr session
- Automated checks (Features 2–4) provide partial coverage only
- Document clearly: "User-path verification blocked: Herdr unavailable. Automated checks only."
- Do NOT claim end-to-end verification succeeded

## When to use each feature

- **Start with live-delegation** on the Grok Bot box (PRIMARY) — `verify-pions` session only; not gmktec
- **Run automated-test-suite** as regression gate (always, any environment)
- **Verify build-and-extension** to confirm worker extension exists (prerequisite for live delegation)
- **Run type-checking** to catch TypeScript errors early (part of automated-test-suite)
- **Confirm formal-review-fail-closed** to prove tools reject without configuration (behavior check)

Remember: **Automated checks do NOT substitute for live-delegation proof.**
