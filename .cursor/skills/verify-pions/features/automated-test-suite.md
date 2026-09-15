# Feature: Automated Test Suite

The full automated gate for Pions: type checking, linting, formatting, test assertion validation, and the complete node:test suite.

## Sub-features

1. **TypeScript type checking** (main + extension configs)
2. **ESLint validation** (syntax and style rules)
3. **Prettier formatting** (checks without modifying)
4. **Test assertion validation** (ensures one-behavior-one-assertion rule)
5. **node:test runner** (all `.test.ts` files in `test/`)

## How to get to it (user perspective)

A developer or agent runs `npm run check` before committing or opening a PR. This is the standard pre-commit gate.

## Driving it with harness

### Prerequisites

- `npm install` completed

### Exact command

```bash
npm run check
```

This runs:

1. `npm run typecheck` — `tsc --noEmit` on main and extension configs
2. `npm run lint` — ESLint on all sources
3. `npm run format:check` — Prettier validation
4. `npm run check:test-assertions` — Custom script to verify test assertion rules
5. `npm test` — Full node:test suite (runs `build:test` → `.test-dist/` first)

### Expected outcome

- Exit code: 0
- All type checks pass
- No lint errors
- No formatting violations
- All test assertions follow the rule
- All tests pass (typically 20+ test files, 100+ test cases)

### Evidence capture

```bash
EVIDENCE_DIR="${VERIFY_PIONS_EVIDENCE_DIR:-/tmp/verify-pions-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$EVIDENCE_DIR"
npm run check > "$EVIDENCE_DIR/npm-check.txt" 2>&1
echo $? >> "$EVIDENCE_DIR/npm-check.txt"
```

The exit code should be 0.

## Gotchas

### No `npm run build` prerequisite

`npm run check` does **not** require `npm run build` first. The test and assertion-check steps invoke `npm run build:test`, which compiles to `.test-dist/` via the default `tsconfig.json`. Tests import from `../src/...`, not from `dist/`.

`npm run build` remains relevant for live Herdr workers and packing (`dist/src/worker-extension.js`), not as a gate for the automated suite.

### Effect error traces

Pions uses Effect for control flow. Test failures include Effect fiber traces, which can be verbose. Look for the top-level assertion failure first.

Example:

```
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
...
```

Focus on the assertion message, not the Effect internals.

### Test assertion rule

Pions tests follow: **one test case = one behavior = one assertion**.

Multiple assertions indicate the test should be split. The `check:test-assertions` script validates this by parsing test files and counting `assert.*` calls per test case.

**If this check fails**: Split the test into multiple test cases, each with one assertion.

### Slow tests

Some tests use `TestClock` from Effect to advance virtual time. These are fast. A few tests may spawn actual subprocesses or touch the filesystem. Total runtime is typically under 10 seconds.

### Transient failures

The test suite is deterministic. If a test fails non-deterministically, it's likely a bug in the test setup (e.g., leaked state between tests) or in the implementation.

### No Herdr/Pi required

The automated test suite uses test doubles (`FakeWorkerAdapter`, `FakePresentation`, etc.) and never requires Herdr or Pi. It works in any Node.js environment.
