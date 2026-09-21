// Drives a real Pi + Herdr delegation end to end in an isolated, disposable
// Herdr session. See docs/e2e-real-pi-herdr.md for prerequisites and how to
// read a failure's diagnostics.
import { randomBytes } from "node:crypto";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = fileURLToPath(new URL("..", import.meta.url));
const EXTENSION_PATH = join(ROOT_DIR, ".pi", "extensions", "pions.ts");
// A supervisor that owns Herdr lifecycle itself can hand over an already
// running non-default session (PIONS_E2E_HERDR_SESSION) and a wrapper that
// scopes every call to it (PIONS_E2E_HERDR_COMMAND). The script then neither
// starts nor stops a Herdr server or session; it only creates and closes its
// own workspaces inside the supplied one.
const EXTERNAL_SESSION = process.env.PIONS_E2E_HERDR_SESSION;
const EXTERNAL_HERDR_COMMAND = process.env.PIONS_E2E_HERDR_COMMAND;
const SESSION =
  EXTERNAL_SESSION ??
  `pions-e2e-${process.pid}-${randomBytes(3).toString("hex")}`;
const EVIDENCE_DIR =
  process.env.PIONS_E2E_EVIDENCE_DIR ??
  join(
    tmpdir(),
    `pions-e2e-evidence-${new Date().toISOString().replace(/[:.]/g, "-")}`
  );
const SERVER_READY_TIMEOUT_MS = 60_000;
const DELEGATE_TIMEOUT_MS = 180_000;
const RESULT_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 500;

function log(message) {
  console.error(`[e2e] ${message}`);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) =>
      resolve({ code: null, stdout, stderr: String(error) })
    );
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function requireCommand(command) {
  const result = await run(command, ["--version"]);
  if (result.code !== 0) {
    throw new Error(
      `${command} is required on PATH ('${command} --version' failed)`
    );
  }
}

async function herdrRaw(args) {
  return EXTERNAL_HERDR_COMMAND === undefined
    ? run("herdr", ["--session", SESSION, ...args])
    : run(EXTERNAL_HERDR_COMMAND, args);
}

async function herdr(args) {
  const result = await herdrRaw(args);
  if (result.code !== 0) {
    throw new Error(
      `herdr ${args.join(" ")} failed (exit ${result.code}): ${(result.stderr || result.stdout).trim()}`
    );
  }
  return result.stdout;
}

