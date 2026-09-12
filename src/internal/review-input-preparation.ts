import { isDeepStrictEqual } from "node:util";

import {
  ResourceProofRejectedError,
  type ReviewInputClosureOutcome,
  type ReviewInputPreparationConnection,
  type ResourceWorkspace,
} from "../public.js";
import { sha256Digest } from "./result-digest.js";

export interface OperationReviewInputTarget {
  readonly operationId: string;
  readonly acquisitionId: string;
  readonly workspace: Readonly<ResourceWorkspace>;
  readonly connection: ReviewInputPreparationConnection;
  confirmCurrentAuthority(): Promise<void>;
}

function validPath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path
      .split("/")
      .every(
        (segment) => segment.length > 0 && segment !== "." && segment !== ".."
      )
  );
}

function reject(
  reason: "binding_mismatch" | "authority_revoked" | "validation_unknown",
  message: string
): never {
  throw new ResourceProofRejectedError(reason, message);
}

export async function prepareReviewInput(
  closure: Extract<ReviewInputClosureOutcome, { readonly kind: "retrieved" }>,
  target: Readonly<OperationReviewInputTarget>
): Promise<void> {
  if (
    closure.operationId !== target.operationId ||
    target.workspace.pionsMayDelete !== false
  ) {
    reject(
      "binding_mismatch",
      "Review input is bound to a different Operation"
    );
  }
  const paths = new Set<string>();
  for (const file of closure.files) {
    if (
      !validPath(file.path) ||
      paths.has(file.path) ||
      file.bytes.byteLength !== file.byteCount ||
      sha256Digest(file.bytes) !== file.digest
    ) {
      reject(
        "binding_mismatch",
        "Review input closure is not a closed verified file set"
      );
    }
    paths.add(file.path);
  }

  await target.confirmCurrentAuthority();
  let outcome;
  try {
    outcome = await target.connection.prepare({
      operationId: target.operationId,
      acquisitionId: target.acquisitionId,
      workspace: target.workspace,
      registrationEvidenceId: closure.registrationEvidenceId,
      registrationEvidenceDigest: closure.registrationEvidenceDigest,
      files: closure.files,
    });
  } catch {
    reject(
      "validation_unknown",
      "Review input preparation could not be inspected"
    );
  }
  if (outcome.kind !== "prepared") {
    reject(
      outcome.kind === "denied" ? "authority_revoked" : "validation_unknown",
      "Review input preparation was not authorized"
    );
  }
  if (
    outcome.operationId !== target.operationId ||
    outcome.acquisitionId !== target.acquisitionId ||
    outcome.workspaceId !== target.workspace.workspaceId ||
    outcome.writingClosed !== true ||
    outcome.files.length !== closure.files.length
  ) {
    reject("binding_mismatch", "Prepared review input has different bindings");
  }
  const expected = new Map(
    closure.files.map((file) => [file.path, file.bytes])
  );
  const observedPaths = new Set<string>();
  for (const file of outcome.files) {
    const bytes = expected.get(file.path);
    if (
      bytes === undefined ||
      observedPaths.has(file.path) ||
      !isDeepStrictEqual(file.bytes, bytes)
    ) {
      reject(
        "binding_mismatch",
        "Prepared review input differs from the verified closure"
      );
    }
    observedPaths.add(file.path);
  }
  await target.confirmCurrentAuthority();
}
