# Pions Feature Map

This directory contains detailed verification guides for Pions features. Each file describes how to drive, observe, and verify a specific capability.

## Feature files

1. **[automated-test-suite.md](automated-test-suite.md)** — Full automated test harness (`npm run check`)
2. **[build-and-extension.md](build-and-extension.md)** — Build artifacts and worker extension readiness
3. **[type-checking.md](type-checking.md)** — TypeScript compilation and type safety
4. **[live-delegation.md](live-delegation.md)** — Live Pi worker delegation via `pions_delegate` (requires Herdr)
5. **[formal-review-fail-closed.md](formal-review-fail-closed.md)** — Formal-review tools reject calls when unconfigured

## How to use feature files

Each feature file includes:

- **Sub-features**: Specific behaviors within the feature
- **How to get to it**: User perspective on accessing/triggering the feature
- **Driving it with harness**: Exact commands to execute
- **Gotchas**: Common pitfalls, environment limitations, failure modes

## Harness types

- **npm scripts** (`npm run check`, `npm run build`, etc.) — Safest, work everywhere
- **Manual inspection** (`ls`, file checks) — Simple verification
- **Live Pi/Herdr** (`pions_delegate` in a Pi session) — Requires Herdr, unavailable in most cloud VMs
- **Code review** (reading implementation/tests) — For behaviors that must fail closed

## Cloud VM limitations

Most cloud environments lack:

- Herdr (required for visible worker panes)
- Authenticated user Pi sessions
- Interactive TUI capabilities

Features requiring Herdr will fail with `HerdrPreconditionError`. Document this limitation rather than trying to work around it.