async function herdrJson(args) {
  return JSON.parse(await herdr(args));
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function hasContent(path) {
  try {
    return (await stat(path)).size > 0;
  } catch {
    return false;
  }
}

async function waitFor(predicate, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${description}`);
    }
    await delay(POLL_INTERVAL_MS);
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function preflight() {
  if (SESSION === "default") {
    throw new Error("refusing to use the default Herdr session");
  }
  if (EXTERNAL_HERDR_COMMAND !== undefined && EXTERNAL_SESSION === undefined) {
    throw new Error(
      "PIONS_E2E_HERDR_COMMAND requires PIONS_E2E_HERDR_SESSION naming the session that command is scoped to"
    );
  }
  await requireCommand("herdr");
  await requireCommand("pi");

  log("building pions (npm run build)...");
  const build = await run("npm", ["run", "build"], { cwd: ROOT_DIR });
  if (build.code !== 0) {
    throw new Error(
      `npm run build failed:\n${(build.stderr || build.stdout).trim()}`
    );
  }

  const authPath = join(homedir(), ".pi", "agent", "auth.json");
  if (!(await hasContent(authPath))) {
    log(
      `warning: ${authPath} is empty or missing; the delegating Pi session may not be able to call tools`
    );
  }

  const pionsConfigPath = join(ROOT_DIR, ".pions.json");
  if (await fileExists(pionsConfigPath)) {
    const config = JSON.parse(await readFile(pionsConfigPath, "utf8"));
    const model = config.model;
    if (model?.provider !== undefined && model?.id !== undefined) {
      const check = await run("pi", [
        "auth",
        "check",
        "--provider",
        model.provider,
        "--model",
        model.id,
      ]);
      if (check.code !== 0) {
        throw new Error(
          [
            `configured delegation worker model ${model.provider}/${model.id} (.pions.json model) is not authenticated.`,
            `Run: pi auth check --provider ${model.provider} --model ${model.id}`,
            "See docs/e2e-real-pi-herdr.md for prerequisites.",
          ].join("\n")
        );
      }
    }
  }
}

async function provisionSession(runDir) {
  let serverLog;
  if (EXTERNAL_SESSION === undefined) {
    serverLog = await open(join(runDir, "herdr-server.log"), "a");
    const server = spawn("herdr", ["server", "--session", SESSION], {
      stdio: ["ignore", serverLog.fd, serverLog.fd],
      detached: true,
    });
    server.unref();
  }
  await waitFor(
    async () => {
      const result = await herdrRaw(["status", "--json"]);
      if (result.code !== 0) return false;
      try {
        return JSON.parse(result.stdout)?.server?.running === true;
      } catch {
        return false;
      }
    },
    EXTERNAL_SESSION === undefined ? SERVER_READY_TIMEOUT_MS : POLL_INTERVAL_MS,
    `the isolated Herdr session '${SESSION}' to become ready`
  );
  await serverLog?.close();
}

async function createWorkspace(label, env) {
  const args = [
    "workspace",
    "create",
    "--cwd",
    ROOT_DIR,
    "--label",
    label,
    "--no-focus",
  ];
  for (const [key, value] of Object.entries(env)) {
    args.push("--env", `${key}=${value}`);
  }
  const created = await herdrJson(args);
  return {
    paneId: created.result.root_pane.pane_id,
    workspaceId: created.result.workspace.workspace_id,
  };
}

async function runPiInPane(runDir, paneId, promptPath, label) {
  const outPath = join(runDir, `${label}-output.json`);
  const errPath = join(runDir, `${label}-stderr.log`);
  const markerPath = join(runDir, `${label}-exit.marker`);
  const command = [
    "pi",
    "--mode",
    "json",
    "--no-extensions",
    "--extension",
    shellQuote(EXTENSION_PATH),
    "--approve",
    "--no-session",
    "-p",
    shellQuote(`@${promptPath}`),
    ">",
    shellQuote(outPath),
    "2>",
    shellQuote(errPath),
    ";",
    "echo",
    "$?",
    ">",
    shellQuote(markerPath),
  ].join(" ");
  await herdr(["pane", "send-text", paneId, command]);
  await herdr(["pane", "send-keys", paneId, "enter"]);
  await waitFor(
    () => fileExists(markerPath),
    label === "delegate" ? DELEGATE_TIMEOUT_MS : RESULT_TIMEOUT_MS,
    `pi in pane ${paneId} (${label}) to finish`
  );
  const exitCodeText = (await readFile(markerPath, "utf8")).trim();
  if (exitCodeText !== "0") {
    const stderrText = await readFile(errPath, "utf8").catch(() => "");
    throw new Error(
      `pi exited ${exitCodeText || "unknown"} in pane ${paneId} (${label}): ${stderrText.slice(0, 2000)}`
    );
  }
  return outPath;
}

async function extractToolResult(transcriptPath, toolName) {
  const content = await readFile(transcriptPath, "utf8");
  const events = content
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
  const toolResults = events.filter(
    (event) =>
      event.type === "message_end" &&
      event.message?.role === "toolResult" &&
      event.message?.toolName === toolName
  );
  const last = toolResults.at(-1);
  if (last === undefined) {
    throw new Error(`no ${toolName} tool result found in ${transcriptPath}`);
  }
  return last.message;
}

function toolResultText(message) {
  const textPart = message.content?.find?.((part) => part.type === "text");
  return textPart?.text ?? "";
}

async function captureDiagnostics(runDir) {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await cp(runDir, join(EVIDENCE_DIR, "run"), { recursive: true }).catch(
    () => undefined
  );
  for (const kind of ["pane", "workspace"]) {
    const result = await herdrRaw([kind, "list"]);
    await writeFile(
      join(EVIDENCE_DIR, `${kind}-list.json`),
      result.stdout || result.stderr
    );
  }
}

async function cleanupHerdr(workspaceIds) {
  for (const workspaceId of workspaceIds) {
    await herdr(["workspace", "close", workspaceId]).catch(() => undefined);
  }
  if (EXTERNAL_SESSION !== undefined) return;
  await herdr(["session", "stop", SESSION]).catch(() => undefined);
  await herdr(["session", "delete", SESSION]).catch(() => undefined);
}

async function main() {
  const startedAt = Date.now();
  await preflight();

  const runDir = await mkdtemp(join(tmpdir(), "pions-e2e-run-"));
  const stateDir = join(runDir, "state");
  await mkdir(stateDir, { recursive: true });
  const createdWorkspaceIds = [];
  let workerWriteName;
  let failed = false;

  try {
    log(
      EXTERNAL_SESSION === undefined
        ? `provisioning isolated Herdr session '${SESSION}'...`
        : `using the supplied isolated Herdr session '${SESSION}'...`
    );
    await provisionSession(runDir);

    const knownString = `PIONS_E2E_106_${randomBytes(6).toString("hex")}_日本語テスト🚀🔥`;
    // A relative path proves the Worker writes into the parent's working
    // directory; the file is removed in the finally block below.
    workerWriteName = `.pions-e2e-worker-write-${randomBytes(4).toString("hex")}.txt`;
    const task = [
      `Run bash to execute exactly this command and capture its stdout: printf '%s' '${knownString}'`,
      `Then use the write tool to create a file at the relative path ${workerWriteName} in your current working directory whose entire content is exactly that stdout text with no trailing newline.`,
      "Finally respond with only that exact stdout text as your final answer. Do not add any other words, punctuation, or explanation before or after it.",
    ].join("\n");
    const delegatePromptPath = join(runDir, "delegate-prompt.txt");
    await writeFile(
      delegatePromptPath,
      `Use the pions_delegate tool exactly once with this exact task text:\n\n${task}\n\nDo not do anything else.\n`
    );

    log("delegating a known UTF-8 task through pions_delegate...");
    const workspace1 = await createWorkspace("pions-e2e-delegate", {
      XDG_STATE_HOME: stateDir,
    });
    createdWorkspaceIds.push(workspace1.workspaceId);
    const delegateTranscript = await runPiInPane(
      runDir,
      workspace1.paneId,
      delegatePromptPath,
      "delegate"
    );
    const delegateResult = await extractToolResult(
      delegateTranscript,
      "pions_delegate"
    );
    if (delegateResult.isError) {
      throw new Error(
        `pions_delegate reported an error: ${JSON.stringify(delegateResult)}`
      );
    }
    const operationId = delegateResult.details?.operationId;
    if (typeof operationId !== "string" || operationId === "") {
      throw new Error("pions_delegate result had no operationId");
    }
    const expectedDelegateText = `${knownString}\n\n[Operation: ${operationId}]`;
    if (toolResultText(delegateResult) !== expectedDelegateText) {
      throw new Error(
        `delegate result body mismatch: expected ${JSON.stringify(expectedDelegateText)}, got ${JSON.stringify(toolResultText(delegateResult))}`
      );
    }
    if (delegateResult.details.truncated) {
      throw new Error("delegate result was unexpectedly truncated");
    }
    const originalDigest = delegateResult.details.digest;
    log(`delegated Operation ${operationId} returned the known UTF-8 answer.`);

    const workerWritten = await readFile(
      join(ROOT_DIR, workerWriteName),
      "utf8"
    ).catch(() => undefined);
    if (workerWritten !== knownString) {
      throw new Error(
        `worker write in the shared working directory mismatch: expected ${JSON.stringify(knownString)} at ${workerWriteName}, got ${JSON.stringify(workerWritten)}`
      );
    }
    log("the Worker wrote the known string into the shared working directory.");

    const resultPromptPath = join(runDir, "result-prompt.txt");
    await writeFile(
      resultPromptPath,
      `Use the pions_result tool exactly once with operationId "${operationId}" and no cursor.\n\nDo not do anything else.\n`
    );

    log("retrieving the same Result from a separate Pi session...");
    const workspace2 = await createWorkspace("pions-e2e-result", {
      XDG_STATE_HOME: stateDir,
    });
    createdWorkspaceIds.push(workspace2.workspaceId);
    const resultTranscript = await runPiInPane(
      runDir,
      workspace2.paneId,
      resultPromptPath,
      "result"
    );
    const resultToolResult = await extractToolResult(
      resultTranscript,
      "pions_result"
    );
    if (resultToolResult.isError) {
      throw new Error(
        `pions_result reported an error: ${JSON.stringify(resultToolResult)}`
      );
    }
    const expectedResultText = `${knownString}\n\n[Operation: ${operationId}; Result complete]`;
    if (toolResultText(resultToolResult) !== expectedResultText) {
      throw new Error(
        `retrieved result body mismatch: expected ${JSON.stringify(expectedResultText)}, got ${JSON.stringify(toolResultText(resultToolResult))}`
      );
    }
    if (resultToolResult.details?.digest !== originalDigest) {
      throw new Error(
        `retrieved result digest ${resultToolResult.details?.digest} does not match the original delegation digest ${originalDigest}`
      );
    }

    const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    log(
      `PASS: Operation ${operationId} (digest ${originalDigest}) verified across two Pi sessions in ${elapsedSeconds}s.`
    );
  } catch (error) {
    failed = true;
    await captureDiagnostics(runDir);
    throw error;
  } finally {
    if (workerWriteName !== undefined) {
      await rm(join(ROOT_DIR, workerWriteName), { force: true });
    }
    await cleanupHerdr(createdWorkspaceIds);
    if (failed) {
      log(`diagnostics preserved at ${EVIDENCE_DIR}`);
    } else {
      await rm(runDir, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(`[e2e] FAIL: ${error.message}`);
  process.exitCode = 1;
});
