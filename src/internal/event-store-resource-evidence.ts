import { ResourceProofRejectedError } from "../public.js";
import type { EventStore } from "./event-store/index.js";
import type {
  PersistedResourceRecord,
  ResourceEvidenceRepository,
} from "./resource-controller.js";

/** Resource evidence is outside the one-level delegation event stream. */
export class EventStoreResourceEvidenceRepository implements ResourceEvidenceRepository {
  constructor(_store: EventStore) {}

  async read(
    operationId: string
  ): Promise<Readonly<PersistedResourceRecord> | undefined> {
    void operationId;
    return undefined;
  }

  async write(
    operationId: string,
    expectedVersion: number | undefined,
    input: Omit<PersistedResourceRecord, "version">
  ): Promise<Readonly<PersistedResourceRecord>> {
    void operationId;
    void expectedVersion;
    void input;
    throw new ResourceProofRejectedError(
      "persistence_failed",
      "Resource evidence is not part of delegation lifecycle"
    );
  }
}
