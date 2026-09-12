import { createHash } from "node:crypto";

import type { StartupReceipt } from "../public.js";
import { canonicalJson } from "./canonical-json.js";

export function startupReceiptDigest(
  receipt: Omit<StartupReceipt, "digest">
): StartupReceipt["digest"] {
  return `sha256:${createHash("sha256")
    .update(canonicalJson(receipt), "utf8")
    .digest("hex")}`;
}
