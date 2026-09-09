import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  HostProtocolPeer,
  ProtocolViolation,
  WorkerProtocolPeer,
  WORKER_PROTOCOL_VERSION,
  decodeWorkerConfig,
  encodeWorkerConfig,
} from "../src/internal/worker-protocol.js";
import type { ResultAcceptanceProof } from "../src/internal/worker-protocol.js";
import { effectiveConfig, observedConfig } from "./worker-protocol-fixtures.js";

const authority = { operationId: "operation-1", capability: "a".repeat(64) };
const identity = {
  type: "hello" as const,
  processId: 123,
  processInstanceId: "b".repeat(64),
  processStartToken: "start-1",
};
const evidence = {
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 0 },
  toolUses: [],
};

function produced(body = "finished") {
  const bytes = Buffer.from(body, "utf8");
  return {
    acceptanceRequestId: "request-1",
    body: {
      formatId: "pions.result-body.v1",
      normalizationId: "identity.v1",
      expectedByteCount: bytes.byteLength,
      expectedDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const,
      bytes,
    },
    workProducts: [],
  };
}

function connected() {
  const host = new HostProtocolPeer(authority);
  const worker = new WorkerProtocolPeer(authority);
  host.receive(worker.send(identity));
  host.receive(worker.send({ type: "started", piSessionId: "session-1", observedConfig }));
  worker.receive(host.begin());
  return { host, worker };
}

function proof(): ResultAcceptanceProof {
  return {
    operationId: authority.operationId,
    acceptanceId: `pions.result-acceptance.v1:${"c".repeat(64)}`,
    manifestDigest: `sha256:${"d".repeat(64)}`,
    eventSequenceNumber: 7,
  } as unknown as ResultAcceptanceProof;
}

function violationReason(action: () => unknown): string | undefined {
  try {
    action();
    return undefined;
  } catch (error) {
    return error instanceof ProtocolViolation ? error.reason : undefined;
  }
}

test("worker configuration uses the current protocol version", () => {
  const encoded = encodeWorkerConfig({
    ...authority,
    socketPath: "/tmp/socket",
    promptPath: "/tmp/prompt",
    effectiveConfig,
  });

  assert.equal(JSON.parse(encoded).protocolVersion, WORKER_PROTOCOL_VERSION);
});

test("worker configuration round trips", () => {
  const config = { ...authority, socketPath: "/tmp/socket", promptPath: "/tmp/prompt", effectiveConfig };

  assert.deepEqual(decodeWorkerConfig(encodeWorkerConfig(config)), config);
});

test("authenticated Artifact frames deliver a Worker-produced Result", () => {
  const { host, worker } = connected();
  host.receive(worker.send({ type: "artifacts", result: produced() }));

  const events = host.receive(worker.send({ type: "done", ...evidence }));

  assert.equal(events[0]?.type === "result_received" ? Buffer.from(events[0].result.body.bytes as Uint8Array).toString("utf8") : undefined, "finished");
});

test("work products retain their keys through the protocol", () => {
  const { host, worker } = connected();
  const result = produced();
  const bytes = Buffer.from("patch", "utf8");
  host.receive(worker.send({
    type: "artifacts",
    result: {
      ...result,
      workProducts: [{
        key: "patch",
        formatId: "pions.opaque.v1",
        normalizationId: "identity.v1",
        expectedByteCount: bytes.byteLength,
        expectedDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        bytes,
      }],
    },
  }));

  const events = host.receive(worker.send({ type: "done", ...evidence }));

  assert.equal(events[0]?.type === "result_received" ? events[0].result.workProducts[0]?.key : undefined, "patch");
});

test("Result ACK contains the persisted acceptance identifier", () => {
  const { host, worker } = connected();
  host.receive(worker.send({ type: "artifacts", result: produced() }));
  host.receive(worker.send({ type: "done", ...evidence }));

  const acknowledgement = host.acknowledgeResult(proof());

  assert.equal(JSON.parse(acknowledgement.bytes.toString("utf8")).acceptanceId, proof().acceptanceId);
});

