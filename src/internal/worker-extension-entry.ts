import { statSync } from "node:fs";
import { extname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

/**
 * 可視ワーカーが読み込むPions所有の拡張を解決し、検証する。
 *
 * 既定では、このモジュールと同じ形式(ソースなら`.ts`、ビルド済みなら`.js`)の
 * 隣接するワーカー拡張だけを使い、委譲元とワーカーが同じ版のコードで動くようにする。
 */
export function resolveWorkerExtensionEntryPath(
  options: {
    readonly explicitPath?: string;
    readonly moduleUrl?: string;
    readonly cwd?: string;
  } = {}
): string {
  const moduleUrl = options.moduleUrl ?? import.meta.url;
  const candidate =
    options.explicitPath ??
    fileURLToPath(
      new URL(
        `../worker-extension${extname(fileURLToPath(moduleUrl))}`,
        moduleUrl
      )
    );
  const validationPath = isAbsolute(candidate)
    ? candidate
    : resolve(options.cwd ?? process.cwd(), candidate);
  let available: boolean;
  try {
    available = isRegularFile(validationPath);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Pions Worker extension entry cannot be inspected at ${validationPath}: ${reason}`,
      { cause: error }
    );
  }
  if (!available)
    throw new Error(
      `Pions Worker extension entry is unavailable: ${validationPath}`
    );
  return candidate;
}
