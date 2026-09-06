import { Effect } from "effect";

import type { RuntimeClock } from "../services.js";
import type { OperationEvent } from "./model.js";
import { ValidatedEventStore } from "./store.js";
import type { StoredOperationRecord } from "./store.js";

const systemClock: RuntimeClock = {
  now: () => Effect.sync(() => new Date().toISOString()),
  sleep: (milliseconds) => Effect.promise(() => new Promise((resolve) => setTimeout(resolve, milliseconds))),
};

export class InMemoryEventStore extends ValidatedEventStore {
  private readonly records = new Map<string, StoredOperationRecord>();
  private readonly resultBytes = new Map<string, Buffer>();

  constructor(
    private readonly trace: Array<string> = [],
    clock: RuntimeClock = systemClock,
  ) {
    super(clock);
  }

  protected readRecord(operationId: string): Promise<unknown | undefined> {
    return Promise.resolve(this.records.get(operationId));
  }

  protected writeRecord(operationId: string, record: StoredOperationRecord): Promise<void> {
    this.records.set(operationId, structuredClone(record));
    return Promise.resolve();
  }

  protected readResultBytes(operationId: string): Promise<Buffer | undefined> {
    const bytes = this.resultBytes.get(operationId);
    return Promise.resolve(bytes === undefined ? undefined : Buffer.from(bytes));
  }

  protected writeResultBytes(operationId: string, bytes: Buffer): Promise<void> {
    this.resultBytes.set(operationId, Buffer.from(bytes));
    return Promise.resolve();
  }

  protected override didPersistResultBytes(): void {
    this.trace.push("result:bytes-persisted");
  }

  protected override didAppend(event: OperationEvent): void {
    this.trace.push(`event:${JSON.stringify({
      operationId: event.operationId,
      type: event.type,
      seq: event.seq,
      timestamp: event.timestamp,
    })}`);
  }
}
