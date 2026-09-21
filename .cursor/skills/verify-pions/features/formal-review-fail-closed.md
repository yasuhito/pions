# Feature: Formal Review Tools Are Not Registered

The Pi extension registers exactly three tools: `pions_delegate`, `pions_result`, and `pions_operation`. Formal-review tools (`pions_review`, `pions_review_decision`) are **not** registered by the project extension. They exist only for the retained `pions/formal-review` integration, which registers them when trusted host code passes formal-review configuration, and that integration is scheduled for removal.

## Sub-features

1. **Exactly three tools are registered** by the project extension
2. **Formal-review tools are absent** from the user-facing tool list
3. **No accidental enablement** through `.pions.json`

## How to get to it (user perspective)

A user or model lists the tools in a Pi session with the Pions project extension loaded. `pions_review` and `pions_review_decision` do not appear, so they cannot be called.

## Driving it with harness

### Code review

Read `.pi/extensions/pions.ts` (entry) and `src/internal/pi-extension.ts` (implementation):

- The entry calls `installPionsExtension(pi)` with no options
- `pions_review` and `pions_review_decision` are registered only inside `if (options.formalReview !== undefined)`
- `.pions.json` accepts only top-level `model` and `thinkingLevel`; unknown keys (including the former `review` block and any `formalReview` key) are rejected with `ProjectConfigurationError` `unknown_key`

### Automated tests

```bash
npm run build:test
node --test .test-dist/test/pi-extension.test.js
node --test .test-dist/test/formal-review-integration.test.js
```

Expected: tests pass, including "the delegation-only extension registers exactly the three delegation tools", "the delegation-only extension does not register pions_review", and "an unconfigured integration does not register the formal review tool".

### Manual inspection (if Herdr available)

Use the dedicated `verify-pions` Herdr session on the Grok Bot box only — never gmktec, Yasuhito default, or firstmate workspaces:

1. Create a workspace in `verify-pions` with `cwd` = Pions checkout; start Pi with `--no-extensions --extension <checkout>/.pi/extensions/pions.ts --approve`
2. Ask Pi to list its tools, or attempt `Use pions_review to review artifact abc123.`
3. Observe: no `pions_review` tool exists; Pi cannot call it
4. Close the verify workspace when done

## Expected outcome

- Only `pions_delegate`, `pions_result`, and `pions_operation` are registered
- Formal-review tools are absent
- `.pions.json` cannot enable formal review

## Gotchas

### Integration boundary

Trusted host code that still uses the `pions/formal-review` entry point gets the formal-review tools registered by that integration, not by the project extension. This path is outside the delegation contract and will be removed.

### Old feature description

Earlier versions of this feature described the tools as "registered but fail closed". That is no longer true for the project extension; the tools are not registered at all.
