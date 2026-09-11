import { Cause, Effect, Exit } from "effect";

import { ResourceProofRejectedError } from "../public.js";
import type { EventStore } from "./event-store/index.js";
import type {
  PersistedResourceRecord,
  ResourceEvidenceRepository,
} from "./resource-controller.js";

async function run<Value>(
  effect: Effect.Effect<Value, unknown>
): Promise<Value> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  const failure = Cause.failureOption(exit.cause);
  throw new ResourceProofRejectedError(
    "persistence_failed",
    failure._tag === "Some" && failure.value instanceof Error
      ? failure.value.message
      : Cause.pretty(exit.cause)
  );
}

/** Stores complete resource evidence in the Operation event stream. */
export class EventStoreResourceEvidenceRepository implements ResourceEvidenceRepository {
  constructor(private readonly store: EventStore) {}

  async read(
    operationId: string
  ): Promise<Readonly<PersistedResourceRecord> | undefined> {
    const snapshot = await run(this.store.read(operationId));
    return snapshot.operation.resourceEvidenceRecord;
  }

  async write(
    operationId: string,
    expectedVersion: number | undefined,
    input: Omit<PersistedResourceRecord, "version">
  ): Promise<Readonly<PersistedResourceRecord>> {
    const current = await run(this.store.read(operationId));
    if (current.operation.resourceEvidenceRecord?.version !== expectedVersion) {
      throw new ResourceProofRejectedError(
        "persistence_failed",
        "Resource evidence changed concurrently"
      );
    }
    const record: PersistedResourceRecord = structuredClone({
      ...input,
      version: (expectedVersion ?? 0) + 1,
    });
    const updated = await run(
      this.store.advance(operationId, {
        type: "resource_evidence_recorded",
        record,
      })
    );
    const persisted = updated.operation.resourceEvidenceRecord;
    if (persisted?.version !== record.version) {
      throw new ResourceProofRejectedError(
        "persistence_failed",
        "Resource evidence event was not completely persisted"
      );
    }
    return persisted;
  }
}
