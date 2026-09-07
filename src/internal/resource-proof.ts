import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

import type {
  CanonicalProofDocument,
  ExternalResourcePermission,
  PermissionManifest,
  WorkspaceAccessScope,
} from "../public.js";
import { ResourceProofRejectedError } from "../public.js";

const MAX_RAW_BYTES = 2 * 1024 * 1024;
const MAX_CANONICAL_BYTES = 1024 * 1024;
const MAX_DEPTH = 32;
const MAX_ELEMENTS = 10_000;
const MAX_STRING_BYTES = 256 * 1024;

function reject(reason: "invalid_proof" | "proof_limit_exceeded", message: string): never {
  throw new ResourceProofRejectedError(reason, message);
}

class JsonParser {
  private index = 0;
  private elements = 0;

  constructor(private readonly source: string) {}

  parse(): unknown {
    const value = this.value(1);
    this.space();
    if (this.index !== this.source.length) reject("invalid_proof", "Unexpected data after proof JSON");
    return value;
  }

  private value(depth: number): unknown {
    if (depth > MAX_DEPTH) reject("proof_limit_exceeded", "Proof JSON exceeds its depth limit");
    this.space();
    const character = this.source[this.index];
    if (character === "{") return this.object(depth);
    if (character === "[") return this.array(depth);
    if (character === '"') return this.string();
    if (this.source.startsWith("true", this.index)) { this.index += 4; return true; }
    if (this.source.startsWith("false", this.index)) { this.index += 5; return false; }
    if (this.source.startsWith("null", this.index)) { this.index += 4; return null; }
    return this.number();
  }

  private object(depth: number): Record<string, unknown> {
    this.index += 1;
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const keys = new Set<string>();
    this.space();
    if (this.source[this.index] === "}") { this.index += 1; return output; }
    while (true) {
      this.space();
      if (this.source[this.index] !== '"') reject("invalid_proof", "Proof object key must be a string");
      const key = this.string();
      if (keys.has(key)) reject("invalid_proof", "Proof object contains a duplicate decoded key");
      keys.add(key);
      this.space();
      if (this.source[this.index] !== ":") reject("invalid_proof", "Proof object is missing a colon");
      this.index += 1;
      this.countElement();
      output[key] = this.value(depth + 1);
      this.space();
      const separator = this.source[this.index++];
      if (separator === "}") return output;
      if (separator !== ",") reject("invalid_proof", "Proof object is not terminated");
    }
  }

  private array(depth: number): ReadonlyArray<unknown> {
    this.index += 1;
    const output: Array<unknown> = [];
    this.space();
    if (this.source[this.index] === "]") { this.index += 1; return output; }
    while (true) {
      this.countElement();
      output.push(this.value(depth + 1));
      this.space();
      const separator = this.source[this.index++];
      if (separator === "]") return output;
      if (separator !== ",") reject("invalid_proof", "Proof array is not terminated");
    }
  }

  private string(): string {
    const start = this.index;
    this.index += 1;
    let escaped = false;
    while (this.index < this.source.length) {
      const code = this.source.charCodeAt(this.index);
      if (code < 0x20) reject("invalid_proof", "Proof string contains a control character");
      if (code === 0x22 && !escaped) {
        this.index += 1;
        const encoded = this.source.slice(start, this.index);
        let decoded: string;
        try { decoded = JSON.parse(encoded) as string; } catch { reject("invalid_proof", "Proof string is malformed"); }
        for (let offset = 0; offset < decoded.length; offset += 1) {
          const unit = decoded.charCodeAt(offset);
          if (unit >= 0xd800 && unit <= 0xdbff) {
            const low = decoded.charCodeAt(offset + 1);
            if (!Number.isInteger(low) || low < 0xdc00 || low > 0xdfff) reject("invalid_proof", "Proof string contains an isolated surrogate");
            offset += 1;
          } else if (unit >= 0xdc00 && unit <= 0xdfff) {
            reject("invalid_proof", "Proof string contains an isolated surrogate");
          }
        }
        if (Buffer.byteLength(decoded, "utf8") > MAX_STRING_BYTES) {
          reject("proof_limit_exceeded", "Proof string exceeds its byte limit");
        }
        return decoded;
      }
      if (code === 0x5c && !escaped) escaped = true;
      else escaped = false;
      this.index += 1;
    }
    reject("invalid_proof", "Proof string is unterminated");
  }

