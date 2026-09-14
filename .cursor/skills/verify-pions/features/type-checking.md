# Feature: Type Checking

Pions is fully type-checked with TypeScript. The `npm run typecheck` command validates both the library source and the Pi extension setup without emitting JavaScript.

## Sub-features

1. **Main library types** (`tsconfig.json` — the default config)
2. **Extension types** (`tsconfig.extension.json` — Pi extension setup)

## How to get to it (user perspective)

A developer runs `npm run typecheck` (or the full `npm run check`) to validate type safety before committing.

This is distinct from `npm run build`, which compiles to `dist/`. Typechecking catches errors earlier without emitting files.

## Driving it with harness

### Prerequisites

- `npm install` completed

### Exact command

```bash
npm run typecheck
```

This runs:

```bash
tsc --noEmit && tsc -p tsconfig.extension.json
```

1. `tsc --noEmit` — Type-checks `src/` and `test/` using the default `tsconfig.json`
2. `tsc -p tsconfig.extension.json` — Type-checks the Pi extension setup in `extension/`

### Expected outcome

- Exit code: 0
- No TypeScript errors
- No `.js` files emitted (type-checking only)

Example successful output:

```
(no output if successful)
```

### Evidence capture

```bash
EVIDENCE_DIR="${VERIFY_PIONS_EVIDENCE_DIR:-/tmp/verify-pions-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$EVIDENCE_DIR"
npm run typecheck > "$EVIDENCE_DIR/typecheck.txt" 2>&1
echo $? >> "$EVIDENCE_DIR/typecheck.txt"
```

Exit code should be 0.

## Gotchas

### Two configs

Pions uses two TypeScript configs:

- `tsconfig.json` — Main library and tests
- `tsconfig.extension.json` — Pi extension setup

Both must pass. If one fails, the entire `npm run typecheck` fails.

### Effect types

Pions uses `effect` extensively. Effect types can be verbose (e.g., `Effect<Result, PersistenceError | SpawnError, Runtime>`). Type errors may include long union types.

**When reading type errors**: Focus on the base error message, not the full Effect type signature.

### Strict mode

Pions uses `strict: true` in `tsconfig.json`. This includes:

- `strictNullChecks`
- `strictFunctionTypes`
- `noImplicitAny`
- `noImplicitThis`

All sources must satisfy strict TypeScript.

### Test types

Tests import from `../src/` and use `node:assert/strict` and `node:test`. These are typed via `@types/node`.

If tests fail to type-check, check:

1. Is `@types/node` installed?
2. Does the test import the correct types from `src/`?

### No type-only imports required

Pions uses modern TypeScript with `module: "node16"`. Type-only imports (`import type { ... }`) are recommended but not strictly required. The type checker distinguishes types from values automatically.

### Extension dependencies

The Pi extension setup (`extension/index.ts`) depends on:

- `@earendil-works/pi-coding-agent` — Provides Pi extension API types
- `effect` — For functional programming types
- Pions internal types from `src/`

If the extension fails to type-check, ensure these packages are installed.

### No runtime execution

`npm run typecheck` does NOT execute code. It only validates types. To prove runtime behavior, use `npm test` or live delegation.
