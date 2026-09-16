# Feature: Formal Review Fail-Closed

Formal-review tools (`pions_review`, `pions_review_decision`) are registered in the Pi extension but fail closed when no trusted configuration exists. Production formal review is NOT enabled by default.

## Sub-features

1. **Tools are registered** (visible in Pi tool list)
2. **Execution rejects without configuration**
3. **No accidental enablement**

## How to get to it (user perspective)

A user or model attempts to call `pions_review` or `pions_review_decision` in a Pi session. Without trusted host configuration, these tools reject the call with an error.

## Driving it with harness

### Verification strategy

This feature is verified through:

1. **Code review**: Confirm tools are registered in `.pi/extensions/pions.ts` → `src/internal/pi-extension.ts`
2. **Automated tests**: Confirm fail-closed behavior when configuration is absent
3. **Manual inspection**: Attempt to call tools without configuration

### Code review

Read `.pi/extensions/pions.ts` (entry) and `src/internal/pi-extension.ts` (implementation):

- Tools `pions_review` and `pions_review_decision` are registered
- They require trusted formal-review configuration from the integration
- When `options.formalReview` is undefined, unconfigured tool execution throws `WorkerConfigurationError` with code `unsupported_capability` (not a bare `Error`). Incomplete profiles or invalid bootstrap can yield other typed failures (`invalid_profile`, `FormalReviewBootstrapError`, etc.) — do not assume every rejection uses `unsupported_capability`.

### Automated tests

The test suite includes cases for:

- Formal review integration with and without configuration
- Rejection when configuration is missing
- Rejection when profile is incomplete (missing `formal_reviewer` intended use, missing start authorization requirement, etc.) — enforced in `src/internal/worker-configuration.ts` and covered by tests

**Run the formal review tests**:

```bash
npm run build:test
node --test .test-dist/test/formal-review-integration.test.js
```

Expected: Tests pass, including cases that verify rejection without configuration.

### Manual inspection (if Herdr available)

Use the dedicated `verify-pions` Herdr session on the Grok Bot box only — never gmktec, Yasuhito default, or firstmate workspaces:

1. Create a workspace in `verify-pions` with `cwd` = Pions checkout; start Pi: `herdr --session verify-pions agent start … --kind pi --pane <pane-id>`
2. Confirm no trusted formal-review configuration enables production review
3. Attempt to call `pions_review` in that Pi session:
   ```
   Use pions_review to review artifact abc123.
   ```
4. Observe: The tool rejects the call with `WorkerConfigurationError` code `unsupported_capability` and message `Formal review is not enabled by trusted configuration` (for `pions_review_decision`: `Formal review decisions are not enabled by trusted Coordinator configuration`)
5. Close the verify workspace when done

Expected: Call fails, does not create an operation.

## Expected outcome

- Tools are registered and visible
- Calls fail without trusted configuration
- No accidental production enablement

## Gotchas

### Visible but not enabled

The tools appear in Pi's tool list even when unconfigured. This is intentional. The fail-closed check happens at execution time, not registration time.

### Trusted bootstrap required

Formal review enablement comes from the trusted integration (`pions/formal-review` entry point and bootstrap), **not** from a `.pions.json` `formalReview` section — that key is not part of the project config schema. The project parser (`.pions.json`) accepts only a top-level `review` object with `model` and `thinkingLevel`; unknown keys are rejected.

Production enablement requires:

1. A trusted bootstrap that pins module versions, repository identity, and approved resource adapters
2. A complete worker profile with `formal_reviewer` intended use
3. Explicit rollout approval (see `docs/staged-rollout-decision-issue-67.md`)

Without these, formal review remains disabled even if `.pions.json` has a valid `review` section (that section configures the reader/delegation model, not formal review).

### Candidate profiles are not production profiles

You can configure a candidate profile for testing, but that does not enable production formal review. The code enforces this distinction.

### Integration boundary

Trusted host code must use the `pions/formal-review` entry point and provide a trusted bootstrap. The default project extension never enables formal review from `.pions.json` alone.

### Error codes vary by failure mode

- **Unconfigured tool path** (`options.formalReview === undefined`): `WorkerConfigurationError` with code `unsupported_capability` and messages such as `Formal review is not enabled by trusted configuration` or `Formal review decisions are not enabled by trusted Coordinator configuration`.
- **Incomplete profiles, invalid bootstrap, or rollout gates**: other typed failures — e.g. `WorkerConfigurationError` with code `invalid_profile`, or `FormalReviewBootstrapError` from the integration layer. Do not overgeneralize all rejections as `unsupported_capability`.

### Default project extension

The default project extension (`.pi/extensions/pions.ts` → `src/internal/pi-extension.ts`) registers formal-review tools but does NOT enable them. This is safe by design.

### Test doubles

Automated tests use test doubles (`FakeResourceAuthority`, etc.) to simulate trusted configuration. These tests prove that the runtime enforces fail-closed behavior.

### No environment variables

Formal review does NOT read environment variables for configuration. All configuration comes from the trusted bootstrap provided by the integration caller.

### Staged rollout

See `docs/pi-extension.md` and `docs/staged-rollout-decision-issue-67.md` for the formal-review rollout plan. As of this feature map, formal review is NOT enabled in production.
