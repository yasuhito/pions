import assert from "node:assert/strict";
import { test } from "node:test";

import {
  HostProtocolPeer,
  ProtocolViolation,
  WORKER_PROTOCOL_VERSION,
  WorkerProtocolPeer,
  decodeWorkerConfig,
  encodeWorkerConfig,
} from "../src/internal/worker-protocol.js";
import type {
  HostProtocolEvent,
  WorkerConfig,
} from "../src/internal/worker-protocol.js";
import {
  agentRunEvidence,
  effectiveConfig,
  observedConfig,
  piSessionId,
  resultAcceptanceProof,
  resultDigest,
} from "./worker-protocol-fixtures.js";

const authority = {
  operationId: "operation-1",
  capability: "ab".repeat(32),
};
const processInstanceId = "12".repeat(32);

function peers(limits?: ConstructorParameters<typeof HostProtocolPeer>[1]) {
  return {
    host: new HostProtocolPeer(authority, limits),
    worker: new WorkerProtocolPeer(authority, limits),
  };
}

function successfulDelivery(
  host: HostProtocolPeer,
  worker: WorkerProtocolPeer,
  body = "finished",
): ReadonlyArray<HostProtocolEvent> {
  return host.receive(Buffer.concat([
    worker.send({ type: "hello", processInstanceId }),
    worker.send({ type: "started", piSessionId, observedConfig }),
    worker.send({ type: "result", body, deliverySequenceNumber: 1 }),
    worker.send({ type: "done", ...agentRunEvidence }),
  ]));
}

function rewriteFrame(
  bytes: Buffer,
  change: Readonly<Record<string, unknown>>,
): Buffer {
  const frame = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  return Buffer.from(`${JSON.stringify({ ...frame, ...change })}\n`, "utf8");
}

test("Worker protocol returns the authenticated process identity", () => {
  const { host, worker } = peers();

  assert.deepEqual(successfulDelivery(host, worker)[0], {
    type: "started",
    processInstanceId,
    piSessionId,
    observedConfig,
  });
});

test("Worker protocol returns the authenticated Result reception", () => {
  const { host, worker } = peers();

  assert.deepEqual(successfulDelivery(host, worker)[1], {
    type: "results_received",
    reception: {
      deliveries: [{
        operationId: "operation-1",
        body: "finished",
        digest: "sha256:05343e9845302eb730fa9d18ac7b28d5e509893daf1eb76ede8d6e82d47b2da9",
        sequenceNumber: 1,
      }],
    },
    evidence: agentRunEvidence,
  });
});

test("Worker protocol carries observed Worker configuration", () => {
  const { host, worker } = peers();
  const started = successfulDelivery(host, worker)[0];

  assert.deepEqual(started?.type === "started" ? started.observedConfig : undefined, observedConfig);
});

test("Worker protocol carries a typed pre-start configuration failure", () => {
  const { host, worker } = peers();
  host.receive(worker.send({ type: "hello", processInstanceId }));

  assert.deepEqual(
    host.receive(worker.send({ type: "configuration_failed", reason: "model_mismatch" })),
    [{ type: "worker_configuration_failed", reason: "model_mismatch" }],
  );
});

test("Worker protocol carries settled Pi failure evidence", () => {
  const { host, worker } = peers();
  host.receive(worker.send({ type: "hello", processInstanceId }));
  host.receive(worker.send({ type: "started", piSessionId, observedConfig }));

  const events = host.receive(worker.send({
    type: "failed",
    errorMessage: "provider failed",
    ...agentRunEvidence,
  }));

  assert.deepEqual(events, [{
    type: "worker_failed",
    errorMessage: "provider failed",
    evidence: agentRunEvidence,
  }]);
});

test("Worker protocol buffers a split frame", () => {
  const { host, worker } = peers();
  const hello = worker.send({ type: "hello", processInstanceId });
  host.receive(hello.subarray(0, 20));

  assert.deepEqual(host.receive(hello.subarray(20)), []);
});

test("Worker protocol accepts a same-delivery retry", () => {
  const { host, worker } = peers();
  host.receive(worker.send({ type: "hello", processInstanceId }));
  host.receive(worker.send({ type: "started", piSessionId, observedConfig }));
  host.receive(worker.send({ type: "result", body: "finished", deliverySequenceNumber: 1 }));
  host.receive(worker.send({ type: "result", body: "finished", deliverySequenceNumber: 1 }));

  assert.deepEqual(
    host.receive(worker.send({ type: "done", ...agentRunEvidence }))[0]?.type === "results_received"
      ? host.acknowledgeResult(resultAcceptanceProof(authority.operationId)).complete
      : undefined,
    false,
  );
});

