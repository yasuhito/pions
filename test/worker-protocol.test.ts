import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  HostProtocolPeer,
  ProtocolViolation,
  WorkerProtocolPeer,
  WORKER_PROTOCOL_VERSION,
  decodeStartInstruction,
  decodeWorkerConfig,
  encodeWorkerConfig,
} from "../src/internal/worker-protocol.js";
import type {
  ResultAcceptanceProof,
  StartInstruction,
  StartInstructionAcceptanceStore,
} from "../src/internal/worker-protocol.js";
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

const instruction = {
  dispatcherId: "dispatcher-1",
  workerProcessInstanceId: identity.processInstanceId,
  receiptDigest: `sha256:${"e".repeat(64)}` as const,
  authorizationDecisionId: "decision-1",
  deliveryGeneration: 1,
  deadline: "2099-09-06T10:01:00.000Z",
};

function acceptanceStore(): StartInstructionAcceptanceStore {
  let accepted: Readonly<StartInstruction> | "none" = "none";
  let generation = 1;
  return {
    load: () => accepted,
    save: (instruction) => {
      accepted = { ...instruction };
      return true;
    },
    loadGeneration: () => generation,
    saveGeneration: (next) => {
      generation = next;
      return true;
    },
  };
}

function workerPeer(now?: () => string): WorkerProtocolPeer {
  return new WorkerProtocolPeer(authority, acceptanceStore(), undefined, now);
}

