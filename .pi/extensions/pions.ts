import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { pathToFileURL } from "node:url";

import { installPionsExtension } from "../../src/internal/pi-extension.ts";
import {
  resolveClaudeBridgeExtension,
  validateClaudeBridgePolicy,
} from "../../src/internal/worker-extension-entry.ts";

export default async function pionsExtension(pi: ExtensionAPI): Promise<void> {
  const claudeBridge = resolveClaudeBridgeExtension();
  validateClaudeBridgePolicy({ cwd: process.cwd() });
  const extension = await import(pathToFileURL(claudeBridge.entryPath).href) as {
    readonly default: (api: ExtensionAPI) => void;
  };
  extension.default(pi);
  installPionsExtension(pi);
}