  private number(): number {
    const rest = this.source.slice(this.index);
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
    if (match === null) reject("invalid_proof", "Proof JSON contains an invalid value");
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) reject("invalid_proof", "Proof number is not finite");
    return value;
  }

  private space(): void {
    while (this.index < this.source.length) {
      const character = this.source[this.index];
      if (character !== " " && character !== "\n" && character !== "\r" && character !== "\t") return;
      this.index += 1;
    }
  }

  private countElement(): void {
    this.elements += 1;
    if (this.elements > MAX_ELEMENTS) reject("proof_limit_exceeded", "Proof JSON exceeds its element limit");
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function parseProofDocument(bytes: Uint8Array): Readonly<CanonicalProofDocument> {
  if (bytes.byteLength > MAX_RAW_BYTES) reject("proof_limit_exceeded", "Proof JSON exceeds its raw byte limit");
  let source: string;
  try { source = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { reject("invalid_proof", "Proof JSON is not valid UTF-8"); }
  const value = new JsonParser(source).parse();
  const json = canonicalJson(value);
  const byteCount = Buffer.byteLength(json, "utf8");
  if (byteCount > MAX_CANONICAL_BYTES) reject("proof_limit_exceeded", "Proof JSON exceeds its canonical byte limit");
  return Object.freeze({
    json,
    byteCount,
    digest: `sha256:${createHash("sha256").update(json, "utf8").digest("hex")}`,
    value,
  });
}

function normalizedLiteral(input: string): string {
  if (input.length === 0 || isAbsolute(input) || input.includes("\\") || /[*?\[\]{}]/u.test(input)) {
    throw new ResourceProofRejectedError("permission_mismatch", "Workspace access must use relative literal paths");
  }
  const parts = input.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new ResourceProofRejectedError("permission_mismatch", "Workspace access contains a non-normalized path segment");
  }
  return parts.join("/");
}

function normalizeScope(scope: Readonly<WorkspaceAccessScope>): WorkspaceAccessScope {
  if (scope.kind !== "literals") return Object.freeze({ kind: scope.kind });
  if (scope.paths.length === 0) {
    throw new ResourceProofRejectedError("permission_mismatch", "A literal workspace scope must not be empty");
  }
  return Object.freeze({ kind: "literals", paths: Object.freeze([...new Set(scope.paths.map(normalizedLiteral))].sort()) });
}

function resourceKey(resource: Readonly<ExternalResourcePermission>): string {
  if (resource.authorityId.length === 0 || resource.selector.length === 0) {
    throw new ResourceProofRejectedError("permission_mismatch", "External resource identifiers must not be empty");
  }
  return `${resource.authorityId}\u0000${resource.selector}`;
}

export function normalizePermissionManifest(input: Readonly<PermissionManifest>): Readonly<PermissionManifest> {
  const resources = new Map<string, ExternalResourcePermission>();
  for (const resource of input.externalResources) {
    const key = resourceKey(resource);
    const previous = resources.get(key);
    if (previous !== undefined && previous.usage !== resource.usage) {
      throw new ResourceProofRejectedError("permission_contradiction", "One external resource has conflicting usage modes");
    }
    resources.set(key, Object.freeze({ ...resource }));
  }
  const tools = [...new Set(input.tools)];
  if (tools.some((tool) => tool.length === 0)) {
    throw new ResourceProofRejectedError("permission_mismatch", "Tool identifiers must not be empty");
  }
  return Object.freeze({
    tools: Object.freeze(tools.sort()),
    read: normalizeScope(input.read),
    write: normalizeScope(input.write),
    commands: input.commands,
    network: input.network,
    externalResources: Object.freeze([...resources.values()].sort((left, right) =>
      `${resourceKey(left)}\u0000${left.usage}`.localeCompare(`${resourceKey(right)}\u0000${right.usage}`),
    )),
  });
}

export function permissionManifestsMatch(
  requested: Readonly<PermissionManifest>,
  effective: Readonly<PermissionManifest>,
): boolean {
  return isDeepStrictEqual(normalizePermissionManifest(requested), normalizePermissionManifest(effective));
}

function isWithin(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

async function realExistingPath(path: string): Promise<string> {
  let candidate = path;
  const suffix: Array<string> = [];
  while (true) {
    try {
      await lstat(candidate);
      const existing = await realpath(candidate);
      return resolve(existing, ...suffix.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw new ResourceProofRejectedError("permission_mismatch", "Workspace path cannot be inspected");
      }
      const parent = dirname(candidate);
      if (parent === candidate) throw new ResourceProofRejectedError("permission_mismatch", "Workspace path has no existing ancestor");
      suffix.push(candidate.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      candidate = parent;
    }
  }
}

export async function validateWorkspaceScope(
  workspace: string,
  scopeInput: Readonly<WorkspaceAccessScope>,
): Promise<true> {
  const scope = normalizeScope(scopeInput);
  const workspaceRoot = await realpath(workspace).catch(() => {
    throw new ResourceProofRejectedError("permission_mismatch", "Workspace cannot be resolved");
  });
  if (scope.kind !== "literals") return true;
  for (const literal of scope.paths) {
    const target = await realExistingPath(resolve(workspaceRoot, literal));
    if (!isWithin(workspaceRoot, target)) {
      throw new ResourceProofRejectedError("permission_mismatch", "Workspace path resolves outside the workspace");
    }
    const resolvedLiteral = relative(workspaceRoot, target).split(sep).join("/");
    const remainsAllowed = scope.paths.some((allowed) =>
      resolvedLiteral === allowed || resolvedLiteral.startsWith(`${allowed}/`),
    );
    if (!remainsAllowed) {
      throw new ResourceProofRejectedError("permission_mismatch", "Workspace path resolves outside its declared literal scope");
    }
  }
  return true;
}

export function permissionManifestDocument(manifest: Readonly<PermissionManifest>): Readonly<CanonicalProofDocument> {
  return parseProofDocument(Buffer.from(canonicalJson(normalizePermissionManifest(manifest)), "utf8"));
}
