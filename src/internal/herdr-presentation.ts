import { execFile } from "node:child_process";

import { Effect } from "effect";

import type { CreatedPresentation, Operation } from "./event-store/index.js";
import type { Presentation } from "./services.js";
import { HerdrPreconditionError } from "../public.js";

export interface CommandInvocation {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly shell: false;
}

export interface CommandOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface CommandExecutor {
  execute(invocation: CommandInvocation): Effect.Effect<CommandOutput, unknown>;
}

export class NodeCommandExecutor implements CommandExecutor {
  execute(invocation: CommandInvocation): Effect.Effect<CommandOutput, Error> {
    return Effect.async<CommandOutput, Error>((resume) => {
      execFile(
        invocation.executable,
        [...invocation.args],
        {
          cwd: invocation.cwd,
          shell: invocation.shell,
          encoding: "utf8",
          maxBuffer: 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (error !== null) {
            resume(Effect.fail(error));
            return;
          }
          resume(Effect.succeed({ stdout, stderr, exitCode: 0 }));
        }
      );
    });
  }
}

interface HerdrPresentationOptions {
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly executor: CommandExecutor;
}

interface HerdrEnvelope {
  readonly result?: unknown;
  readonly error?: { readonly code?: unknown; readonly message?: unknown };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

const MAX_PRESENTATION_CONFIG_BYTES = 512;
const SHORT_OPERATION_IDENTIFIER_LENGTH = 8;

/** The Worker workspace label: a short Operation identifier and never the task body. */
export function workerWorkspaceLabel(operationId: string): string {
  return `Pions ${operationId.slice(0, SHORT_OPERATION_IDENTIFIER_LENGTH)}`;
}

function boundedPresentationText(value: string): string {
  const normalized = value.replaceAll(/[\r\n\0]/gu, " ");
  if (Buffer.byteLength(normalized, "utf8") <= MAX_PRESENTATION_CONFIG_BYTES)
    return normalized;
  let bounded = "";
  for (const character of normalized) {
    if (
      Buffer.byteLength(bounded + character, "utf8") >
      MAX_PRESENTATION_CONFIG_BYTES
    )
      break;
    bounded += character;
  }
  return bounded;
}

function configurationProjection(operation: Readonly<Operation>): string {
  const effective = operation.effectiveConfig;
  const observed = operation.observedConfig;
  const observedModel =
    observed?.model.state === "observed"
      ? `${observed.model.value.provider}/${observed.model.value.id}`
      : "unavailable";
  const observedThinking =
    observed?.thinkingLevel.state === "observed"
      ? observed.thinkingLevel.value
      : "unavailable";
  const observedTools =
    observed?.tools.state === "observed"
      ? observed.tools.value.join(",")
      : "unavailable";
  const observedCwd =
    observed?.cwd.state === "observed" ? observed.cwd.value : "unavailable";
  return boundedPresentationText(
    `effective(model=${effective.model.provider}/${effective.model.id};thinking=${effective.thinkingLevel};tools=${effective.tools.join(",")};cwd=${effective.cwd}) ` +
      `observed(model=${observedModel};thinking=${observedThinking};tools=${observedTools};cwd=${observedCwd})`
  );
}

function commandFailure(output: CommandOutput): Error | undefined {
  if (output.exitCode === 0) return undefined;
  return new Error(
    output.stderr.trim() ||
      output.stdout.trim() ||
      `Herdr exited with ${output.exitCode}`
  );
}

export class HerdrPresentation implements Presentation {
  constructor(private readonly options: HerdrPresentationOptions) {}

  preflight(): Effect.Effect<void, HerdrPreconditionError> {
    return Effect.suspend(() => {
      const required = [
        "HERDR_ENV",
        "HERDR_WORKSPACE_ID",
        "HERDR_TAB_ID",
        "HERDR_PANE_ID",
      ] as const;
      const missing = required.filter((name) => {
        const value = this.options.environment[name];
        return (
          value === undefined ||
          value.length === 0 ||
          (name === "HERDR_ENV" && value !== "1")
        );
      });
      return missing.length === 0
        ? Effect.void
        : Effect.fail(new HerdrPreconditionError(missing));
    });
  }

