# Feature: Formal Review Tools Are Not Registered

The Pi extension registers exactly three tools: `pions_delegate`, `pions_result`, and `pions_operation`. Formal-review tools are absent from the public extension interface.

## Sub-features

1. **Exactly three tools are registered** by the project extension
2. **Formal-review tools are absent** from the user-facing tool list
3. **No accidental enablement** through `.pions.json`

## How to get to it (user perspective)

A user or model lists the tools in a Pi session with the Pions project extension loaded. `pions_review` and `pions_review_decision` do not appear, so they cannot be called.

## Driving it with harness

### Automated tests

```bash
npm run build:test
node --test .test-dist/test/pi-extension.test.js
```

Expected: tests pass, including "the delegation-only extension registers exactly the three delegation tools", "the delegation-only extension does not register pions_review", and the configuration tests that reject the former `review` block and unknown keys.

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
