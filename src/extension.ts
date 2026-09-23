import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { installPionsExtension } from "./internal/pi-extension.js";

export default function pionsExtension(pi: ExtensionAPI): void {
  installPionsExtension(pi);
}
