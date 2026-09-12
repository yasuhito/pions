import { createHash } from "node:crypto";
import { chmod, mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse } from "node:path";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

export function opaqueDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
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

async function findRepositoryRoot(cwd: string): Promise<string> {
  let current = await realpath(cwd);
  const filesystemRoot = parse(current).root;
  while (true) {
    if (await pathExists(join(current, ".git"))) return current;
    if (current === filesystemRoot) return await realpath(cwd);
    current = dirname(current);
  }
}

function userStateDirectory(
  environment: Readonly<Record<string, string | undefined>>,
  home: string
): string {
  const configured = environment.XDG_STATE_HOME;
  return configured !== undefined && isAbsolute(configured)
    ? configured
    : join(home, ".local", "state");
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: DIRECTORY_MODE });
  await chmod(path, DIRECTORY_MODE);
}

export async function writePrivatePrompt(
  path: string,
  body: string
): Promise<void> {
  await privateDirectory(dirname(path));
  try {
    await writeFile(path, body, {
      encoding: "utf8",
      mode: FILE_MODE,
      flag: "wx",
    });
  } catch (error) {
    if (!(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EEXIST"
    )) {
      throw error;
    }
  }
  await chmod(path, FILE_MODE);
}

export async function resolveRepositoryState(options: {
  readonly cwd: string;
  readonly repositoryRoot?: string;
  readonly stateBaseDirectory?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory?: string;
}): Promise<{
  readonly normalizedRoot: string;
  readonly repositoryState: string;
}> {
  const root =
    options.repositoryRoot ?? (await findRepositoryRoot(options.cwd));
  const normalizedRoot = await realpath(root);
  const stateBase =
    options.stateBaseDirectory ??
    userStateDirectory(
      options.environment ?? process.env,
      options.homeDirectory ?? homedir()
    );
  const repositoryState = join(
    stateBase,
    "pions",
    "repositories",
    opaqueDigest(normalizedRoot)
  );
  await privateDirectory(repositoryState);
  return { normalizedRoot, repositoryState };
}
