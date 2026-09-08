import { createHash } from "node:crypto";

import { Effect } from "effect";

import type { EventStore } from "./event-store/index.js";
import { validateResultAcceptanceManifest } from "./result-acceptance-manifest.js";
import type { RuntimeClock } from "./services.js";
import type { ResultAcceptanceProof } from "./worker-protocol.js";
import type {
  ArtifactFailureReason,
  ArtifactMetadata,
  ArtifactStore,
  ResultAcceptanceManifestFailureReason,
  ResultAcceptanceTransactionFailureReason,
  WorkerProducedArtifact,
  WorkerProducedResult,
} from "../public.js";

export type ResultAcceptanceOutcome =
  | { readonly state: "accepted"; readonly proof: Readonly<ResultAcceptanceProof> }
  | { readonly state: "continuable"; readonly reason: "write_failed" | ArtifactFailureReason }
  | {
      readonly state: "failed";
      readonly terminal: true;
      readonly reason:
        | ArtifactFailureReason
        | ResultAcceptanceManifestFailureReason
        | ResultAcceptanceTransactionFailureReason;
    };

export interface ResultAcceptance {
  accept(
    operationId: string,
    result: Readonly<WorkerProducedResult>,
  ): Effect.Effect<ResultAcceptanceOutcome>;
}

interface ResultAcceptanceDependencies {
  readonly store: EventStore;
  readonly artifacts: ArtifactStore;
  readonly artifactCredential: string;
  readonly clock: RuntimeClock;
  readonly synchronizeArtifactClock?: (timestamp: string) => void;
}

function identifier(prefix: string, ...parts: ReadonlyArray<string>): string {
  const hash = createHash("sha256").update(parts.join("\u0000"), "utf8").digest("hex");
  return `${prefix}.${hash}`;
}

async function materializeArtifact(
  artifact: Readonly<WorkerProducedArtifact>,
): Promise<Readonly<WorkerProducedArtifact> | undefined> {
  const chunks: Array<Buffer> = [];
  let byteCount = 0;
  if (artifact.bytes instanceof Uint8Array) {
    chunks.push(Buffer.from(artifact.bytes));
    byteCount = artifact.bytes.byteLength;
  } else {
    for await (const chunk of artifact.bytes) {
      byteCount += chunk.byteLength;
      if (byteCount > artifact.expectedByteCount) return undefined;
      chunks.push(Buffer.from(chunk));
    }
  }
  const bytes = Buffer.concat(chunks);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (byteCount !== artifact.expectedByteCount || digest !== artifact.expectedDigest) return undefined;
  return { ...artifact, bytes };
}

