import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/** 可視ワーカーが読み込むPions所有の拡張を解決し、検証する。 */
export function resolveWorkerExtensionEntryPath(options: {
  readonly explicitPath?: string;
  readonly moduleUrl?: string;
  readonly cwd?: string;
} = {}): string {
  const moduleUrl = options.moduleUrl ?? import.meta.url;
  const candidates = options.explicitPath === undefined
    ? [
        fileURLToPath(new URL("../worker-extension.js", moduleUrl)),
        fileURLToPath(new URL("../../dist/src/worker-extension.js", moduleUrl)),
      ]
    : [options.explicitPath];
  const cwd = options.cwd ?? process.cwd();
  const validationPaths = candidates.map((candidate) =>
    isAbsolute(candidate) ? candidate : resolve(cwd, candidate));
  for (const [index, validationPath] of validationPaths.entries()) {
    try {
      if (isRegularFile(validationPath)) return candidates[index]!;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Pions Worker extension entry cannot be inspected at ${validationPath}: ${reason}`);
    }
  }
  throw new Error(`Pions Worker extension entry is unavailable: ${validationPaths.join(", ")}`);
}
