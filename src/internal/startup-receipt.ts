import { createHash } from "node:crypto";

import type { StartupReceipt } from "../public.js";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function startupReceiptDigest(
  receipt: Omit<StartupReceipt, "digest">
): StartupReceipt["digest"] {
  return `sha256:${createHash("sha256")
    .update(canonicalJson(receipt), "utf8")
    .digest("hex")}`;
}
