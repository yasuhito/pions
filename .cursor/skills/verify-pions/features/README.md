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

- **If Herdr is present**: Live delegation proof is REQUIRED for claiming verification success.
- **If Herdr is absent**: USER-PATH VERIFICATION IS BLOCKED. Automated checks only provide partial regression gate coverage.

## How to use feature files

Each feature file includes:

- **Sub-features**: Specific behaviors within the feature
- **How to get to it**: User perspective on accessing/triggering the feature
- **Driving it with harness**: Exact commands to execute
- **Gotchas**: Common pitfalls, environment limitations, failure modes

## Harness types

- **Live Pi/Herdr** (`pions_delegate` in a Pi session) — PRIMARY USER PATH, requires Herdr
- **npm scripts** (`npm run check`, `npm run build`, etc.) — Regression gates, work everywhere
- **Manual inspection** (`ls`, file checks) — Simple verification
- **Code review** (reading implementation/tests) — For behaviors that must fail closed

## Herdr-present vs Herdr-absent verification

### With Herdr (e.g., user's gmktec: Node v26.8.1, /home/yasuhito/.local/bin/herdr, Pi 0.85.1)

- **MUST prove live-delegation** (Feature 1) before claiming success
- Automated checks (Features 2-4) serve as additional regression gates
- Formal-review-fail-closed (Feature 5) proves configuration rejection

### Without Herdr (e.g., most cloud VMs)

- **Live-delegation proof is BLOCKED**
- Automated checks (Features 2-4) provide partial coverage only
- Document clearly: "User-path verification blocked: Herdr unavailable. Automated checks only."
- Do NOT claim end-to-end verification succeeded

## When to use each feature

- **Start with live-delegation** if Herdr is available (PRIMARY)
- **Run automated-test-suite** as regression gate (always, any environment)
- **Verify build-and-extension** to confirm worker extension exists (prerequisite for live delegation)
- **Run type-checking** to catch TypeScript errors early (part of automated-test-suite)
- **Confirm formal-review-fail-closed** to prove tools reject without configuration (behavior check)

Remember: **Automated checks do NOT substitute for live-delegation proof.**