test("Worker protocol rejects an invalid Operation capability", () => {
  const host = new HostProtocolPeer(authority);
  const worker = new WorkerProtocolPeer({ ...authority, capability: "cd".repeat(32) });

  assert.throws(
    () => host.receive(worker.send({ type: "hello", processInstanceId })),
    (error) => error instanceof ProtocolViolation && error.reason === "authority_mismatch",
  );
});

test("Worker protocol rejects a stale Worker sequence", () => {
  const { host, worker } = peers();
  host.receive(worker.send({ type: "hello", processInstanceId }));
  const started = rewriteFrame(worker.send({ type: "started", piSessionId, observedConfig }), { sequenceNumber: 1 });

  assert.throws(
    () => host.receive(started),
    (error) => error instanceof ProtocolViolation && error.reason === "sequence_mismatch",
  );
});

test("Worker protocol uses version 4", () => {
  assert.equal(WORKER_PROTOCOL_VERSION, 4);
});

test("Worker protocol rejects a different frame version", () => {
  const { host, worker } = peers();
  const hello = rewriteFrame(
    worker.send({ type: "hello", processInstanceId }),
    { protocolVersion: WORKER_PROTOCOL_VERSION + 1 },
  );

  assert.throws(
    () => host.receive(hello),
    (error) => error instanceof ProtocolViolation && error.reason === "version_mismatch",
  );
});

test("Worker protocol rejects a nonnumeric frame version as an invalid frame", () => {
  const { host } = peers();
  const frame = Buffer.from(JSON.stringify({
    protocolVersion: String(WORKER_PROTOCOL_VERSION),
  }) + "\n", "utf8");

  assert.throws(
    () => host.receive(frame),
    (error) => error instanceof ProtocolViolation && error.reason === "invalid_frame",
  );
});

test("Worker protocol reports version mismatch before validating frame shape", () => {
  const { host } = peers();
  const frame = Buffer.from(JSON.stringify({
    protocolVersion: WORKER_PROTOCOL_VERSION + 1,
  }) + "\n", "utf8");

  assert.throws(
    () => host.receive(frame),
    (error) => error instanceof ProtocolViolation && error.reason === "version_mismatch",
  );
});

test("Worker protocol rejects an oversized first frame", () => {
  const { host } = peers({ firstFrameBytes: 64 });

  assert.throws(
    () => host.receive(Buffer.from("x".repeat(65), "utf8")),
    (error) => error instanceof ProtocolViolation && error.reason === "frame_too_large",
  );
});

test("Worker protocol applies the normal limit to a coalesced remainder", () => {
  const { host, worker } = peers({ frameBytes: 256 });
  const bytes = Buffer.concat([
    worker.send({ type: "hello", processInstanceId }),
    Buffer.from("x".repeat(257), "utf8"),
  ]);

  assert.throws(
    () => host.receive(bytes),
    (error) => error instanceof ProtocolViolation && error.reason === "frame_too_large",
  );
});

test("Worker protocol rejects an oversized inbound Result", () => {
  const host = new HostProtocolPeer(authority, { resultBytes: 4 });
  const worker = new WorkerProtocolPeer(authority);

  assert.throws(
    () => successfulDelivery(host, worker, "finished"),
    (error) => error instanceof ProtocolViolation && error.reason === "result_too_large",
  );
});

test("Worker protocol refuses to emit an oversized first frame", () => {
  const worker = new WorkerProtocolPeer(authority, { firstFrameBytes: 64 });

  assert.throws(
    () => worker.send({ type: "hello", processInstanceId }),
    (error) => error instanceof ProtocolViolation && error.reason === "frame_too_large",
  );
});

test("Worker protocol refuses to emit an oversized normal frame", () => {
  const worker = new WorkerProtocolPeer(authority, {
    frameBytes: 512,
    resultBytes: 1024,
  });
  worker.send({ type: "hello", processInstanceId });
  worker.send({ type: "started", piSessionId, observedConfig });

  assert.throws(
    () => worker.send({ type: "result", body: "x".repeat(500), deliverySequenceNumber: 1 }),
    (error) => error instanceof ProtocolViolation && error.reason === "frame_too_large",
  );
});

test("a failed Worker protocol send leaves its sequence unchanged", () => {
  const worker = new WorkerProtocolPeer(authority, {
    frameBytes: 512,
    resultBytes: 1024,
  });
  worker.send({ type: "hello", processInstanceId });
  worker.send({ type: "started", piSessionId, observedConfig });
  try {
    worker.send({ type: "result", body: "x".repeat(500), deliverySequenceNumber: 1 });
  } catch {
    // The observable assertion below verifies that this failed transition did not commit.
  }
  const retry = worker.send({ type: "result", body: "finished", deliverySequenceNumber: 1 });

  assert.equal(JSON.parse(retry.toString("utf8")).sequenceNumber, 3);
});

