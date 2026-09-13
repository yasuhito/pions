# Feature: Build and Extension Readiness

Pions is a TypeScript ESM library. Before using the Pi extension, you must build the project to generate `dist/`, which includes the internal worker extension loaded by visible workers.

## Sub-features

1. **TypeScript compilation** (`tsc -p tsconfig.build.json`)
2. **Main entry point** (`dist/src/index.js`)
3. **Formal-review entry point** (`dist/src/formal-review.js`)
4. **Worker extension** (`dist/src/worker-extension.js`)

## How to get to it (user perspective)

A developer runs `npm run build` after cloning the repo or after changing any source file. The extension then loads the built worker extension from `dist/`.

If you skip this step and try to use `pions_delegate`, the worker fails with:

```
Worker configuration version does not match
```

This happens because the host extension reads the source version, but the worker extension reads the stale `dist/` version.

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
- `dist/src/index.js` exists
- `dist/src/formal-review.js` exists
- `dist/src/worker-extension.js` exists
- All `.ts` files in `src/` have corresponding `.js` files in `dist/src/`

### Verification

```bash
ls -la dist/src/index.js
ls -la dist/src/formal-review.js
ls -la dist/src/worker-extension.js
```

All three should exist.

### Evidence capture

```bash
npm run build > /opt/cursor/artifacts/verify-pions-$(date +%Y%m%d-%H%M%S)/build.txt 2>&1
ls -laR dist/ > /opt/cursor/artifacts/verify-pions-$(date +%Y%m%d-%H%M%S)/dist-listing.txt
```

## Gotchas

### dist/ is gitignored

The `dist/` directory is in `.gitignore`. After cloning or pulling, you must rebuild.

### Worker protocol version mismatch

If you change `WORKER_CONFIGURATION_VERSION` in the source but forget to rebuild, workers fail with "Worker configuration version does not match".

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

### Extension vs library

Pions has two TypeScript configs:

1. `tsconfig.build.json` — Compiles the library (main entry + formal-review entry + worker extension)
2. `tsconfig.extension.json` — Type-checks the Pi extension setup (not built separately, imported directly by Pi)

The `npm run build` command uses `tsconfig.build.json`.

### No watch mode

There's no `npm run build:watch`. Rebuild manually after changes.

### Build artifacts in tests

Some automated tests import from `dist/`. If you run `npm test` before `npm run build`, those tests fail.

**Fix**: Always build before testing.
