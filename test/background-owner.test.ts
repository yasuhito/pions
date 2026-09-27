import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  requestBackgroundCancellation,
  runBackgroundOwner,
  type BackgroundOwnerRequest,
} from "../src/internal/background-owner.js";
import type {
  OperationHandle,
  OperationReader,
  OperationRuntime,
} from "../src/internal/types.js";
import type { VisibleRuntimeOptions } from "../src/internal/visible-runtime.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(context: { after(cleanup: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), "pions-background-owner-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const request: BackgroundOwnerRequest = {
    operationId: "operation-1",
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
  const finishing = deferred();
  let cancellations = 0;
  const fake: OperationRuntime = {
    ready: async () => undefined,
    close: async () => undefined,
    operation: async (): Promise<OperationReader> => {
      throw new Error("unused");
    },
    spawn: async (): Promise<OperationHandle> => ({
      operationId: request.operationId,
      result: async () => {
        await finishing.promise;
        throw new Error("worker failed");
      },
      cancel: async () => {
        cancellations += 1;
        return { cancellationEpoch: 1, state: "cancelled" };
      },
      read: async () => {
        throw new Error("unused");
      },
      readResult: async () => {
        throw new Error("unused");
      },
      readResultChunk: async () => {
        throw new Error("unused");
      },
    }),
  };
  return { request, fake, finishing, cancellationCount: () => cancellations };
}

test("the background owner returns the persisted identifier before Worker completion", async (context) => {
  const { request, fake, finishing } = await fixture(context);
  let started!: (operationId: string) => void;
  const reported = new Promise<string>((resolve) => {
    started = resolve;
  });
  const running = runBackgroundOwner(
    request,
    async (id) => started(id),
    () => fake
  );
  const id = await reported;
  finishing.resolve();
  await running;

  assert.equal(id, request.operationId);
});

test("another owner cannot run the same Operation while it is owned", async (context) => {
  const { request, fake, finishing } = await fixture(context);
  let started!: () => void;
  const reported = new Promise<void>((resolve) => {
    started = resolve;
  });
  const first = runBackgroundOwner(
    request,
    async () => started(),
    () => fake
  );
  await reported;
  try {
    await assert.rejects(
      runBackgroundOwner(
        request,
        async () => undefined,
        () => fake
      ),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "EADDRINUSE"
    );
  } finally {
    finishing.resolve();
    await first;
  }
});

test("an authorized cancellation reaches the independent Operation owner", async (context) => {
  const { request, fake, finishing } = await fixture(context);
  let started!: () => void;
  const reported = new Promise<void>((resolve) => {
    started = resolve;
  });
  const running = runBackgroundOwner(
    request,
    async () => started(),
    () => fake
  );
  await reported;
  try {
    const outcome = await requestBackgroundCancellation(request);
    assert.equal(outcome.state, "cancelled");
  } finally {
    finishing.resolve();
    await running;
  }
});

test("cancellation arriving before the owner activates its handle waits for the Worker", async (context) => {
  const { request, fake, finishing } = await fixture(context);
  const spawnGate = deferred();
  let ownerReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    ownerReady = resolve;
  });
  const running = runBackgroundOwner(
    request,
    async () => undefined,
    () => {
      ownerReady();
      return {
        ...fake,
        spawn: async (task) => {
          await spawnGate.promise;
          return fake.spawn(task);
        },
      };
    }
  );
  await ready;
  const cancelled = requestBackgroundCancellation(request);
  void cancelled.catch(() => undefined);
  try {
    await delay(100);
    spawnGate.resolve();
    const outcome = await cancelled;
    assert.equal(outcome.state, "cancelled");
  } finally {
    spawnGate.resolve();
    finishing.resolve();
    await running;
    await cancelled.catch(() => undefined);
  }
});

test("a cancellation without the repository capability cannot stop its Worker", async (context) => {
  const { request, fake, finishing, cancellationCount } =
    await fixture(context);
  let started!: () => void;
  const reported = new Promise<void>((resolve) => {
    started = resolve;
  });
  const running = runBackgroundOwner(
    request,
    async () => started(),
    () => fake
  );
  await reported;
  try {
    const directory = await realpath(request.runtime.stateDirectory);
    const key = await readFile(join(directory, "background-owner.v1.key"));
    const address = `\0pions-owner-${createHash("sha256")
      .update(key)
      .update(directory)
      .update("\0")
      .update(request.operationId)
      .digest("hex")}`;
    await new Promise<void>((resolve, reject) => {
      const socket = connect(address);
      socket.once("error", reject);
      socket.once("connect", () =>
        socket.write(
          `${JSON.stringify({ type: "cancel", operationId: request.operationId, key: "0".repeat(64) })}\n`
        )
      );
      socket.once("close", () => resolve());
    });
    assert.equal(cancellationCount(), 0);
  } finally {
    finishing.resolve();
    await running;
  }
});

test("the background owner forces recovery to its own Operation", async (context) => {
  const { request, fake, finishing } = await fixture(context);
  let observed: VisibleRuntimeOptions | undefined;
  const running = runBackgroundOwner(
    request,
    async () => finishing.resolve(),
    (options) => {
      observed = options;
      return fake;
    }
  );
  await running;

  assert.equal(observed?.recoveryOperationId, request.operationId);
});
