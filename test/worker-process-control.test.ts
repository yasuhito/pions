import assert from "node:assert/strict";
import { test } from "node:test";

import { Effect } from "effect";

import type { WorkerProcessIdentity } from "../src/internal/services.js";
import {
  NodeWorkerProcessControl,
  processStartToken,
} from "../src/internal/worker-process-control.js";
import { observedConfig } from "./worker-protocol-fixtures.js";

const identity: WorkerProcessIdentity = {
  processId: 1234,
  processInstanceId: "12".repeat(32),
  processStartToken: "987654",
  piSessionId: "pi-session-1",
  observedConfig,
};

function stat(startToken: string): string {
  return `1234 (node worker) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 ${startToken} 20`;
}

test("process start token parsing tolerates spaces in the command name", () => {
  assert.equal(processStartToken(stat("987654")), "987654");
});

test("a reused process identifier proves the original Worker stopped", async () => {
  const control = new NodeWorkerProcessControl({
    readProcessStat: () => Promise.resolve(stat("other-start")),
  });

  assert.equal(await Effect.runPromise(control.observe(identity)), "stopped");
});

test("an unreadable process identity is not treated as stopped", async () => {
  const control = new NodeWorkerProcessControl({
    readProcessStat: () => Promise.reject(new Error("permission denied")),
  });

  assert.equal(await Effect.runPromise(control.observe(identity)), "unverifiable");
});

test("Claude backend descendants are captured with process start tokens", async () => {
  const control = new NodeWorkerProcessControl({
    readProcessChildren: (processId) => Promise.resolve(processId === 1234 ? "2001 2002" : ""),
    readProcessStat: (processId) => Promise.resolve(stat(
      processId === identity.processId ? identity.processStartToken : `token-${processId}`,
    )),
  });

  assert.deepEqual(await Effect.runPromise(control.captureDescendants(identity)), [
    { processId: 2001, processStartToken: "token-2001" },
    { processId: 2002, processStartToken: "token-2002" },
  ]);
});

test("unreadable Claude backend descendants cannot prove cancellation", async () => {
  const control = new NodeWorkerProcessControl({
    readProcessChildren: () => Promise.reject(new Error("permission denied")),
  });

  assert.equal(await Effect.runPromise(control.captureDescendants(identity)), undefined);
});

test("an already stopped exact process is cancellation evidence", async () => {
  const control = new NodeWorkerProcessControl({
    readProcessStat: () => Promise.reject(Object.assign(new Error("gone"), { code: "ENOENT" })),
  });

  assert.deepEqual(await Effect.runPromise(control.terminate(identity)), { proof: "worker-stop" });
});

test("successful signal delivery is not cancellation evidence", async () => {
  const control = new NodeWorkerProcessControl({
    readProcessStat: () => Promise.resolve(stat("987654")),
    signal: () => undefined,
    stopTimeoutMilliseconds: 0,
  });

  assert.equal(await Effect.runPromise(control.terminate(identity)), undefined);
});

test("forced termination signals only the exact process instance", async () => {
  let signals = 0;
  const stats = [stat("987654"), Promise.reject(Object.assign(new Error("gone"), { code: "ENOENT" }))];
  const control = new NodeWorkerProcessControl({
    readProcessStat: () => {
      const next = stats.shift();
      return next instanceof Promise ? next : Promise.resolve(next ?? stat("other"));
    },
    signal: () => { signals += 1; },
    sleep: () => Promise.resolve(),
  });
  await Effect.runPromise(control.terminate(identity));

  assert.equal(signals, 1);
});