test("worker recognizes a complete Result ACK", () => {
  const { host, worker } = connected();
  host.receive(worker.send({ type: "artifacts", result: produced() }));
  host.receive(worker.send({ type: "done", ...evidence }));

  const reception = worker.receive(host.acknowledgeResult(proof()).bytes);

  assert.equal(reception.acknowledgementsComplete, true);
});

test("repeating the same Result ACK is idempotent at the host", () => {
  const { host, worker } = connected();
  host.receive(worker.send({ type: "artifacts", result: produced() }));
  host.receive(worker.send({ type: "done", ...evidence }));
  const first = host.acknowledgeResult(proof());

  const repeated = host.acknowledgeResult(proof());

  assert.equal(repeated.bytes.equals(first.bytes), true);
});

test("repeating the same Result ACK remains complete at the worker", () => {
  const { host, worker } = connected();
  host.receive(worker.send({ type: "artifacts", result: produced() }));
  host.receive(worker.send({ type: "done", ...evidence }));
  const acknowledgement = host.acknowledgeResult(proof()).bytes;
  worker.receive(acknowledgement);

  const repeated = worker.receive(acknowledgement);

  assert.equal(repeated.acknowledgementsComplete, true);
});

test("disconnecting during Artifact chunks emits no Result", () => {
  const { host, worker } = connected();
  const frames = worker.send({ type: "artifacts", result: produced() }).toString("utf8").split("\n");
  const partialTransfer = Buffer.from(`${frames[0]}\n${frames[1]}\n`);

  const events = host.receive(partialTransfer);

  assert.equal(events.length, 0);
});

test("an invalid acceptance request identifier is rejected before Result delivery", () => {
  const { host, worker } = connected();
  const result = { ...produced(), acceptanceRequestId: "invalid identifier" };

  const reason = violationReason(() => host.receive(worker.send({ type: "artifacts", result })));

  assert.equal(reason, "invalid_frame");
});

test("a stale Artifact frame sequence is rejected", () => {
  const { host, worker } = connected();
  const bytes = worker.send({ type: "artifacts", result: produced() });
  const frames = bytes.toString("utf8").trimEnd().split("\n");
  const first = `${frames[0]}\n`;
  host.receive(Buffer.from(first));

  assert.equal(violationReason(() => host.receive(Buffer.from(first))), "sequence_mismatch");
});

test("an unauthenticated Artifact frame is rejected", () => {
  const { host, worker } = connected();
  const frame = JSON.parse(worker.send({ type: "artifacts", result: produced() }).toString("utf8").split("\n")[0]!);
  frame.capability = "e".repeat(64);

  assert.equal(violationReason(() => host.receive(Buffer.from(`${JSON.stringify(frame)}\n`))), "authority_mismatch");
});

test("the removed result frame is rejected", () => {
  const { host } = connected();
  const frame = {
    protocolVersion: WORKER_PROTOCOL_VERSION,
    operationId: authority.operationId,
    capability: authority.capability,
    sequenceNumber: 3,
    type: "result",
    body: "legacy",
  };

  assert.equal(violationReason(() => host.receive(Buffer.from(`${JSON.stringify(frame)}\n`))), "invalid_frame");
});

test("an Artifact exceeding the per-Artifact limit is rejected", () => {
  const host = new HostProtocolPeer(authority, { artifactBytes: 3 });
  const worker = new WorkerProtocolPeer(authority, { artifactBytes: 3 });
  host.receive(worker.send(identity));
  host.receive(worker.send({ type: "started", piSessionId: "session-1", observedConfig }));
  worker.receive(host.begin());

  assert.equal(violationReason(() => worker.send({ type: "artifacts", result: produced("four") })), "artifact_too_large");
});
