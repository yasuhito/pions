import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  DefaultPackageManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { hasCode } from "./has-code.js";
import { WorkerConfigurationError } from "./types.js";
import type { WorkerExtension } from "./types.js";

/**
 * Resolves Pi package sources, written as in Pi settings, to the enabled
 * extension files of the packages already installed for the delegating Pi.
 */
export type WorkerExtensionPackageResolver = (
  sources: ReadonlyArray<string>,
  cwd: string,
  piAgentDirectory: string
) => Promise<ReadonlyArray<Readonly<WorkerExtension>>>;

/** Pi's own package resolution; missing packages are never installed. */
export const resolvePiExtensionPackages: WorkerExtensionPackageResolver =
  async (sources, cwd, piAgentDirectory) => {
    if (sources.length === 0) return [];
    const packageManager = new DefaultPackageManager({
      cwd,
      agentDir: piAgentDirectory,
      settingsManager: SettingsManager.create(cwd, piAgentDirectory),
    });
    const resolved = await packageManager.resolve(() =>
      Promise.resolve("skip")
    );
    return resolved.extensions
      .filter(
        ({ enabled, metadata }) =>
          enabled &&
          metadata.origin === "package" &&
          sources.includes(metadata.source)
      )
      .map(({ metadata, path }) => ({ source: metadata.source, path }));
  };

const HERDR_INTEGRATION_SOURCE = "herdr";
const PIONS_PACKAGE_NAME = "@yasuhito/pions";

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function packageName(path: string): Promise<string | undefined> {
  for (let directory = dirname(path); ; directory = dirname(directory)) {
    try {
      const manifest = JSON.parse(
        await readFile(join(directory, "package.json"), "utf8")
      ) as unknown;
      return typeof manifest === "object" &&
        manifest !== null &&
        "name" in manifest &&
        typeof manifest.name === "string"
        ? manifest.name
        : undefined;
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
    if (dirname(directory) === directory) return undefined;
  }
}

/**
 * Pi extensions the Worker loads besides the Pions Worker extension: the
 * Herdr integration when installed, then every configured package.
 */
export async function workerExtensions(options: {
  readonly sources: ReadonlyArray<string>;
  readonly cwd: string;
  readonly piAgentDirectory: string;
  readonly resolvePackages: WorkerExtensionPackageResolver;
}): Promise<ReadonlyArray<Readonly<WorkerExtension>>> {
  const configured = await options.resolvePackages(
    options.sources,
    options.cwd,
    options.piAgentDirectory
  );
  for (const source of options.sources) {
    if (!configured.some((extension) => extension.source === source)) {
      throw new WorkerConfigurationError(
        "unsupported_capability",
        `Worker extension package ${source} is not installed and enabled in Pi`
      );
    }
  }
  for (const extension of configured) {
    if ((await packageName(extension.path)) === PIONS_PACKAGE_NAME) {
      throw new WorkerConfigurationError(
        "unsupported_capability",
        `Worker extension package ${extension.source} is Pions itself, which Workers cannot load`
      );
    }
  }
  const herdrIntegration = join(
    options.piAgentDirectory,
    "extensions",
    "herdr-agent-state.ts"
  );
  return Object.freeze([
    ...((await isFile(herdrIntegration))
      ? [{ source: HERDR_INTEGRATION_SOURCE, path: herdrIntegration }]
      : []),
    ...configured,
  ]);
}
