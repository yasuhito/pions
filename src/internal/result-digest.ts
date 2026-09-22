import { createHash } from "node:crypto";

import type { Sha256Digest } from "../public.js";

export function sha256Digest(bytes: Uint8Array | string): Sha256Digest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
