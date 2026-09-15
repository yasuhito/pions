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
- If configuration is absent or incomplete, calls fail with `unsupported_capability`

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

1. Start Pi in Herdr (in the Pions project)
2. Confirm no `.pions.json` formal-review configuration exists (or that it's incomplete)
3. Attempt to call `pions_review`:
   ```
   Use pions_review to review artifact abc123.
   ```
4. Observe: The tool rejects the call with `unsupported_capability` and message `Formal review is not enabled by trusted configuration`

Expected: Call fails, does not create an operation.

## Expected outcome

- Tools are registered and visible
- Calls fail without trusted configuration
- No accidental production enablement

## Gotchas

### Visible but not enabled

The tools appear in Pi's tool list even when unconfigured. This is intentional. The fail-closed check happens at execution time, not registration time.

### Trusted bootstrap required

Even if `.pions.json` includes a `formalReview` section, production enablement requires:

1. A trusted bootstrap that pins module versions, repository identity, and approved resource adapters
2. A complete worker profile with `formal_reviewer` intended use
3. Explicit rollout approval (see `docs/staged-rollout-decision-issue-67.md`)

Without these, formal review remains disabled.

### Candidate profiles are not production profiles

You can configure a candidate profile for testing, but that does not enable production formal review. The code enforces this distinction.

### Integration boundary

Trusted host code must use the `pions/formal-review` entry point and provide a trusted bootstrap. The extension never enables formal review directly from `.pions.json`.

### Default project extension

The default project extension (`.pi/extensions/pions.ts` → `src/internal/pi-extension.ts`) registers formal-review tools but does NOT enable them. This is safe by design.

### Test doubles

Automated tests use test doubles (`FakeResourceAuthority`, etc.) to simulate trusted configuration. These tests prove that the runtime enforces fail-closed behavior.

### No environment variables

Formal review does NOT read environment variables for configuration. All configuration comes from the trusted bootstrap provided by the integration caller.

### Staged rollout

See `docs/pi-extension.md` and `docs/staged-rollout-decision-issue-67.md` for the formal-review rollout plan. As of this feature map, formal review is NOT enabled in production.
