# Feature: Build and Extension Readiness

Pions is a TypeScript ESM runtime used through its Pi extension. The build generates `dist/`, the packaged form that npm consumers install. The in-repository development extension (`.pi/extensions/pions.ts`) runs from `src/` and does not need a build.

## Sub-features

1. **TypeScript compilation** (`tsc -p tsconfig.build.json`)
2. **Packaged Worker extension** (`dist/src/worker-extension.js`)

## How to get to it (user perspective)

A developer runs `npm run build` before packing or when checking the packaged form. `resolveWorkerExtensionEntryPath` (`src/internal/worker-extension-entry.ts`) resolves only the sibling Worker extension in the same form as the resolver module: `src/worker-extension.ts` when loaded from source, `dist/src/worker-extension.js` when loaded from the build. It never falls back from source to `dist/`, so a stale `dist/` cannot cause a `Worker configuration version does not match` failure in the development extension.

## Driving it with harness

### Prerequisites

- `npm install` completed

### Exact command

```bash
npm run build
```

This invokes:

```bash
tsc -p tsconfig.build.json
```

### Expected outcome

- Exit code: 0
- `dist/` directory created (if it didn't exist)
- `dist/src/worker-extension.js` exists
- All `.ts` files in `src/` have corresponding `.js` files in `dist/src/`

### Verification

```bash
ls -la dist/src/worker-extension.js
```

The worker extension should exist.

### Evidence capture

```bash
EVIDENCE_DIR="${VERIFY_PIONS_EVIDENCE_DIR:-/tmp/verify-pions-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$EVIDENCE_DIR"
npm run build > "$EVIDENCE_DIR/build.txt" 2>&1
ls -laR dist/ > "$EVIDENCE_DIR/dist-listing.txt"
```

## Gotchas

### dist/ is gitignored

The `dist/` directory is in `.gitignore`. After cloning or pulling, you must rebuild.

### Worker protocol version mismatch

If you change `WORKER_PROTOCOL_VERSION` in `src/internal/worker-protocol.ts` (currently `14`) but forget to rebuild, workers fail with "Worker configuration version does not match".

**Fix**: Always run `npm run build` after protocol changes.

### Clean build

To force a clean rebuild:

```bash
rm -rf dist/ && npm run build
```

### Build vs typecheck

- `npm run build` — Compiles to `dist/`, emits `.js` files
- `npm run typecheck` — Type-checks without emitting files

Both are important. `typecheck` catches type errors; `build` generates runnable code.

### Extension and runtime

Pions has two TypeScript configs:

1. `tsconfig.build.json` — Compiles the internal runtime and worker extension
2. `tsconfig.extension.json` — Type-checks the Pi extension setup (not built separately, imported directly by Pi)

The `npm run build` command uses `tsconfig.build.json`.

### No watch mode

There's no `npm run build:watch`. Rebuild manually after changes.

### Build vs test build (`dist/` vs `.test-dist/`)

- **Packaged path** (packing, npm consumers): requires `npm run build` → `dist/src/worker-extension.js`. The development extension's live Herdr Workers load `src/worker-extension.ts` and need no build.
- **Automated test gate** (`npm run check`, `npm test`): uses `npm run build:test` → `.test-dist/`. Tests import from `../src/...`, not from `dist/`.

Running `npm run build` does **not** populate `.test-dist/`. The test harness invokes `build:test` itself.
