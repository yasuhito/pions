import assert from "node:assert/strict";
import { test } from "node:test";

import { backgroundOperationId } from "../src/internal/repository-state.js";

test("the same background request keeps its Operation identifier", () => {
  assert.equal(
    backgroundOperationId("/repository", "pi-tool:request-1"),
    backgroundOperationId("/repository", "pi-tool:request-1")
  );
});

test("different background requests have different Operation identifiers", () => {
  assert.notEqual(
    backgroundOperationId("/repository", "pi-tool:request-1"),
    backgroundOperationId("/repository", "pi-tool:request-2")
  );
});

test("a background request in a different repository has a different Operation identifier", () => {
  assert.notEqual(
    backgroundOperationId("/repository-a", "pi-tool:request-1"),
    backgroundOperationId("/repository-b", "pi-tool:request-1")
  );
});
