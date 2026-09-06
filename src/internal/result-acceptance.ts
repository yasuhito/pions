import { Effect } from "effect";

import type { EventStore, StoreError } from "./event-store/index.js";
import type { ChildChannel } from "./services.js";
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
            dependencies.store.advance(operationId, {
              type: "accept_result",
              delivery,
            }),
          );
          if (acceptance._tag === "Left") {
            if (acceptance.left instanceof ResultConflictError) {
              resultDeliveryError = acceptance.left;
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
              break;
            }
            return yield* Effect.fail(
              persistenceError(operationId, acceptance.left),
            );
          }

          if (acceptance.right.result === undefined) {
            return yield* Effect.fail(
              new OperationPersistenceError(operationId, "incomplete_record"),
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
              acceptedResult: acceptance.right.result,
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