test("Worker protocol rejects an excessive inbound session Result total", () => {
  const host = new HostProtocolPeer(authority, {
    resultBytes: 8,
    sessionResultBytes: 8,
  });
  const worker = new WorkerProtocolPeer(authority);
  host.receive(worker.send({ type: "hello", processInstanceId }));
  host.receive(worker.send({ type: "started", piSessionId, observedConfig }));
  host.receive(worker.send({ type: "result", body: "12345", deliverySequenceNumber: 1 }));

  assert.throws(
    () => host.receive(worker.send({ type: "result", body: "67890", deliverySequenceNumber: 1 })),
    (error) => error instanceof ProtocolViolation && error.reason === "session_result_too_large",
  );
});

test("Worker protocol rejects too many inbound Result deliveries", () => {
  const host = new HostProtocolPeer(authority, { resultDeliveries: 1 });
  const worker = new WorkerProtocolPeer(authority);
  host.receive(worker.send({ type: "hello", processInstanceId }));
  host.receive(worker.send({ type: "started", piSessionId, observedConfig }));
  host.receive(worker.send({ type: "result", body: "first", deliverySequenceNumber: 1 }));

  assert.throws(
    () => host.receive(worker.send({ type: "result", body: "second", deliverySequenceNumber: 2 })),
    (error) => error instanceof ProtocolViolation && error.reason === "too_many_results",
  );
});

test("Worker protocol rejects a mismatched Result digest", () => {
  const { host, worker } = peers();
  host.receive(worker.send({ type: "hello", processInstanceId }));
  host.receive(worker.send({ type: "started", piSessionId, observedConfig }));
  const result = rewriteFrame(
    worker.send({ type: "result", body: "finished", deliverySequenceNumber: 1 }),
    { digest: `sha256:${"0".repeat(64)}` },
  );

  assert.throws(
    () => host.receive(result),
    (error) => error instanceof ProtocolViolation && error.reason === "digest_mismatch",
  );
});

test("Worker protocol emits ACK only after explicit Result acknowledgement", () => {
  const { host, worker } = peers();
  successfulDelivery(host, worker);

  assert.deepEqual(
    worker.receive(host.acknowledgeResult(resultAcceptanceProof(authority.operationId)).bytes),
    { acknowledgementsComplete: true },
  );
});

test("Worker protocol makes a premature ACK reception terminal", () => {
  const { worker } = peers();
  worker.send({ type: "hello", processInstanceId });
  worker.send({ type: "started", piSessionId, observedConfig });
  const acknowledgement = Buffer.from(`${JSON.stringify({
    protocolVersion: WORKER_PROTOCOL_VERSION,
    operationId: authority.operationId,
    digest: resultDigest("finished"),
    deliverySequenceNumber: 1,
    type: "ack",
  })}\n`, "utf8");
  try {
    worker.receive(acknowledgement);
  } catch {
    // The attempted send below exposes the terminal failure state.
  }

  assert.throws(
    () => worker.send({ type: "result", body: "finished", deliverySequenceNumber: 1 }),
    (error) => error instanceof ProtocolViolation && error.reason === "invalid_transition",
  );
});

test("Worker protocol makes a failed ACK reception terminal", () => {
  const { host, worker } = peers();
  host.receive(Buffer.concat([
    worker.send({ type: "hello", processInstanceId }),
    worker.send({ type: "started", piSessionId, observedConfig }),
    worker.send({ type: "result", body: "finished", deliverySequenceNumber: 1 }),
    worker.send({ type: "result", body: "finished", deliverySequenceNumber: 2 }),
    worker.send({ type: "done", ...agentRunEvidence }),
  ]));
  const first = host.acknowledgeResult(resultAcceptanceProof(authority.operationId, "finished", 1));
  const invalid = rewriteFrame(
    host.acknowledgeResult(resultAcceptanceProof(authority.operationId, "finished", 2)).bytes,
    { deliverySequenceNumber: 99 },
  );
  try {
    worker.receive(Buffer.concat([first.bytes, invalid]));
  } catch {
    // The next reception exposes the terminal failure state.
  }

  assert.throws(
    () => worker.receive(first.bytes),
    (error) => error instanceof ProtocolViolation && error.reason === "invalid_transition",
  );
});