function connected() {
  const host = new HostProtocolPeer(authority);
  const worker = workerPeer();
  host.receive(worker.send(identity));
  host.receive(worker.send({ type: "started", piSessionId: "session-1", observedConfig }));
  const reception = worker.receive(host.begin(instruction));
  const accepted = reception.startInstructions[0]!.instruction;
  host.receive(worker.send({ type: "begin_accepted", instruction: accepted }));
  worker.receive(host.acknowledgeStartInstructionAcceptance(accepted));
  host.receive(worker.send({ type: "begin_ack", instruction: accepted }));
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

test("a corrupt durable Start acceptance is rejected", () => {
  assert.equal(
    violationReason(() => decodeStartInstruction({ deliveryGeneration: 1 })),
    "invalid_frame",
  );
});

test("worker configuration round trips", () => {
  const config = { ...authority, socketPath: "/tmp/socket", promptPath: "/tmp/prompt", effectiveConfig };

  assert.deepEqual(decodeWorkerConfig(encodeWorkerConfig(config)), config);
});

test("durable acceptance is observed before begin acknowledgement", () => {
  const host = new HostProtocolPeer(authority);
  const worker = workerPeer();
  host.receive(worker.send(identity));
  host.receive(worker.send({ type: "started", piSessionId: "session-1", observedConfig }));
  const accepted = worker.receive(host.begin(instruction)).startInstructions[0]!;

  const events = host.receive(worker.send({ type: "begin_accepted", instruction: accepted.instruction }));

  assert.equal(events[0]?.type, "start_instruction_accepted");
});

test("begin acknowledgement is a separate observation", () => {
  const host = new HostProtocolPeer(authority);
  const worker = workerPeer();
  host.receive(worker.send(identity));
  host.receive(worker.send({ type: "started", piSessionId: "session-1", observedConfig }));
  const accepted = worker.receive(host.begin(instruction)).startInstructions[0]!;
  host.receive(worker.send({ type: "begin_accepted", instruction: accepted.instruction }));
  worker.receive(host.acknowledgeStartInstructionAcceptance(accepted.instruction));

  const events = host.receive(worker.send({ type: "begin_ack", instruction: accepted.instruction }));

  assert.equal(events[0]?.type, "start_instruction_acknowledged");
});

test("a repeated begin returns an acknowledgement without starting another prompt", () => {
  const host = new HostProtocolPeer(authority);
  const worker = workerPeer();
  host.receive(worker.send(identity));
  host.receive(worker.send({ type: "started", piSessionId: "session-1", observedConfig }));
  worker.receive(host.begin(instruction));

  const repeated = worker.receive(host.begin(instruction));

  assert.equal(repeated.startInstructions[0]?.status, "duplicate");
});

test("an interrupted begin frame is not accepted", () => {
  const host = new HostProtocolPeer(authority);
  const worker = workerPeer();
  host.receive(worker.send(identity));
  host.receive(worker.send({ type: "started", piSessionId: "session-1", observedConfig }));
  const begin = host.begin(instruction);

  const reception = worker.receive(begin.subarray(0, begin.byteLength - 1));

  assert.equal(reception.startInstructions.length, 0);
});

test("a completed interrupted begin frame is accepted once", () => {
  const host = new HostProtocolPeer(authority);
  const worker = workerPeer();
  host.receive(worker.send(identity));
  host.receive(worker.send({ type: "started", piSessionId: "session-1", observedConfig }));
  const begin = host.begin(instruction);
  worker.receive(begin.subarray(0, begin.byteLength - 1));

  const reception = worker.receive(begin.subarray(begin.byteLength - 1));

  assert.equal(reception.startInstructions[0]?.status, "accepted");
});

test("batched duplicate begins each produce a reception result", () => {
  const host = new HostProtocolPeer(authority);
  const worker = workerPeer();
  host.receive(worker.send(identity));
  host.receive(worker.send({ type: "started", piSessionId: "session-1", observedConfig }));

  const reception = worker.receive(Buffer.concat([
    host.begin(instruction),
    host.begin(instruction),
  ]));

  assert.deepEqual(reception.startInstructions.map(({ status }) => status), ["accepted", "duplicate"]);
});

test("a lost acknowledgement recovers the durable acceptance without reinjecting", () => {
  let accepted: Readonly<StartInstruction> | "none" = "none";
  const store = {
    load: () => accepted,
    save: (value: Readonly<StartInstruction>) => {
      accepted = value;
      return true;
    },
    loadGeneration: () => 1,
    saveGeneration: () => true,
  } as const;
  const host = new HostProtocolPeer(authority);
  const firstWorker = new WorkerProtocolPeer(authority, store);
  host.receive(firstWorker.send(identity));
  host.receive(firstWorker.send({ type: "started", piSessionId: "session-1", observedConfig }));
  firstWorker.receive(host.begin(instruction));
  const recoveredWorker = new WorkerProtocolPeer(authority, store);
  const recoveredHost = new HostProtocolPeer(authority);
  recoveredHost.receive(recoveredWorker.send(identity));
  recoveredHost.receive(recoveredWorker.send({ type: "started", piSessionId: "session-1", observedConfig }));

  const reception = recoveredWorker.receive(recoveredHost.begin(instruction));

  assert.equal(reception.startInstructions[0]?.status, "duplicate");
});

test("a repeated begin identity with different content is rejected as a conflict", () => {
  const host = new HostProtocolPeer(authority);
  const worker = workerPeer();
  host.receive(worker.send(identity));
  host.receive(worker.send({ type: "started", piSessionId: "session-1", observedConfig }));
  worker.receive(host.begin(instruction));
  const replacement = JSON.parse(host.begin(instruction).toString("utf8")) as {
    instruction: { receiptDigest: string };
  };
  replacement.instruction.receiptDigest = `sha256:${"f".repeat(64)}`;

  const reception = worker.receive(Buffer.from(`${JSON.stringify(replacement)}\n`, "utf8"));

  assert.equal(reception.startInstructions[0]?.status, "conflict");
});

test("a begin for another Worker instance returns a closed rejection", () => {
  const host = new HostProtocolPeer(authority);
  const worker = workerPeer();
  host.receive(worker.send(identity));
  host.receive(worker.send({ type: "started", piSessionId: "session-1", observedConfig }));
  const mismatched = { ...instruction, workerProcessInstanceId: "c".repeat(64) };
  const reception = worker.receive(host.begin(mismatched));

  const events = host.receive(worker.send({
    type: "begin_rejected",
    instruction: reception.startInstructions[0]!.instruction,
    reason: "worker_mismatch",
  }));

  assert.equal(events[0]?.type === "start_instruction_rejected" ? events[0].reason : undefined, "worker_mismatch");
});

test("a begin received at its deadline is rejected", () => {
  const host = new HostProtocolPeer(authority);
  const worker = workerPeer(() => "2026-09-06T10:01:00.000Z");
  host.receive(worker.send(identity));
  host.receive(worker.send({ type: "started", piSessionId: "session-1", observedConfig }));

  const reception = worker.receive(host.begin({
    ...instruction,
    deadline: "2026-09-06T10:01:00.000Z",
  }));

  assert.equal(reception.startInstructions[0]?.status, "expired");
});

test("an expired begin returns a closed rejection to the Dispatcher", () => {
  const host = new HostProtocolPeer(authority);
  const worker = workerPeer(() => "2026-09-06T10:01:00.000Z");
  host.receive(worker.send(identity));
  host.receive(worker.send({ type: "started", piSessionId: "session-1", observedConfig }));
  const expiredInstruction = { ...instruction, deadline: "2026-09-06T10:01:00.000Z" };
  const reception = worker.receive(host.begin(expiredInstruction));

  const events = host.receive(worker.send({
    type: "begin_rejected",
    instruction: reception.startInstructions[0]!.instruction,
    reason: "expired",
  }));

  assert.equal(events[0]?.type === "start_instruction_rejected" ? events[0].reason : undefined, "expired");
});

test("a lost Worker acceptance record prevents begin execution", () => {
  const host = new HostProtocolPeer(authority);
  const worker = new WorkerProtocolPeer(authority, {
    load: () => "unknown",
    save: () => false,
    loadGeneration: () => 1,
    saveGeneration: () => true,
  });
  host.receive(worker.send(identity));
  host.receive(worker.send({ type: "started", piSessionId: "session-1", observedConfig }));

  const reception = worker.receive(host.begin(instruction));

  assert.equal(reception.startInstructions[0]?.status, "acceptance_unknown");
});

test("generation recovery preserves unknown acceptance instead of redispatching", () => {
  const host = new HostProtocolPeer(authority);
  const worker = new WorkerProtocolPeer(authority, {
    load: () => "unknown",
    save: () => false,
    loadGeneration: () => 1,
    saveGeneration: () => true,
  });
  host.receive(worker.send(identity));
  host.receive(worker.send({ type: "started", piSessionId: "session-1", observedConfig }));

  const update = worker.receive(host.updateDeliveryGeneration(2, "dispatcher-2"));

  assert.equal(update.generationUpdate?.acceptanceState, "unknown");
});

test("a generation update reports a begin accepted immediately before the update", () => {
  const host = new HostProtocolPeer(authority);
  const worker = workerPeer();
  host.receive(worker.send(identity));
  host.receive(worker.send({ type: "started", piSessionId: "session-1", observedConfig }));
  worker.receive(host.begin(instruction));

  const update = worker.receive(host.updateDeliveryGeneration(2, "dispatcher-2"));

  assert.deepEqual(update.generationUpdate?.acceptedInstruction, instruction);
});

test("a generation update acknowledgement includes the previously accepted begin", () => {
  const host = new HostProtocolPeer(authority);
  const worker = workerPeer();
  host.receive(worker.send(identity));
  host.receive(worker.send({ type: "started", piSessionId: "session-1", observedConfig }));
  worker.receive(host.begin(instruction));
  const update = worker.receive(host.updateDeliveryGeneration(2, "dispatcher-2"));

  const events = host.receive(worker.send({
    type: "generation_updated",
    deliveryGeneration: 2,
    acceptanceState: "accepted",
    acceptedInstruction: update.generationUpdate!.acceptedInstruction!,
  }));

  assert.deepEqual(events[0]?.type === "delivery_generation_updated" ? events[0].acceptedInstruction : undefined, instruction);
});

test("a confirmed handoff revokes the old Dispatcher's Start delivery authority", () => {
  const host = new HostProtocolPeer(authority);
  const worker = workerPeer();
  host.receive(worker.send(identity));
  host.receive(worker.send({ type: "started", piSessionId: "session-1", observedConfig }));
  const update = worker.receive(host.updateDeliveryGeneration(2, "dispatcher-2"));
  host.receive(worker.send({
    type: "generation_updated",
    deliveryGeneration: 2,
    acceptanceState: update.generationUpdate!.acceptanceState,
    ...(update.generationUpdate?.acceptedInstruction === undefined
      ? {}
      : { acceptedInstruction: update.generationUpdate.acceptedInstruction }),
  }));
  host.completeDispatcherHandoff("dispatcher-2");

  assert.equal(violationReason(() => host.begin(instruction)), "authority_mismatch");
});

test("a Dispatcher cannot complete handoff before Worker generation confirmation", () => {
  const host = new HostProtocolPeer(authority);

  assert.equal(
    violationReason(() => host.completeDispatcherHandoff("dispatcher-2")),
    "invalid_transition",
  );
});

test("a confirmed successor can deliver begin in the new generation", () => {
  const host = new HostProtocolPeer(authority);
  const worker = workerPeer();
  host.receive(worker.send(identity));
  host.receive(worker.send({ type: "started", piSessionId: "session-1", observedConfig }));
  const update = worker.receive(host.updateDeliveryGeneration(2, "dispatcher-2"));
  host.receive(worker.send({
    type: "generation_updated",
    deliveryGeneration: 2,
    acceptanceState: update.generationUpdate!.acceptanceState,
  }));
  host.completeDispatcherHandoff("dispatcher-2");

  const reception = worker.receive(host.begin({
    ...instruction,
    dispatcherId: "dispatcher-2",
    deliveryGeneration: 2,
  }));

  assert.equal(reception.startInstructions[0]?.status, "accepted");
});

test("a restarted Worker rejects an old generation from durable state", () => {
  let generation = 1;
  const store = {
    load: () => "none" as const,
    save: () => true,
    loadGeneration: () => generation,
    saveGeneration: (next: number) => { generation = next; return true; },
  };
  const firstHost = new HostProtocolPeer(authority);
  const firstWorker = new WorkerProtocolPeer(authority, store);
  firstHost.receive(firstWorker.send(identity));
  firstHost.receive(firstWorker.send({ type: "started", piSessionId: "session-1", observedConfig }));
  firstWorker.receive(firstHost.updateDeliveryGeneration(2, "dispatcher-2"));
  const recoveredHost = new HostProtocolPeer(authority);
  const recoveredWorker = new WorkerProtocolPeer(authority, store);
  recoveredHost.receive(recoveredWorker.send(identity));
  recoveredHost.receive(recoveredWorker.send({ type: "started", piSessionId: "session-1", observedConfig }));

  const reception = recoveredWorker.receive(recoveredHost.begin(instruction));

  assert.equal(reception.startInstructions[0]?.status, "stale_generation");
});

test("a Worker rejects cancellation from a revoked Start delivery authority", () => {
  const host = new HostProtocolPeer(authority);
  const worker = workerPeer();
  host.receive(worker.send(identity));
  host.receive(worker.send({ type: "started", piSessionId: "session-1", observedConfig }));
  worker.receive(host.begin(instruction));
  worker.receive(host.updateDeliveryGeneration(2, "dispatcher-2"));

  assert.equal(
    violationReason(() => worker.receive(host.requestCancellation()!)),
    "authority_mismatch",
  );
});

test("a Worker rejects old-generation begin after a generation update", () => {
  const host = new HostProtocolPeer(authority);
  const worker = workerPeer();
  host.receive(worker.send(identity));
  host.receive(worker.send({ type: "started", piSessionId: "session-1", observedConfig }));
  worker.receive(host.updateDeliveryGeneration(2, "dispatcher-2"));

  const reception = worker.receive(host.begin(instruction));

  assert.equal(reception.startInstructions[0]?.status, "stale_generation");
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
  const worker = new WorkerProtocolPeer(authority, acceptanceStore(), { artifactBytes: 3 });
  host.receive(worker.send(identity));
  host.receive(worker.send({ type: "started", piSessionId: "session-1", observedConfig }));
  worker.receive(host.begin(instruction));

  assert.equal(violationReason(() => worker.send({ type: "artifacts", result: produced("four") })), "artifact_too_large");
});
