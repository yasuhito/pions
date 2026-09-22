import { Effect } from "effect";

import type { RuntimeClock } from "../services.js";
import type { OperationEvent } from "./model.js";
import { ValidatedEventStore } from "./store.js";
import type { StoredOperationRecord } from "./store.js";

const systemClock: RuntimeClock = {
  now: () => Effect.sync(() => new Date().toISOString()),
  sleep: (milliseconds) =>
    Effect.promise(
      () => new Promise((resolve) => setTimeout(resolve, milliseconds))
    ),
  monotonicMilliseconds: () => performance.now(),
  recoveredElapsedTimeIsReliable: () => false,
};

export class InMemoryEventStore extends ValidatedEventStore {
  private readonly records = new Map<string, StoredOperationRecord>();
  private readonly resultBodies = new Map<string, Uint8Array>();

  constructor(
    private readonly trace: Array<string> = [],
    clock: RuntimeClock = systemClock
  ) {
    super(clock);
  }

  protected readRecord(operationId: string): Promise<unknown | undefined> {
    return Promise.resolve(this.records.get(operationId));
  }

  protected writeRecord(
    operationId: string,
    record: StoredOperationRecord
  ): Promise<void> {
    this.records.set(operationId, structuredClone(record));
    return Promise.resolve();
  }

  protected writeResultBody(
    operationId: string,
    bytes: Uint8Array
  ): Promise<void> {
    this.resultBodies.set(operationId, Uint8Array.from(bytes));
    return Promise.resolve();
  }

  protected readResultBytes(
    operationId: string
  ): Promise<Uint8Array | undefined> {
    const bytes = this.resultBodies.get(operationId);
    return Promise.resolve(
      bytes === undefined ? undefined : Uint8Array.from(bytes)
    );
  }

  protected listOperationIds(): Promise<ReadonlyArray<string>> {
    return Promise.resolve([...this.records.keys()].sort());
  }

  protected override didAppend(event: OperationEvent): void {
    this.trace.push(
      `event:${JSON.stringify({
        operationId: event.operationId,
        type: event.type,
        seq: event.seq,
        timestamp: event.timestamp,
      })}`
    );
  }
}
