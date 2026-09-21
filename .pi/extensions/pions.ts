import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { installPionsExtension } from "../../src/internal/pi-extension.ts";

export default function pionsExtension(pi: ExtensionAPI): void {
  installPionsExtension(pi);
}