  /**
   * Create one dedicated Worker workspace without moving focus. The current
   * workspace, tab, and pane are never split or targeted.
   */
  create(operation: Operation): Effect.Effect<CreatedPresentation, Error> {
    return this.executeJson([
      "workspace",
      "create",
      "--cwd",
      this.options.cwd,
      "--label",
      workerWorkspaceLabel(operation.operationId),
      "--no-focus",
    ]).pipe(
      Effect.map((envelope) => {
        const result = object(envelope.result);
        const workspaceId = nonEmptyString(
          object(result?.workspace)?.workspace_id
        );
        const paneId = nonEmptyString(object(result?.root_pane)?.pane_id);
        if (workspaceId === undefined) {
          throw new Error(
            "Herdr workspace create response has no opaque workspace identifier"
          );
        }
        if (paneId === undefined) {
          throw new Error(
            "Herdr workspace create response has no opaque root pane identifier"
          );
        }
        return Object.freeze({
          kind: "herdr_workspace" as const,
          workspaceId,
          paneId,
        });
      })
    );
  }

  rollbackCreated(
    presentation: CreatedPresentation
  ): Effect.Effect<void, unknown> {
    return Effect.asVoid(
      this.executeJson(["workspace", "close", presentation.workspaceId])
    );
  }

  /**
   * Herdr never reuses a closed workspace identifier, so the persisted
   * identifier appearing in the current workspace list is the identity check.
   */
  inspectOwnedWorkspace(
    operation: Operation
  ): Effect.Effect<"matching" | "missing", unknown> {
    if (operation.presentation === undefined) return Effect.succeed("missing");
    const workspaceId = operation.presentation.workspaceId;
    return this.executeJson(["workspace", "list"]).pipe(
      Effect.map((envelope) => {
        const result = object(envelope.result);
        const workspaces = result?.workspaces;
        if (!Array.isArray(workspaces))
          throw new Error(
            "Herdr workspace list response has no workspace list"
          );
        return workspaces.some(
          (workspace) => object(workspace)?.workspace_id === workspaceId
        )
          ? ("matching" as const)
          : ("missing" as const);
      })
    );
  }

  closeOwnedWorkspace(operation: Operation): Effect.Effect<void, unknown> {
    if (operation.presentation === undefined) return Effect.void;
    return this.rollbackCreated(operation.presentation);
  }

  project(operation: Operation): Effect.Effect<void, unknown> {
    if (operation.presentation === undefined) return Effect.void;
    const status =
      operation.state === "blocked"
        ? "blocked"
        : operation.state === "unknown"
          ? "unknown"
          : operation.state === "completed" ||
              operation.state === "failed" ||
              operation.state === "cancelled"
            ? "done"
            : "working";
    return Effect.asVoid(
      this.executeJson([
        "pane",
        "report-metadata",
        "--source",
        "pions",
        operation.presentation.paneId,
        "--state-label",
        `${status}=${operation.state}`,
        "--display-agent",
        configurationProjection(operation),
        "--seq",
        String(operation.stateSeq),
      ])
    );
  }

  private executeJson(
    args: ReadonlyArray<string>
  ): Effect.Effect<HerdrEnvelope, Error> {
    return this.options.executor
      .execute({
        executable: "herdr",
        args,
        cwd: this.options.cwd,
        shell: false,
      })
      .pipe(
        Effect.mapError((error) =>
          error instanceof Error ? error : new Error(String(error))
        ),
        Effect.flatMap((output) => {
          const failure = commandFailure(output);
          if (failure !== undefined) return Effect.fail(failure);
          try {
            const envelope = JSON.parse(output.stdout) as HerdrEnvelope;
            const error = object(envelope.error);
            if (error !== undefined) {
              const message =
                typeof error.message === "string"
                  ? error.message
                  : typeof error.code === "string"
                    ? error.code
                    : "Herdr command failed";
              return Effect.fail(new Error(message));
            }
            return Effect.succeed(envelope);
          } catch (error) {
            return Effect.fail(
              error instanceof Error ? error : new Error(String(error))
            );
          }
        })
      );
  }
}
