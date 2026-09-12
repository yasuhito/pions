import { isDeepStrictEqual } from "node:util";

import {
  ResourceProofRejectedError,
  type PermissionManifest,
  type ReviewInputClosureOutcome,
  type ReviewInputPreparationConnection,
  type ReviewInputPreparationOutcome,
  type ReviewInputReadiness,
  type ResourceWorkspace,
} from "../public.js";
import { makeReviewInputReadiness } from "./review-input-readiness.js";
import { sha256Digest } from "./result-digest.js";

export interface OperationReviewInputTarget {
  readonly operationId: string;
  readonly acquisitionId: string;
  readonly workspace: Readonly<ResourceWorkspace>;
  readonly authorityId: string;
  readonly authorityRegistrationId: string;
  readonly authorityGeneration: string;
  readonly permissionManifestDigest: `sha256:${string}`;
  readonly writePermission: Readonly<PermissionManifest["write"]>;
  readonly connection: ReviewInputPreparationConnection;
  confirmCurrentAuthority(): Promise<void>;
}

type RetrievedReviewInput = Extract<
  ReviewInputClosureOutcome,
  { readonly kind: "retrieved" }
>;
type PreparedReviewInput = Extract<
  ReviewInputPreparationOutcome,
  { readonly kind: "prepared" }
>;

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

function requestFor(
  closure: Readonly<RetrievedReviewInput>,
  target: Readonly<OperationReviewInputTarget>
) {
  return {
    operationId: target.operationId,
    acquisitionId: target.acquisitionId,
    workspace: target.workspace,
    registrationEvidenceId: closure.registrationEvidenceId,
    registrationEvidenceDigest: closure.registrationEvidenceDigest,
    collectionDigest: closure.collectionDigest,
    root: { artifact: closure.root, bytes: closure.rootBytes },
    files: closure.files,
  } as const;
}

function verifyClosure(closure: Readonly<RetrievedReviewInput>): void {
  if (
    closure.rootBytes.byteLength !== closure.root.byteCount ||
    sha256Digest(closure.rootBytes) !== closure.root.digest
  ) {
    reject("binding_mismatch", "Review input root bytes are not verified");
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
}

function verifyPrepared(
  closure: Readonly<RetrievedReviewInput>,
  target: Readonly<OperationReviewInputTarget>,
  outcome: Readonly<PreparedReviewInput>
): void {
  if (
    outcome.operationId !== target.operationId ||
    outcome.acquisitionId !== target.acquisitionId ||
    outcome.workspaceId !== target.workspace.workspaceId ||
    outcome.workspaceDedicatedToOperationId !== target.operationId ||
    outcome.collectionDigest !== closure.collectionDigest ||
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
}

function readinessFor(
  closure: Readonly<RetrievedReviewInput>,
  target: Readonly<OperationReviewInputTarget>
): Readonly<ReviewInputReadiness> {
  return makeReviewInputReadiness({
    operationId: target.operationId,
    registrationEvidenceId: closure.registrationEvidenceId,
    registrationEvidenceDigest: closure.registrationEvidenceDigest,
    collectionDigest: closure.collectionDigest,
    authorityId: target.authorityId,
    authorityRegistrationId: target.authorityRegistrationId,
    authorityGeneration: target.authorityGeneration,
    acquisitionId: target.acquisitionId,
    workspaceId: target.workspace.workspaceId,
    inputPath: target.workspace.normalizedPath,
    permissionManifestDigest: target.permissionManifestDigest,
    writePermission: target.writePermission,
    files: closure.files.map(({ path, byteCount, digest }) => ({
      path,
      byteCount,
      digest,
    })),
    writingClosed: true,
  });
}

async function requirePreparedOutcome(
  action: () => Promise<ReviewInputPreparationOutcome>
): Promise<Readonly<PreparedReviewInput>> {
  let outcome;
  try {
    outcome = await action();
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
  return outcome;
}

export async function prepareReviewInput(
  closure: Readonly<RetrievedReviewInput>,
  target: Readonly<OperationReviewInputTarget>
): Promise<Readonly<ReviewInputReadiness>> {
  if (
    closure.operationId !== target.operationId ||
    target.workspace.pionsMayDelete !== false
  ) {
    reject(
      "binding_mismatch",
      "Review input is bound to a different Operation"
    );
  }
  verifyClosure(closure);
  await target.confirmCurrentAuthority();
  const outcome = await requirePreparedOutcome(() =>
    target.connection.prepare(requestFor(closure, target))
  );
  verifyPrepared(closure, target, outcome);
  await target.confirmCurrentAuthority();
  return readinessFor(closure, target);
}

export async function revalidateReviewInput(
  closure: Readonly<RetrievedReviewInput>,
  target: Readonly<OperationReviewInputTarget>,
  expected: Readonly<ReviewInputReadiness>
): Promise<void> {
  verifyClosure(closure);
  await target.confirmCurrentAuthority();
  const outcome = await requirePreparedOutcome(() =>
    target.connection.inspect(requestFor(closure, target))
  );
  verifyPrepared(closure, target, outcome);
  if (!isDeepStrictEqual(readinessFor(closure, target), expected)) {
    reject("binding_mismatch", "Review input readiness is no longer current");
  }
  await target.confirmCurrentAuthority();
}
