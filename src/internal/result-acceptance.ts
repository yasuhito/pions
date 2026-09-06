import { Effect } from "effect";

import type { EventStore, StoreError } from "./event-store/index.js";
import {
  OperationPersistenceError,
  ResultConflictError,
} from "../public.js";
import type { Result } from "../public.js";
import { resultDeliveryViolation } from "./worker-protocol.js";
import type {
  ResultAcceptanceProof,
  ResultDelivery,
} from "./worker-protocol.js";

export type ResultAcceptanceOutcome =
  | {
      readonly state: "accepted";
      readonly proofs: ReadonlyArray<ResultAcceptanceProof>;
      readonly resultDeliveryError?: ResultConflictError;
    }
  | { readonly state: "protocol_failed" };

export interface ResultAcceptance {
  accept(
    operationId: string,
    deliveries: ReadonlyArray<ResultDelivery>,
  ): Effect.Effect<ResultAcceptanceOutcome, OperationPersistenceError>;
}

interface ResultAcceptanceDependencies {
  readonly store: EventStore;
}

function persistenceError(
  operationId: string,
  error: StoreError,
): OperationPersistenceError {
  return new OperationPersistenceError(
    operationId,
    error.code === "not_found" ? "corrupt_record" : error.code,
  );
}

export function makeResultAcceptance(
  dependencies: ResultAcceptanceDependencies,
): ResultAcceptance {
  return {
    accept(operationId, deliveries) {
      return Effect.gen(function* () {
        if (
          deliveries.length === 0 ||
          deliveries.some((delivery) =>
            resultDeliveryViolation(operationId, delivery) !== undefined
          )
        ) {
          return { state: "protocol_failed" } as const;
        }

        let acceptedResult: Result | undefined;
        let resultDeliveryError: ResultConflictError | undefined;
        const proofs: Array<ResultAcceptanceProof> = [];

        for (const delivery of deliveries) {
          const acceptance = yield* Effect.either(
            dependencies.store.advance(operationId, {
              type: "accept_result",
              delivery,
            }),
          );
          if (acceptance._tag === "Left") {
            if (acceptance.left instanceof ResultConflictError) {
              resultDeliveryError ??= acceptance.left;
              if (acceptedResult === undefined) {
                const snapshot = yield* dependencies.store.read(operationId).pipe(
                  Effect.mapError((error) => persistenceError(operationId, error)),
                );
                if (snapshot.result === undefined) {
                  return yield* Effect.fail(
                    new OperationPersistenceError(operationId, "incomplete_record"),
                  );
                }
                acceptedResult = snapshot.result;
              }
              continue;
            }
            return yield* Effect.fail(
              persistenceError(operationId, acceptance.left),
            );
          }

          if (
            acceptance.right.result === undefined ||
            acceptance.right.resultAcceptanceProof === undefined
          ) {
            return yield* Effect.fail(
              new OperationPersistenceError(operationId, "incomplete_record"),
            );
          }
          acceptedResult = acceptance.right.result;
          proofs.push(acceptance.right.resultAcceptanceProof);
        }

        if (acceptedResult === undefined) {
          return { state: "protocol_failed" } as const;
        }
        return {
          state: "accepted",
          proofs,
          ...(resultDeliveryError === undefined ? {} : { resultDeliveryError }),
        } as const;
      });
    },
  };
}
