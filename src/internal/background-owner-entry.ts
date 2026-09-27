import { readFile } from "node:fs/promises";

import { hasCode } from "./has-code.js";

import {
  runBackgroundOwner,
  type BackgroundOwnerRequest,
} from "./background-owner.js";

const requestPath = process.argv[2];
if (requestPath === undefined)
  throw new Error("Background owner request is missing");

let request: BackgroundOwnerRequest | undefined;
try {
  request = JSON.parse(
    await readFile(requestPath, "utf8")
  ) as BackgroundOwnerRequest;
  await runBackgroundOwner(request, async (operationId) => {
    if (process.send === undefined)
      throw new Error("Background owner start acknowledgement is unavailable");
    await new Promise<void>((resolve, reject) => {
      process.send!({ type: "started", operationId }, (error) =>
        error ? reject(error) : resolve()
      );
    });
    if (process.connected) process.disconnect?.();
  });
} catch (error) {
  if (process.send !== undefined && process.connected) {
    await new Promise<void>((resolve) => {
      process.send!(
        hasCode(error, "EADDRINUSE") && request !== undefined
          ? { type: "already-owned", operationId: request.operationId }
          : {
              type: "failed",
              message: error instanceof Error ? error.message : String(error),
            },
        () => resolve()
      );
    });
    process.disconnect?.();
  }
  process.exitCode = 1;
}
