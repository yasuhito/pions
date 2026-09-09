import { createHash } from "node:crypto";

import type { ArtifactDigest } from "../public.js";

export function sha256Digest(bytes: Uint8Array | string): ArtifactDigest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