async function registerArtifact(
  dependencies: ResultAcceptanceDependencies,
  operationId: string,
  acceptanceRequestId: string,
  slot: string,
  artifact: Readonly<WorkerProducedArtifact>,
  deadline: string,
): Promise<Readonly<ArtifactMetadata> | ResultAcceptanceOutcome> {
  const registrationId = identifier("registration", operationId, acceptanceRequestId, slot);
  const status = await dependencies.artifacts.registrationStatus(
    dependencies.artifactCredential,
    registrationId,
  );
  const matches = (candidate: {
    readonly expectedByteCount?: number;
    readonly byteCount?: number;
    readonly digest?: string;
    readonly expectedDigest?: string;
    readonly formatId: string;
    readonly normalizationId: string;
    readonly dependencies: ReadonlyArray<string>;
  }) => (candidate.expectedByteCount ?? candidate.byteCount) === artifact.expectedByteCount &&
    (candidate.digest ?? candidate.expectedDigest) === artifact.expectedDigest &&
    candidate.formatId === artifact.formatId &&
    candidate.normalizationId === artifact.normalizationId &&
    candidate.dependencies.length === 0;
  if (status.kind === "registered") {
    return matches(status.artifact)
      ? status.artifact
      : { state: "failed", terminal: true, reason: "request_mismatch" };
  }
  if (status.kind === "continuable") {
    if (!matches(status.registration)) {
      return { state: "failed", terminal: true, reason: "request_mismatch" };
    }
    const resumed = await dependencies.artifacts.transfer(
      dependencies.artifactCredential,
      registrationId,
      artifact.bytes,
    );
    if (resumed.kind === "registered") return resumed.artifact;
    if (resumed.kind === "continuable") return { state: "continuable", reason: resumed.reason };
    return {
      state: resumed.terminal ? "failed" : "continuable",
      ...(resumed.terminal ? { terminal: true } : {}),
      reason: resumed.reason,
    } as ResultAcceptanceOutcome;
  }
  if (status.reason !== "unauthorized") {
    return {
      state: status.terminal ? "failed" : "continuable",
      ...(status.terminal ? { terminal: true } : {}),
      reason: status.reason,
    } as ResultAcceptanceOutcome;
  }
  const started = await dependencies.artifacts.startRegistration(dependencies.artifactCredential, {
    registrationId,
    expectedByteCount: artifact.expectedByteCount,
    expectedDigest: artifact.expectedDigest,
    formatId: artifact.formatId,
    normalizationId: artifact.normalizationId,
    dependencies: [],
    deadline,
    recoveryBudget: 3,
  });
  if (started.kind === "failed") {
    return { state: started.terminal ? "failed" : "continuable", ...(started.terminal ? { terminal: true } : {}), reason: started.reason } as ResultAcceptanceOutcome;
  }
  if (started.kind === "registered") return started.artifact;
  const transferred = await dependencies.artifacts.transfer(
    dependencies.artifactCredential,
    registrationId,
    artifact.bytes,
  );
  if (transferred.kind === "registered") return transferred.artifact;
  if (transferred.kind === "continuable") return { state: "continuable", reason: transferred.reason };
  return {
    state: transferred.terminal ? "failed" : "continuable",
    ...(transferred.terminal ? { terminal: true } : {}),
    reason: transferred.reason,
  } as ResultAcceptanceOutcome;
}