test("ACK distinguishes conflicting Results with the same delivery sequence", () => {
  const { host, worker } = peers();
  host.receive(Buffer.concat([
    worker.send({ type: "hello", processInstanceId }),
    worker.send({ type: "started", piSessionId, observedConfig }),
    worker.send({ type: "result", body: "accepted", deliverySequenceNumber: 1 }),
    worker.send({ type: "result", body: "conflicting", deliverySequenceNumber: 1 }),
    worker.send({ type: "done", ...agentRunEvidence }),
  ]));
  const acknowledgement = host.acknowledgeResult(
    resultAcceptanceProof(authority.operationId, "accepted", 1),
  );

  assert.equal(worker.receive(acknowledgement.bytes).acknowledgementsComplete, false);
});

test("Worker protocol rejects ACK before Result reception completes", () => {
  const { host } = peers();

  assert.throws(
    () => host.acknowledgeResult(resultAcceptanceProof(authority.operationId)),
    (error) => error instanceof ProtocolViolation && error.reason === "invalid_transition",
  );
});

test("Host protocol peer makes a frame received after done terminal", () => {
  const { host, worker } = peers();
  successfulDelivery(host, worker);
  try {
    host.receive(Buffer.from("{}\n", "utf8"));
  } catch {
    // The acknowledgement attempt below exposes the terminal failure state.
  }

  assert.throws(
    () => host.acknowledgeResult(resultAcceptanceProof(authority.operationId)),
    (error) => error instanceof ProtocolViolation && error.reason === "invalid_transition",
  );
});

test("Host protocol peer rejects an incomplete frame after done", () => {
  const { host, worker } = peers();
  const bytes = Buffer.concat([
    worker.send({ type: "hello", processInstanceId }),
    worker.send({ type: "started", piSessionId, observedConfig }),
    worker.send({ type: "result", body: "finished", deliverySequenceNumber: 1 }),
    worker.send({ type: "done", ...agentRunEvidence }),
    Buffer.from("{", "utf8"),
  ]);

  assert.throws(
    () => host.receive(bytes),
    (error) => error instanceof ProtocolViolation && error.reason === "invalid_frame",
  );
});

test("Worker protocol rejects an incomplete frame after the final ACK", () => {
  const { host, worker } = peers();
  successfulDelivery(host, worker);
  const acknowledgement = host.acknowledgeResult(
    resultAcceptanceProof(authority.operationId),
  ).bytes;

  assert.throws(
    () => worker.receive(Buffer.concat([acknowledgement, Buffer.from("{", "utf8")])),
    (error) => error instanceof ProtocolViolation && error.reason === "invalid_frame",
  );
});

test("Worker protocol rejects disconnect before Result reception completes", () => {
  const { host, worker } = peers();
  host.receive(worker.send({ type: "hello", processInstanceId }));

  assert.throws(
    () => host.disconnect(),
    (error) => error instanceof ProtocolViolation && error.reason === "incomplete_session",
  );
});

test("Worker protocol encodes cancellation control", () => {
  const { host, worker } = peers();
  host.receive(worker.send({ type: "hello", processInstanceId }));

  assert.equal(JSON.parse(host.requestCancellation()?.toString("utf8") ?? "").type, "cancel");
});

test("Worker protocol omits cancellation after Result reception", () => {
  const { host, worker } = peers();
  successfulDelivery(host, worker);

  assert.equal(host.requestCancellation(), undefined);
});

function workerConfig(): WorkerConfig {
  return {
    operationId: authority.operationId,
    capability: authority.capability,
    socketPath: "/private/child.sock",
    promptPath: "/private/prompt.utf8",
    effectiveConfig,
  };
}

test("Worker protocol rejects a nonnumeric configuration version as an invalid frame", () => {
  const encoded = JSON.stringify({
    protocolVersion: String(WORKER_PROTOCOL_VERSION),
  });

  assert.throws(
    () => decodeWorkerConfig(encoded),
    (error) => error instanceof ProtocolViolation && error.reason === "invalid_frame",
  );
});

test("Worker protocol reports configuration version mismatch before validating its shape", () => {
  const encoded = JSON.stringify({
    protocolVersion: WORKER_PROTOCOL_VERSION + 1,
  });

  assert.throws(
    () => decodeWorkerConfig(encoded),
    (error) => error instanceof ProtocolViolation && error.reason === "version_mismatch",
  );
});

test("Worker protocol round-trips the current Worker configuration", () => {
  const config = workerConfig();

  assert.deepEqual(decodeWorkerConfig(encodeWorkerConfig(config)), config);
});

test("Worker protocol rejects a different Worker configuration version", () => {
  const current = JSON.parse(encodeWorkerConfig(workerConfig())) as Record<string, unknown>;
  const encoded = JSON.stringify({ ...current, protocolVersion: WORKER_PROTOCOL_VERSION + 1 });

  assert.throws(
    () => decodeWorkerConfig(encoded),
    (error) => error instanceof ProtocolViolation && error.reason === "version_mismatch",
  );
});
