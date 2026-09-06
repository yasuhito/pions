import { Effect } from "effect";

import type { ChildChannel, EventStore, StoreError } from "./services.js";
import {
  OperationPersistenceError,
  ResultConflictError,
} from "../public.js";
import type { Result } from "../public.js";

export type ResultAcceptanceOutcome =
  | {
      readonly state: "accepted";
      readonly result: Result;
      readonly resultDeliveryError?: ResultConflictError;
    }
  | {
      readonly state: "protocol_failed";
      readonly acceptedResult?: Result;
    };

export interface ResultAcceptance {
  acceptFromWorker(
    operationId: string,
  ): Effect.Effect<ResultAcceptanceOutcome, OperationPersistenceError>;
}

interface ResultAcceptanceDependencies {
  readonly channel: ChildChannel;
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
    acceptFromWorker(operationId) {
      return Effect.gen(function* () {
        const reception = yield* Effect.either(
          dependencies.channel.receiveResults(operationId),
        );
        if (reception._tag === "Left" || reception.right.deliveries.length === 0) {
          return { state: "protocol_failed" } as const;
        }

        let acceptedResult: Result | undefined;
        let resultDeliveryError: ResultConflictError | undefined;

        for (const delivery of reception.right.deliveries) {
          const acceptance = yield* Effect.either(
            dependencies.store.acceptResult(operationId, delivery),
          );
          if (acceptance._tag === "Left") {
            if (acceptance.left instanceof ResultConflictError) {
              resultDeliveryError ??= acceptance.left;
              if (acceptedResult === undefined) {
                acceptedResult = yield* dependencies.store.readResult(operationId).pipe(
                  Effect.mapError((error) => persistenceError(operationId, error)),
                );
              }
              continue;
            }
            return yield* Effect.fail(
              persistenceError(operationId, acceptance.left),
            );
          }

          acceptedResult = acceptance.right.result;
          const acknowledgement = yield* Effect.either(
            dependencies.channel.acknowledgeResult(
              operationId,
              delivery.sequenceNumber,
            ),
          );
          if (acknowledgement._tag === "Left") {
            return {
              state: "protocol_failed",
              acceptedResult,
            } as const;
          }
        }

        if (acceptedResult === undefined) {
          return { state: "protocol_failed" } as const;
        }
        return {
          state: "accepted",
          result: acceptedResult,
          ...(resultDeliveryError === undefined ? {} : { resultDeliveryError }),
        } as const;
      });
    },
  };
}
