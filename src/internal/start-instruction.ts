import type {
  EffectiveWorkerConfig,
  StartInstructionReference,
  StartupReceipt,
  TaskSpec,
} from "../public.js";
import { sha256Digest } from "./result-digest.js";

export function startInstructionReference(
  instruction: Readonly<StartInstructionReference>,
): StartInstructionReference {
  return {
    dispatcherId: instruction.dispatcherId,
    workerProcessInstanceId: instruction.workerProcessInstanceId,
    receiptDigest: instruction.receiptDigest,
    ...(instruction.authorizationDecisionId === undefined
      ? {}
      : { authorizationDecisionId: instruction.authorizationDecisionId }),
    deliveryGeneration: instruction.deliveryGeneration,
  };
}

/**
 * Trusted profiles without an external Start gate have no Startup receipt.
 * This digest binds their Start instruction to the Operation's fixed automatic-start scope.
 */
export function automaticStartScopeDigest(
  scope: Readonly<{
    readonly operationId: string;
    readonly task: Readonly<TaskSpec>;
    readonly effectiveConfig: Readonly<EffectiveWorkerConfig>;
  }>,
): StartupReceipt["digest"] {
  return sha256Digest(Buffer.from(JSON.stringify({
    format: "pions.automatic-start-scope.v1",
    operationId: scope.operationId,
    task: scope.task,
    effectiveConfig: scope.effectiveConfig,
  }), "utf8"));
}
