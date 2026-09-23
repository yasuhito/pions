import type {
  EffectiveWorkerConfig,
  StartInstructionReference,
  Sha256Digest,
  TaskSpec,
} from "./types.js";
import { sha256Digest } from "./result-digest.js";

export function startInstructionReference(
  instruction: Readonly<StartInstructionReference>
): StartInstructionReference {
  return {
    dispatcherId: instruction.dispatcherId,
    workerProcessInstanceId: instruction.workerProcessInstanceId,
    receiptDigest: instruction.receiptDigest,
    deliveryGeneration: instruction.deliveryGeneration,
  };
}

export function automaticStartScopeDigest(
  scope: Readonly<{
    readonly operationId: string;
    readonly task: Readonly<TaskSpec>;
    readonly effectiveConfig: Readonly<EffectiveWorkerConfig>;
  }>
): Sha256Digest {
  return sha256Digest(
    Buffer.from(
      JSON.stringify({
        format: "pions.automatic-start-scope.v1",
        operationId: scope.operationId,
        task: scope.task,
        effectiveConfig: scope.effectiveConfig,
      }),
      "utf8"
    )
  );
}
