import { createHash } from "node:crypto";

import type { Result } from "../public.js";

export function resultDigest(bytes: Uint8Array): Result["digest"] {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
