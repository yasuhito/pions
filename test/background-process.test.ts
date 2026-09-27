import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Effect } from "effect";

import {
  backgroundOwnerEntryPath,
  cancelBackgroundProcess,
  recoverBackgroundProcesses,
  startBackgroundProcess,
} from "../src/internal/background-process.js";
import { PrivateFileEventStore } from "../src/internal/event-store/index.js";
import { writePrivatePrompt } from "../src/internal/repository-state.js";
import {
  advanceTestOperationToRunning,
  FakeClock,
} from "../src/internal/testing.js";
import {
  effectiveConfig,
  maxResultByteCount,
  requestedConfig,
} from "./worker-protocol-fixtures.js";
import type { BackgroundOwnerRequest } from "../src/internal/background-owner.js";

async function fixture(context: { after(cleanup: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), "pions-background-process-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const request: BackgroundOwnerRequest = {
    operationId: "12345678-1234-1234-1234-123456789abc",
    task: {
      background: true,
      promptRef: "private://prompt",
      profile: "coding",
      idempotencyKey: "task-1",
    },
    runtime: {
      cwd: directory,
      stateDirectory: join(directory, "runtime"),
      profiles: {},
    },
  };
  return { directory, request };
}

test("the owner entry comes from the same package as the Worker extension", () => {
  assert.equal(
    backgroundOwnerEntryPath(
      "/consumer/node_modules/pions/dist/src/worker-extension.js"
    ),
    "/consumer/node_modules/pions/dist/src/internal/background-owner-entry.js"
  );
});

test("session recovery restarts a requested background Operation without a saved result", async (context) => {
  const { directory, request } = await fixture(context);
  await writePrivatePrompt(
    join(directory, "requests", `${request.operationId}.background.json`),
    JSON.stringify(request)
  );
  let starts = 0;
  await recoverBackgroundProcesses({
    repositoryRoot: directory,
    repositoryState: directory,
    entryPath: "unused",
    start: async () => {
      starts += 1;
      return request.operationId;
    },
  });

  assert.equal(starts, 1);
});

test("session recovery finishes pending cleanup for an already completed background Operation", async (context) => {
  const { directory, request } = await fixture(context);
  await writePrivatePrompt(
    join(directory, "requests", `${request.operationId}.background.json`),
    JSON.stringify(request)
  );
  const clock = new FakeClock(
    Array.from(
      { length: 30 },
      (_, index) => `2026-09-06T10:00:${String(index).padStart(2, "0")}.000Z`
    )
  );
  const store = new PrivateFileEventStore(
    request.runtime.stateDirectory,
    clock
  );
  await Effect.runPromise(
    store.create({
      operationId: request.operationId,
      task: request.task,
      requestedConfig,
      effectiveConfig,
      maxResultByteCount,
    })
  );
  await advanceTestOperationToRunning(store, request.operationId);
  await Effect.runPromise(
    store.acceptResult({
      operationId: request.operationId,
      acceptanceRequestId: "result-1",
      bytes: Buffer.from("accepted result", "utf8"),
    })
  );
  await Effect.runPromise(
    store.advance(request.operationId, {
      type: "worker_stop_confirmed",
      proof: "worker-stop",
    })
  );
  await Effect.runPromise(
    store.advance(request.operationId, { type: "operation_completed" })
  );
  let starts = 0;
  await recoverBackgroundProcesses({
    repositoryRoot: directory,
    repositoryState: directory,
    entryPath: "unused",
    start: async () => {
      starts += 1;
      return request.operationId;
    },
  });

  assert.equal(starts, 1);
});

test("cancellation reports an Operation made unknown by recovery instead of a connection error", async (context) => {
  const { directory, request } = await fixture(context);
  await writePrivatePrompt(
    join(directory, "requests", `${request.operationId}.background.json`),
    JSON.stringify(request)
  );
  const clock = new FakeClock(
    Array.from(
      { length: 10 },
      (_, index) => `2026-09-06T10:00:${String(index).padStart(2, "0")}.000Z`
    )
  );
  const store = new PrivateFileEventStore(
    request.runtime.stateDirectory,
    clock
  );
  await Effect.runPromise(
    store.create({
      operationId: request.operationId,
      task: request.task,
      requestedConfig,
      effectiveConfig,
      maxResultByteCount,
    })
  );
  const outcome = await cancelBackgroundProcess({
    repositoryRoot: directory,
    repositoryState: directory,
    operationId: request.operationId,
    entryPath: "unused",
    start: async () => {
      await Effect.runPromise(
        store.advance(request.operationId, {
          type: "operation_unknown",
          reason: "liveness-unproven",
        })
      );
      return request.operationId;
    },
  });

  assert.equal(outcome.state, "unknown");
});

test("a detached owner confirms its Operation identifier before the caller returns", async (context) => {
  const { directory, request } = await fixture(context);
  const entryPath = join(directory, "ack.mjs");
  await writeFile(
    entryPath,
    "import {readFileSync} from 'node:fs'; const request=JSON.parse(readFileSync(process.argv[2],'utf8')); process.send({type:'started',operationId:request.operationId},()=>process.disconnect());"
  );
  const id = await startBackgroundProcess({
    entryPath,
    repositoryState: directory,
    request,
  });

  assert.equal(id, request.operationId);
});

test("a detached owner that exits before acknowledgement is not reported as started", async (context) => {
  const { directory, request } = await fixture(context);
  const entryPath = join(directory, "exit.mjs");
  await writeFile(entryPath, "process.exit(1);");
  await assert.rejects(
    startBackgroundProcess({ entryPath, repositoryState: directory, request }),
    /exited before start was confirmed/u
  );
});
