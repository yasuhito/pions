import type { StartupReceipt } from "../public.js";
import { canonicalJson } from "./canonical-json.js";
import { sha256Digest } from "./result-digest.js";

export function startupReceiptDigest(
  receipt: Omit<StartupReceipt, "digest">
): StartupReceipt["digest"] {
  return sha256Digest(canonicalJson(receipt));
}