export function makeResultAcceptance(
  dependencies: ResultAcceptanceDependencies,
): ResultAcceptance {
  return {
    accept: (operationId, produced) => Effect.promise(async () => {
      let snapshot;
      try {
        snapshot = await Effect.runPromise(dependencies.store.read(operationId));
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error
          ? error.code
          : undefined;
        return {
          state: "failed",
          terminal: true,
          reason: code === "not_found"
            ? "operation_not_found"
            : code === "unsupported_schema"
            ? "unsupported_schema"
            : "corrupt_record",
        };
      }
      const declaredByteCount = produced.body.expectedByteCount +
        produced.workProducts.reduce((total, artifact) => total + artifact.expectedByteCount, 0);
      if (
        produced.body.expectedByteCount > snapshot.operation.workProductRequirements.body.maxByteCount ||
        declaredByteCount > snapshot.operation.workProductRequirements.maxTotalByteCount
      ) {
        return { state: "failed", terminal: true, reason: "limit_exceeded" };
      }
      if (snapshot.operation.result !== undefined) {
        const accepted = snapshot.operation.result;
        const materializedBody = await materializeArtifact(produced.body);
        const materializedWorkProducts = await Promise.all(produced.workProducts.map(materializeArtifact));
        if (materializedBody === undefined || materializedWorkProducts.some((artifact) => artifact === undefined)) {
          return { state: "failed", terminal: true, reason: "input_integrity_mismatch" };
        }
        const materialized: WorkerProducedResult = {
          acceptanceRequestId: produced.acceptanceRequestId,
          body: materializedBody,
          workProducts: produced.workProducts.map((artifact, index) => ({
            ...materializedWorkProducts[index]!,
            key: artifact.key,
          })),
        };
        const references = [
          { artifactId: accepted.bodyArtifactId, artifact: materialized.body },
          ...accepted.workProducts.flatMap(({ key, artifactIds }) => artifactIds.map((artifactId, index) => ({
            artifactId,
            artifact: materialized.workProducts.filter((candidate) => candidate.key === key)[index],
          }))),
        ];
        let same = references.length === 1 + materialized.workProducts.length;
        const acceptedArtifacts: Array<Readonly<ArtifactMetadata>> = [];
        for (const reference of references) {
          if (reference.artifact === undefined) { same = false; continue; }
          const retrieved = await dependencies.artifacts.retrieve(
            dependencies.artifactCredential,
            reference.artifactId,
          );
          if (retrieved.kind !== "retrieved") {
            return {
              state: retrieved.terminal ? "failed" : "continuable",
              ...(retrieved.terminal ? { terminal: true } : {}),
              reason: retrieved.reason,
            } as ResultAcceptanceOutcome;
          }
          acceptedArtifacts.push(retrieved.artifact);
          same &&= retrieved.artifact.byteCount === reference.artifact.expectedByteCount &&
            retrieved.artifact.digest === reference.artifact.expectedDigest &&
            retrieved.artifact.formatId === reference.artifact.formatId &&
            retrieved.artifact.normalizationId === reference.artifact.normalizationId;
        }
        if (!same) {
          return {
            state: "failed",
            terminal: true,
            reason: accepted.acceptanceRequestId === produced.acceptanceRequestId
              ? "request_mismatch"
              : "manifest_conflict",
          };
        }
        const joined = await Effect.runPromise(dependencies.store.prepareResultAcceptance({
          preparationId: identifier("acceptance", operationId, produced.acceptanceRequestId),
          operationId,
          acceptanceRequestId: produced.acceptanceRequestId,
          manifest: validateResultAcceptanceManifest({
            formatId: accepted.manifestFormatId,
            normalizationId: "pions.canonical-json.v1",
            bodyArtifactId: accepted.bodyArtifactId,
            requirementSetId: accepted.requirementSetId,
            requirementSetDigest: accepted.requirementsDigest,
            workProducts: accepted.workProducts,
          }, snapshot.operation.workProductRequirements, acceptedArtifacts),
          requirements: snapshot.operation.workProductRequirements,
        }));
        if (joined.kind !== "accepted") {
          return joined.kind === "continuable"
            ? { state: "continuable", reason: joined.reason }
            : { state: "failed", terminal: true, reason: joined.kind === "failed" ? joined.reason : "corrupt_record" };
        }
        const status = await dependencies.artifacts.resultAcceptancePreparationStatus(
          dependencies.artifactCredential,
          joined.acceptance.preparationId,
        );
        if (status.kind === "failed") return {
          state: status.terminal ? "failed" : "continuable",
          ...(status.terminal ? { terminal: true } : {}),
          reason: status.reason,
        } as ResultAcceptanceOutcome;
        if (status.kind === "continuable") return { state: "continuable", reason: "storage_inspection_unavailable" };
        if (status.kind === "aborted") return { state: "failed", terminal: true, reason: "conflict" };
        void dependencies.artifacts.finalizeResultAcceptance(
          dependencies.artifactCredential,
          joined.eventEvidence,
        ).catch(() => undefined);
        return {
          state: "accepted",
          proof: {
            operationId,
            acceptanceId: joined.acceptance.acceptanceId,
            manifestDigest: joined.acceptance.manifestDigest,
            eventSequenceNumber: joined.acceptance.eventSequenceNumber,
          } as ResultAcceptanceProof,
        };
      }
      const artifacts: Array<Readonly<ArtifactMetadata>> = [];
      const now = await Effect.runPromise(dependencies.clock.now());
      dependencies.synchronizeArtifactClock?.(now);
      const deadline = new Date(Date.parse(now) + 60_000).toISOString();
      const body = await registerArtifact(
        dependencies,
        operationId,
        produced.acceptanceRequestId,
        "body",
        produced.body,
        deadline,
      );
      if (!("artifactId" in body)) return body;
      artifacts.push(body);
      const grouped = new Map<string, Array<string>>();
      for (const [index, workProduct] of produced.workProducts.entries()) {
        const registered = await registerArtifact(
          dependencies,
          operationId,
          produced.acceptanceRequestId,
          `work-product.${workProduct.key}.${index}`,
          workProduct,
          deadline,
        );
        if (!("artifactId" in registered)) return registered;
        artifacts.push(registered);
        const ids = grouped.get(workProduct.key) ?? [];
        ids.push(registered.artifactId);
        grouped.set(workProduct.key, ids);
      }
      const manifest = {
        formatId: "pions.result-acceptance-manifest.v1" as const,
        normalizationId: "pions.canonical-json.v1" as const,
        bodyArtifactId: body.artifactId,
        requirementSetId: snapshot.operation.workProductRequirements.requirementSetId,
        requirementSetDigest: snapshot.operation.workProductRequirements.digest,
        workProducts: [...grouped].map(([key, artifactIds]) => ({ key, artifactIds })),
      };
      let validated;
      try {
        validated = validateResultAcceptanceManifest(
          manifest,
          snapshot.operation.workProductRequirements,
          artifacts,
        );
      } catch (error) {
        const reason = typeof error === "object" && error !== null && "reason" in error
          ? error.reason as ResultAcceptanceManifestFailureReason
          : "invalid_manifest";
        return { state: "failed", terminal: true, reason };
      }
      const preparationId = identifier("acceptance", operationId, produced.acceptanceRequestId);
      const reservation = await Effect.runPromise(dependencies.store.prepareResultAcceptance({
        preparationId,
        operationId,
        acceptanceRequestId: produced.acceptanceRequestId,
        manifest: validated,
        requirements: snapshot.operation.workProductRequirements,
      }));
      if (reservation.kind === "failed") return { state: "failed", terminal: true, reason: reservation.reason };
      if (reservation.kind === "continuable") return { state: "continuable", reason: reservation.reason };
      if (reservation.kind === "accepted") {
        const status = await dependencies.artifacts.resultAcceptancePreparationStatus(
          dependencies.artifactCredential,
          reservation.acceptance.preparationId,
        );
        if (status.kind === "failed") {
          return {
            state: status.terminal ? "failed" : "continuable",
            ...(status.terminal ? { terminal: true } : {}),
            reason: status.reason,
          } as ResultAcceptanceOutcome;
        }
        if (status.kind === "continuable") {
          return { state: "continuable", reason: "storage_inspection_unavailable" };
        }
        if (status.kind === "aborted") {
          return { state: "failed", terminal: true, reason: "conflict" };
        }
        void dependencies.artifacts.finalizeResultAcceptance(
          dependencies.artifactCredential,
          reservation.eventEvidence,
        ).catch(() => undefined);
        return {
          state: "accepted",
          proof: {
            operationId,
            acceptanceId: reservation.acceptance.acceptanceId,
            manifestDigest: reservation.acceptance.manifestDigest,
            eventSequenceNumber: reservation.acceptance.eventSequenceNumber,
          } as ResultAcceptanceProof,
        };
      }
      const prepared = await dependencies.artifacts.prepareResultAcceptance(dependencies.artifactCredential, {
        preparationId: reservation.reservation.preparationId,
        operationId,
        acceptanceRequestId: reservation.reservation.acceptanceRequestId,
        manifestDigest: reservation.reservation.manifestDigest,
        requirementsDigest: reservation.reservation.requirementsDigest,
        retentionPolicyDigest: snapshot.operation.resultRetentionPolicy.digest,
        manifest: reservation.reservation.manifest,
      });
      if (prepared.kind === "failed") {
        return { state: prepared.terminal ? "failed" : "continuable", ...(prepared.terminal ? { terminal: true } : {}), reason: prepared.reason } as ResultAcceptanceOutcome;
      }
      if (prepared.kind === "continuable") return { state: "continuable", reason: "transfer_incomplete" };
      if (prepared.kind === "aborted") return { state: "failed", terminal: true, reason: "conflict" };
      const published = await Effect.runPromise(
        dependencies.store.publishResultAcceptance(prepared.preparation.evidence),
      );
      if (published.kind === "failed") return { state: "failed", terminal: true, reason: published.reason };
      if (published.kind === "continuable") return { state: "continuable", reason: published.reason };
      if (published.kind === "prepared") return { state: "continuable", reason: "write_failed" };
      void dependencies.artifacts.finalizeResultAcceptance(
        dependencies.artifactCredential,
        published.eventEvidence,
      ).catch(() => undefined);
      return {
        state: "accepted",
        proof: {
          operationId,
          acceptanceId: published.acceptance.acceptanceId,
          manifestDigest: published.acceptance.manifestDigest,
          eventSequenceNumber: published.acceptance.eventSequenceNumber,
        } as ResultAcceptanceProof,
      };
    }),
  };
}
