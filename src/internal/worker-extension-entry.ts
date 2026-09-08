import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CLAUDE_BRIDGE_PACKAGE = "pi-claude-bridge";
export const CLAUDE_BRIDGE_VERSION = "0.7.0";
export const CLAUDE_BRIDGE_SOURCE_DIGEST = "sha256:b2ddc3215775cb12589ab54576d882e8c2eb1aadcba89eb9bd99bef40d93ea49";

export interface ApprovedProviderExtension {
  readonly provider: "claude-bridge";
  readonly packageName: typeof CLAUDE_BRIDGE_PACKAGE;
  readonly version: typeof CLAUDE_BRIDGE_VERSION;
  readonly sourceDigest: typeof CLAUDE_BRIDGE_SOURCE_DIGEST;
  readonly entryPath: string;
}

interface ClaudeBridgeConfig {
  readonly askClaude?: { readonly enabled?: unknown };
  readonly provider?: {
    readonly strictMcpConfig?: unknown;
    readonly autoMemoryEnabled?: unknown;
    readonly longContextExtraUsage?: unknown;
  };
}

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

function configRecord(value: unknown, name: string): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must contain an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function readClaudeBridgeConfig(path: string): ClaudeBridgeConfig {
  try {
    const value = configRecord(JSON.parse(readFileSync(path, "utf8")) as unknown, "configuration")!;
    const askClaude = configRecord(value.askClaude, "askClaude");
    const provider = configRecord(value.provider, "provider");
    return {
      ...(askClaude === undefined ? {} : { askClaude }),
      ...(provider === undefined ? {} : { provider }),
    };
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return {};
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Claude bridge configuration cannot be inspected at ${path}: ${reason}`);
  }
}

/** PionsワーカーでClaude bridgeの安全側の設定だけが有効であることを検証する。 */
export function validateClaudeBridgePolicy(options: {
  readonly cwd: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory?: string;
}): void {
  const environment = options.environment ?? process.env;
  const agentDirectory = environment.PI_CODING_AGENT_DIR ?? join(
    options.homeDirectory ?? homedir(),
    ".pi",
    "agent",
  );
  const globalConfig = readClaudeBridgeConfig(join(agentDirectory, "claude-bridge.json"));
  const projectConfig = readClaudeBridgeConfig(join(options.cwd, ".pi", "claude-bridge.json"));
  const askClaude = { ...globalConfig.askClaude, ...projectConfig.askClaude };
  const provider = { ...globalConfig.provider, ...projectConfig.provider };
  if (askClaude.enabled !== undefined && askClaude.enabled !== false) {
    throw new Error("Pions Claude Workers require AskClaude to remain disabled");
  }
  if (provider.strictMcpConfig !== undefined && provider.strictMcpConfig !== true) {
    throw new Error("Pions Claude Workers require strictMcpConfig to remain enabled");
  }
  if (provider.autoMemoryEnabled !== undefined && provider.autoMemoryEnabled !== false) {
    throw new Error("Pions Claude Workers require Claude Code auto-memory to remain disabled");
  }
  if (provider.longContextExtraUsage !== undefined && provider.longContextExtraUsage !== false) {
    throw new Error("Pions Claude Workers forbid Claude Extra Usage");
  }
}

function sourceDigest(root: string): `sha256:${string}` {
  const files: Array<string> = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const status = statSync(path);
      if (status.isDirectory()) visit(path);
      else if (status.isFile()) files.push(path);
    }
  };
  visit(root);
  const digest = createHash("sha256");
  for (const path of files) {
    digest.update(path.slice(root.length + 1));
    digest.update("\0");
    digest.update(readFileSync(path));
    digest.update("\0");
  }
  return `sha256:${digest.digest("hex")}`;
}

/** 監査済みの固定版Claude bridgeを解決し、起動前に版とエントリーを検証する。 */
export function resolveClaudeBridgeExtension(options: {
  readonly packagePath?: string;
  readonly moduleUrl?: string;
} = {}): ApprovedProviderExtension {
  const moduleUrl = options.moduleUrl ?? import.meta.url;
  const packagePath = options.packagePath ?? createRequire(moduleUrl).resolve(
    `${CLAUDE_BRIDGE_PACKAGE}/package.json`,
  );
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(packagePath, "utf8")) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Approved Claude bridge manifest cannot be inspected at ${packagePath}: ${reason}`);
  }
  const record = typeof manifest === "object" && manifest !== null
    ? manifest as { readonly name?: unknown; readonly version?: unknown }
    : undefined;
  if (record?.name !== CLAUDE_BRIDGE_PACKAGE || typeof record.version !== "string") {
    throw new Error(`Approved Claude bridge manifest is invalid at ${packagePath}`);
  }
  if (record.version !== CLAUDE_BRIDGE_VERSION) {
    throw new Error(
      `Installed Claude bridge version ${record.version} does not match expected ${CLAUDE_BRIDGE_VERSION}`,
    );
  }
  const sourceRoot = join(dirname(packagePath), "src");
  const entryPath = join(sourceRoot, "index.ts");
  if (!isRegularFile(entryPath)) {
    throw new Error(`Approved Claude bridge extension entry is unavailable: ${entryPath}`);
  }
  const observedDigest = sourceDigest(sourceRoot);
  if (observedDigest !== CLAUDE_BRIDGE_SOURCE_DIGEST) {
    throw new Error(`Installed Claude bridge source digest ${observedDigest} is not approved by Pions`);
  }
  return Object.freeze({
    provider: "claude-bridge",
    packageName: CLAUDE_BRIDGE_PACKAGE,
    version: CLAUDE_BRIDGE_VERSION,
    sourceDigest: CLAUDE_BRIDGE_SOURCE_DIGEST,
    entryPath,
  });
}

/** 解決済みの許可拡張が起動直前にも固定版を指すことを再検査する。 */
export function verifyApprovedProviderExtension(
  extension: Readonly<ApprovedProviderExtension>,
): ApprovedProviderExtension {
  if (
    extension.provider !== "claude-bridge" ||
    extension.packageName !== CLAUDE_BRIDGE_PACKAGE ||
    extension.version !== CLAUDE_BRIDGE_VERSION ||
    extension.sourceDigest !== CLAUDE_BRIDGE_SOURCE_DIGEST
  ) {
    throw new Error("Provider extension is not approved by Pions");
  }
  const packagePath = join(dirname(dirname(extension.entryPath)), "package.json");
  const verified = resolveClaudeBridgeExtension({ packagePath });
  if (verified.entryPath !== extension.entryPath) {
    throw new Error("Approved Claude bridge entry path changed before Worker launch");
  }
  return verified;
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
