// Drives a real Pi + Herdr delegation end to end in an isolated, disposable
// Herdr session. See docs/e2e-real-pi-herdr.md for prerequisites and how to
// read a failure's diagnostics.
import { createHash, randomBytes } from "node:crypto";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = fileURLToPath(new URL("..", import.meta.url));
let EXTENSION_PATH;
let CONSUMER_DIR;
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
const EVIDENCE_DIR = process.env.PIONS_E2E_EVIDENCE_DIR;
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
  if (EXTERNAL_HERDR_COMMAND === undefined) await requireCommand("herdr");
  await requireCommand("npm");
  await requireCommand("pi");

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

async function prepareConsumer(runDir) {
  const npmCache = join(runDir, "npm-cache");
  const npmOptions = {
    cwd: ROOT_DIR,
    env: { ...process.env, npm_config_cache: npmCache },
  };
  const packageCheck = await run("npm", ["run", "check:package"], npmOptions);
  if (packageCheck.code !== 0) {
    throw new Error(
      `npm run check:package failed:\n${(packageCheck.stderr || packageCheck.stdout).trim()}`
    );
  }
  const packed = await run(
    "npm",
    ["pack", "--ignore-scripts", "--pack-destination", runDir, "--json"],
    npmOptions
  );
  if (packed.code !== 0) {
    throw new Error(
      `npm pack failed:\n${(packed.stderr || packed.stdout).trim()}`
    );
  }
  let pack;
  try {
    [pack] = JSON.parse(packed.stdout);
  } catch {
    throw new Error(`npm pack returned invalid JSON: ${packed.stdout}`);
  }
  if (typeof pack?.filename !== "string") {
    throw new Error(`npm pack returned no archive filename: ${packed.stdout}`);
  }

  CONSUMER_DIR = join(runDir, "consumer");
  await mkdir(CONSUMER_DIR, { recursive: true });
  await writeFile(
    join(CONSUMER_DIR, "package.json"),
    JSON.stringify({
      name: "pions-e2e-consumer",
      version: "1.0.0",
      private: true,
    })
  );
  await writeFile(
    join(CONSUMER_DIR, ".pions.json"),
    await readFile(join(ROOT_DIR, ".pions.json"))
  );
  const repository = await run("git", ["init", "--quiet"], {
    cwd: CONSUMER_DIR,
  });
  if (repository.code !== 0) {
    throw new Error(
      `could not initialize isolated consumer repository: ${repository.stderr.trim()}`
    );
  }

  const archivePath = join(runDir, pack.filename);
  const installed = await run(
    "npm",
    [
      "install",
      "--prefix",
      CONSUMER_DIR,
      "--no-audit",
      "--no-fund",
      "--save-exact",
      archivePath,
    ],
    npmOptions
  );
  if (installed.code !== 0) {
    throw new Error(
      `installing the packed Pions tarball failed:\n${(installed.stderr || installed.stdout).trim()}`
    );
  }
  EXTENSION_PATH = join(
    CONSUMER_DIR,
    "node_modules",
    "@yasuhito",
    "pions",
    "dist",
    "src",
    "extension.js"
  );
  if (!(await fileExists(EXTENSION_PATH))) {
    throw new Error(
      `installed package extension is missing: ${EXTENSION_PATH}`
    );
  }
  const installedManifest = JSON.parse(
    await readFile(
      join(CONSUMER_DIR, "node_modules", "@yasuhito", "pions", "package.json"),
      "utf8"
    )
  );
  if (
    installedManifest.name !== "@yasuhito/pions" ||
    installedManifest.version !== "0.1.0"
  ) {
    throw new Error("installed tarball has an unexpected package identity");
  }
  log("installed the packed @yasuhito/pions@0.1.0 tarball in a new consumer.");
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
    SERVER_READY_TIMEOUT_MS,
    `the isolated Herdr session '${SESSION}' to become ready`
  );
  await serverLog?.close();
}

async function createWorkspace(label, env, cwd = CONSUMER_DIR) {
  const workspaceEnv =
    process.env.PATH === undefined ? env : { PATH: process.env.PATH, ...env };
  const args = [
    "workspace",
    "create",
    "--cwd",
    cwd,
    "--label",
    label,
    "--no-focus",
  ];
  for (const [key, value] of Object.entries(workspaceEnv)) {
    args.push("--env", `${key}=${value}`);
  }
  const created = await herdrJson(args);
  return {
    paneId: created.result.root_pane.pane_id,
    workspaceId: created.result.workspace.workspace_id,
  };
}

async function startPiInPane(
  runDir,
  paneId,
  promptPath,
  label,
  { extensions = [] } = {}
) {
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
    ...extensions.flatMap((path) => ["--extension", shellQuote(path)]),
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
  return { outPath, errPath, markerPath };
}

async function finishPiInPane(
  execution,
  paneId,
  label,
  timeoutMs,
  { allowNonZeroExitCode = false } = {}
) {
  await waitFor(
    () => fileExists(execution.markerPath),
    timeoutMs,
    `pi in pane ${paneId} (${label}) to finish`
  );
  const exitCodeText = (await readFile(execution.markerPath, "utf8")).trim();
  if (exitCodeText !== "0" && !allowNonZeroExitCode) {
    const stderrText = await readFile(execution.errPath, "utf8").catch(
      () => ""
    );
    throw new Error(
      `pi exited ${exitCodeText || "unknown"} in pane ${paneId} (${label}): ${stderrText.slice(0, 2000)}`
    );
  }
  return execution.outPath;
}

async function runPiInPane(
  runDir,
  paneId,
  promptPath,
  label,
  { extensions = [], allowNonZeroExitCode = false } = {}
) {
  const execution = await startPiInPane(runDir, paneId, promptPath, label, {
    extensions,
  });
  return finishPiInPane(
    execution,
    paneId,
    label,
    label === "delegate" ? DELEGATE_TIMEOUT_MS : RESULT_TIMEOUT_MS,
    { allowNonZeroExitCode }
  );
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

async function countToolResults(transcriptPath, toolName) {
  const content = await readFile(transcriptPath, "utf8");
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter(
      (event) =>
        event.type === "message_end" &&
        event.message?.role === "toolResult" &&
        event.message?.toolName === toolName
    ).length;
}

async function listWorkspaces() {
  const listed = await herdrJson(["workspace", "list"]);
  return listed.result?.workspaces ?? listed.workspaces ?? [];
}

async function workspaceIds() {
  return new Set((await listWorkspaces()).map((w) => w.workspace_id));
}

async function ownedWorkerWorkspaceIds(stateDir) {
  if (CONSUMER_DIR === undefined || !(await fileExists(CONSUMER_DIR)))
    return new Set();
  const repositoryKey = createHash("sha256")
    .update(await realpath(CONSUMER_DIR), "utf8")
    .digest("hex");
  const runtimeDir = join(
    stateDir,
    "pions",
    "repositories",
    repositoryKey,
    "runtime"
  );
  if (!(await fileExists(runtimeDir))) return new Set();
  const owned = new Set();
  for (const entry of await readdir(runtimeDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const recordPath = join(runtimeDir, entry.name, "events.v27.json");
    if (!(await fileExists(recordPath))) continue;
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    if (
      typeof record.operationId !== "string" ||
      createHash("sha256").update(record.operationId, "utf8").digest("hex") !==
        entry.name
    ) {
      throw new Error(`invalid isolated Operation record: ${recordPath}`);
    }
    for (const event of record.events) {
      if (
        event.type === "presentation_owned" &&
        event.operationId === record.operationId &&
        event.presentation?.ownedByPions === true &&
        typeof event.presentation.workspaceId === "string" &&
        event.presentation.workspaceId !== ""
      ) {
        owned.add(event.presentation.workspaceId);
      }
    }
  }
  return owned;
}

async function observedOwnedWorkspaces(observer, stateDir) {
  const owned = await ownedWorkerWorkspaceIds(stateDir);
  return [...observer.observed.entries()].filter(([id]) => owned.has(id));
}

async function listPanes() {
  const listed = await herdrJson(["pane", "list"]);
  return listed.result?.panes ?? listed.panes ?? [];
}

function observeWorkerWorkspaces(before, parentWorkspaceId, parentPaneId) {
  const observed = new Map();
  let parentPaneChanged = false;
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      const workspaces = await listWorkspaces().catch(() => []);
      for (const workspace of workspaces) {
        if (before.has(workspace.workspace_id)) continue;
        observed.set(workspace.workspace_id, {
          label: workspace.label,
          focused:
            observed.get(workspace.workspace_id)?.focused === true ||
            workspace.focused === true,
        });
      }
      const parentPanes = (await listPanes()).filter(
        (pane) => pane.workspace_id === parentWorkspaceId
      );
      if (
        parentPanes.length !== 1 ||
        parentPanes[0]?.pane_id !== parentPaneId
      ) {
        parentPaneChanged = true;
      }
      await delay(POLL_INTERVAL_MS);
    }
  })();
  return {
    observed,
    async stop() {
      stopped = true;
      await loop;
      return { observed, parentPaneChanged };
    },
  };
}

function toolResultText(message) {
  const textPart = message.content?.find?.((part) => part.type === "text");
  return textPart?.text ?? "";
}

function operationIdFromError(message) {
  const match = JSON.stringify(message).match(
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/iu
  );
  if (match === null) {
    throw new Error(
      `tool error did not expose an Operation identifier: ${JSON.stringify(message)}`
    );
  }
  return match[0];
}

async function captureDiagnostics(runDir) {
  const listings = {};
  for (const kind of ["pane", "workspace"]) {
    const result = await herdrRaw([kind, "list"]);
    listings[kind] = result.stdout || result.stderr;
  }
  if (EVIDENCE_DIR === undefined) {
    log(`Herdr panes at failure: ${listings.pane.trim()}`);
    log(`Herdr workspaces at failure: ${listings.workspace.trim()}`);
    return;
  }
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await cp(runDir, join(EVIDENCE_DIR, "run"), {
    recursive: true,
    filter: (source) => !source.split(/[\\/]/u).includes("node_modules"),
  }).catch(() => undefined);
  for (const [kind, output] of Object.entries(listings)) {
    await writeFile(join(EVIDENCE_DIR, `${kind}-list.json`), output);
  }
}

async function cleanupHerdr(parentWorkspaceIds, stateDir) {
  for (const workspaceId of parentWorkspaceIds) {
    await herdr(["workspace", "close", workspaceId]).catch(() => undefined);
  }
  for (const workspaceId of await ownedWorkerWorkspaceIds(stateDir)) {
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
  const parentWorkspaceIds = [];
  let workerWriteName;
  let originalProjectConfig;
  let workerExtensionPath;
  let originalWorkerExtension;
  let herdrReady = false;
  let failed = false;

  try {
    await prepareConsumer(runDir);
    log(
      EXTERNAL_SESSION === undefined
        ? `provisioning isolated Herdr session '${SESSION}'...`
        : `using the supplied isolated Herdr session '${SESSION}'...`
    );
    await provisionSession(runDir);
    herdrReady = true;

    const knownString = `PIONS_E2E_114_${randomBytes(6).toString("hex")}_日本語テスト🚀🔥`;
    const nestedCwd = join(
      CONSUMER_DIR,
      ".pions-e2e-nested",
      randomBytes(4).toString("hex")
    );
    await mkdir(nestedCwd, { recursive: true });
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

    const parentToolsPath = join(runDir, "parent-tools.json");
    const observerExtensionPath = join(runDir, "observe-tools.ts");
    await writeFile(
      observerExtensionPath,
      [
        'import { writeFileSync } from "node:fs";',
        "export default function observeTools(pi) {",
        '  pi.on("session_start", () => {',
        `    writeFileSync(${JSON.stringify(parentToolsPath)}, JSON.stringify(pi.getActiveTools().sort()));`,
        "  });",
        "}",
      ].join("\n")
    );

    log("delegating a known UTF-8 task through pions_delegate...");
    const workspace1 = await createWorkspace(
      "pions-e2e-delegate",
      { XDG_STATE_HOME: stateDir },
      nestedCwd
    );
    parentWorkspaceIds.push(workspace1.workspaceId);
    const beforeDelegate = await workspaceIds();
    const workerObserver = observeWorkerWorkspaces(
      beforeDelegate,
      workspace1.workspaceId,
      workspace1.paneId
    );
    let delegateTranscript;
    let workerWorkspaces;
    try {
      delegateTranscript = await runPiInPane(
        runDir,
        workspace1.paneId,
        delegatePromptPath,
        "delegate",
        { extensions: [observerExtensionPath] }
      );
    } finally {
      workerWorkspaces = await workerObserver.stop();
    }
    const parentPionsTools = JSON.parse(
      await readFile(parentToolsPath, "utf8")
    ).filter((name) => name.startsWith("pions_"));
    const expectedParentTools = [
      "pions_delegate",
      "pions_operation",
      "pions_result",
    ];
    if (
      JSON.stringify(parentPionsTools) !== JSON.stringify(expectedParentTools)
    ) {
      throw new Error(
        `parent Pions tool surface mismatch: ${JSON.stringify(parentPionsTools)}`
      );
    }
    log("the live parent Pi exposes exactly the three Pions tools.");
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

    const observedWorkerWorkspaces = await observedOwnedWorkspaces(
      workerWorkspaces,
      stateDir
    );
    if (observedWorkerWorkspaces.length !== 1) {
      throw new Error(
        `expected exactly one Worker workspace during delegation, observed ${JSON.stringify(observedWorkerWorkspaces)}`
      );
    }
    const [workerWorkspaceId, workerWorkspace] = observedWorkerWorkspaces[0];
    const expectedWorkerLabel = `Pions ${operationId.slice(0, 8)}`;
    if (workerWorkspace.label !== expectedWorkerLabel) {
      throw new Error(
        `Worker workspace label mismatch: expected ${JSON.stringify(expectedWorkerLabel)}, got ${JSON.stringify(workerWorkspace.label)}`
      );
    }
    if (workerWorkspace.focused === true) {
      throw new Error(
        `Worker workspace ${workerWorkspaceId} became focused during delegation`
      );
    }
    if (workerWorkspaces.parentPaneChanged) {
      throw new Error(
        `parent workspace ${workspace1.workspaceId} was split or its pane changed during delegation`
      );
    }
    if ((await workspaceIds()).has(workerWorkspaceId)) {
      throw new Error(
        `Worker workspace ${workerWorkspaceId} is still open after the successful delegation`
      );
    }
    log(
      `the Worker ran in its own workspace ${workerWorkspaceId} (${expectedWorkerLabel}) without taking focus, and the workspace closed on success.`
    );

    const workerWritten = await readFile(
      join(nestedCwd, workerWriteName),
      "utf8"
    ).catch(() => undefined);
    if (workerWritten !== knownString) {
      throw new Error(
        `worker write in the shared working directory mismatch: expected ${JSON.stringify(knownString)} at ${workerWriteName}, got ${JSON.stringify(workerWritten)}`
      );
    }
    log("the Worker inherited the parent's nested working directory.");

    const resultPromptPath = join(runDir, "result-prompt.txt");
    await writeFile(
      resultPromptPath,
      `Use the pions_result tool exactly once with operationId "${operationId}" and no cursor.\n\nDo not do anything else.\n`
    );

    log("retrieving the same Result from a separate Pi session...");
    const workspace2 = await createWorkspace("pions-e2e-result", {
      XDG_STATE_HOME: stateDir,
    });
    parentWorkspaceIds.push(workspace2.workspaceId);
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

    const operationPromptPath = join(runDir, "operation-prompt.txt");
    await writeFile(
      operationPromptPath,
      `Use the pions_operation tool exactly once with operationId "${operationId}". Do not do anything else.\n`
    );
    const workspace3 = await createWorkspace("pions-e2e-operation", {
      XDG_STATE_HOME: stateDir,
    });
    parentWorkspaceIds.push(workspace3.workspaceId);
    const operationTranscript = await runPiInPane(
      runDir,
      workspace3.paneId,
      operationPromptPath,
      "operation"
    );
    const operationResult = await extractToolResult(
      operationTranscript,
      "pions_operation"
    );
    const effective = operationResult.details?.effectiveConfig;
    const expectedWorkerTools = [
      "read",
      "write",
      "edit",
      "bash",
      "grep",
      "find",
      "ls",
    ];
    if (
      JSON.stringify(effective?.tools) !== JSON.stringify(expectedWorkerTools)
    ) {
      throw new Error(
        `Worker tool surface mismatch: ${JSON.stringify(effective?.tools)}`
      );
    }
    if (effective?.cwd !== nestedCwd) {
      throw new Error(
        `Worker cwd mismatch: expected ${nestedCwd}, got ${effective?.cwd}`
      );
    }
    log(
      "the persisted live Operation has the exact seven-tool Worker surface and nested cwd."
    );
    const snapshot = operationResult.details ?? {};
    if (JSON.stringify(snapshot).includes(knownString)) {
      throw new Error("pions_operation exposed the accepted Result body");
    }
    log(
      "pions_operation exposed persisted diagnostics without the Result body."
    );
    const cleanup = snapshot.presentationCleanup;
    if (
      cleanup?.state !== "completed" ||
      cleanup?.workspaceId !== workerWorkspaceId
    ) {
      throw new Error(
        `persisted workspace cleanup mismatch: expected completed cleanup of ${workerWorkspaceId}, got ${JSON.stringify(cleanup)}`
      );
    }
    if ((snapshot.cleanupDiagnostics ?? []).length !== 0) {
      throw new Error(
        `unexpected cleanup diagnostics: ${JSON.stringify(snapshot.cleanupDiagnostics)}`
      );
    }
    log(
      "the persisted Operation records the completed cleanup of exactly the owned Worker workspace."
    );

    const projectConfigPath = join(CONSUMER_DIR, ".pions.json");
    originalProjectConfig = await readFile(projectConfigPath, "utf8");
    const rejectionPromptPath = join(runDir, "rejection-prompt.txt");
    await writeFile(
      rejectionPromptPath,
      'Use the pions_delegate tool exactly once with task "Respond with OK". Do not do anything else.\n'
    );
    const providerExtensionPath = join(runDir, "unavailable-provider.ts");
    await writeFile(
      providerExtensionPath,
      [
        "export default function unavailableProvider(pi) {",
        '  pi.registerProvider("e2e-extension-provider", {',
        '    name: "E2E extension provider",',
        '    baseUrl: "http://127.0.0.1:1/v1",',
        '    apiKey: "e2e",',
        '    api: "openai-completions",',
        "    models: [{",
        '      id: "e2e-model", name: "E2E model", reasoning: false,',
        '      input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },',
        "      contextWindow: 4096, maxTokens: 1024",
        "    }]",
        "  });",
        "}",
      ].join("\n")
    );
    await writeFile(
      projectConfigPath,
      JSON.stringify({
        model: { provider: "e2e-extension-provider", id: "e2e-model" },
      })
    );
    const beforeProvider = await ownedWorkerWorkspaceIds(stateDir);
    const providerWorkspace = await createWorkspace(
      "pions-e2e-provider-config",
      { XDG_STATE_HOME: stateDir }
    );
    parentWorkspaceIds.push(providerWorkspace.workspaceId);
    const providerTranscript = await runPiInPane(
      runDir,
      providerWorkspace.paneId,
      rejectionPromptPath,
      "provider-config",
      { extensions: [providerExtensionPath] }
    );
    const providerResult = await extractToolResult(
      providerTranscript,
      "pions_delegate"
    );
    if (!providerResult.isError) {
      throw new Error("extension-derived Worker provider was accepted");
    }
    const providerOwned = await ownedWorkerWorkspaceIds(stateDir);
    const newProviderOwned = [...providerOwned].filter(
      (id) => !beforeProvider.has(id)
    );
    if (newProviderOwned.length !== 0) {
      throw new Error(
        `extension-derived provider rejection created Worker workspaces: ${newProviderOwned.join(", ")}`
      );
    }
    const failedDelegationCount = await countToolResults(
      providerTranscript,
      "pions_delegate"
    );
    if (failedDelegationCount !== 1) {
      throw new Error(
        `failed delegation executed ${failedDelegationCount} times instead of once`
      );
    }
    log(
      "an extension-derived provider was rejected before Worker creation without retry."
    );
    await writeFile(projectConfigPath, originalProjectConfig);

    const cancellationPromptPath = join(runDir, "cancellation-prompt.txt");
    const cancellationWorkerStartedPath = join(
      runDir,
      "cancellation-worker-started.marker"
    );
    const cancellationTask = [
      `Use bash to execute exactly this command as your first action: printf 'started' > ${shellQuote(cancellationWorkerStartedPath)}; sleep 90`,
      "After the command completes, respond with only `CANCEL_TEST_FINISHED`.",
    ].join("\n");
    await writeFile(
      cancellationPromptPath,
      `Use pions_delegate exactly once with this task:\n\n${cancellationTask}\n\nDo not do anything else.\n`
    );
    const cancellationEventPath = join(runDir, "cancellation-tool-result.json");
    const cancellationSignalPath = join(runDir, "cancel-worker.signal");
    const cancellationObserverExtension = join(
      runDir,
      "observe-cancellation.ts"
    );
    await writeFile(
      cancellationObserverExtension,
      [
        'import { existsSync, writeFileSync } from "node:fs";',
        "export default function observeCancellation(pi) {",
        "  let signalPoll;",
        '  pi.on("tool_execution_start", (event, context) => {',
        '    if (event.toolName === "pions_delegate") {',
        `      signalPoll = setInterval(() => { if (existsSync(${JSON.stringify(cancellationSignalPath)})) { clearInterval(signalPoll); context.abort(); } }, 250);`,
        "    }",
        "  });",
        '  pi.on("tool_result", (event) => {',
        '    if (event.toolName === "pions_delegate") {',
        "      clearInterval(signalPoll);",
        `      writeFileSync(${JSON.stringify(cancellationEventPath)}, JSON.stringify(event));`,
        "    }",
        "  });",
        "}",
      ].join("\n")
    );
    const cancellationParent = await createWorkspace("pions-e2e-cancellation", {
      XDG_STATE_HOME: stateDir,
    });
    parentWorkspaceIds.push(cancellationParent.workspaceId);
    const beforeCancellation = await workspaceIds();
    const cancellationObserver = observeWorkerWorkspaces(
      beforeCancellation,
      cancellationParent.workspaceId,
      cancellationParent.paneId
    );
    let cancelledWorkerWorkspaces;
    const cancellationExecution = await startPiInPane(
      runDir,
      cancellationParent.paneId,
      cancellationPromptPath,
      "cancellation",
      { extensions: [cancellationObserverExtension] }
    );
    try {
      await waitFor(
        async () =>
          (await observedOwnedWorkspaces(cancellationObserver, stateDir))
            .length === 1,
        DELEGATE_TIMEOUT_MS,
        "the cancellable Worker workspace to appear"
      );
      await waitFor(
        () => fileExists(cancellationWorkerStartedPath),
        DELEGATE_TIMEOUT_MS,
        "the cancellable Worker to start executing its command"
      );
      await writeFile(cancellationSignalPath, "");
      await waitFor(
        () => fileExists(cancellationEventPath),
        RESULT_TIMEOUT_MS,
        "the Pi abort to return a cancelled delegation result"
      );
      await waitFor(
        () => fileExists(cancellationExecution.markerPath),
        RESULT_TIMEOUT_MS,
        "the parent Pi to finish after cancellation"
      );
    } finally {
      cancelledWorkerWorkspaces = await cancellationObserver.stop();
    }
    if (!(await fileExists(cancellationEventPath))) {
      throw new Error(
        "the cancelled delegation did not report its tool result"
      );
    }
    const cancellationResult = JSON.parse(
      await readFile(cancellationEventPath, "utf8")
    );
    if (cancellationResult.isError !== true) {
      throw new Error("the cancelled delegation was not reported as an error");
    }
    const cancellationText = cancellationResult.content
      ?.map((part) => part.text ?? "")
      .join("\n");
    if (!/was cancelled/iu.test(cancellationText)) {
      throw new Error(
        `expected confirmed cancellation, got ${cancellationText}`
      );
    }
    const cancelledOperationId = operationIdFromError(cancellationResult);
    const cancelledWorkspaces = await observedOwnedWorkspaces(
      cancelledWorkerWorkspaces,
      stateDir
    );
    if (cancelledWorkspaces.length !== 1) {
      throw new Error(
        `expected one Worker workspace during cancellation, observed ${JSON.stringify(cancelledWorkspaces)}`
      );
    }
    const [cancelledWorkspaceId] = cancelledWorkspaces[0];
    if (
      cancelledWorkspaces[0][1].label !==
      `Pions ${cancelledOperationId.slice(0, 8)}`
    ) {
      throw new Error(
        "cancelled Worker workspace label did not match its Operation"
      );
    }
    if ((await workspaceIds()).has(cancelledWorkspaceId)) {
      throw new Error(
        "a stop-confirmed cancelled Worker workspace remained open"
      );
    }
    const cancellationInspectionPrompt = join(
      runDir,
      "cancellation-operation-prompt.txt"
    );
    await writeFile(
      cancellationInspectionPrompt,
      `Use pions_operation exactly once with operationId "${cancelledOperationId}". Do not do anything else.\n`
    );
    const cancellationInspectionWorkspace = await createWorkspace(
      "pions-e2e-cancelled-operation",
      { XDG_STATE_HOME: stateDir }
    );
    parentWorkspaceIds.push(cancellationInspectionWorkspace.workspaceId);
    const cancellationInspectionTranscript = await runPiInPane(
      runDir,
      cancellationInspectionWorkspace.paneId,
      cancellationInspectionPrompt,
      "cancelled-operation"
    );
    const cancellationInspection = await extractToolResult(
      cancellationInspectionTranscript,
      "pions_operation"
    );
    if (cancellationInspection.isError) {
      throw new Error(
        `cancelled Operation could not be inspected: ${JSON.stringify(cancellationInspection)}`
      );
    }
    const cancelledSnapshot = cancellationInspection.details ?? {};
    if (cancelledSnapshot.state !== "cancelled") {
      throw new Error(
        `expected a cancelled Operation, got ${cancelledSnapshot.state}`
      );
    }
    if (
      cancelledSnapshot.presentationCleanup?.state !== "completed" ||
      cancelledSnapshot.presentationCleanup?.workspaceId !==
        cancelledWorkspaceId
    ) {
      throw new Error(
        `cancelled Operation did not persist cleanup of ${cancelledWorkspaceId}`
      );
    }
    log(
      `stop-confirmed cancellation ${cancelledOperationId} closed and recorded its owned Worker workspace.`
    );

    workerExtensionPath = join(
      CONSUMER_DIR,
      "node_modules",
      "@yasuhito",
      "pions",
      "dist",
      "src",
      "worker-extension.js"
    );
    originalWorkerExtension = await readFile(workerExtensionPath, "utf8");
    await writeFile(workerExtensionPath, "export default function broken( {\n");
    const workerFailurePromptPath = join(runDir, "worker-failure-prompt.txt");
    await writeFile(
      workerFailurePromptPath,
      'Use the pions_delegate tool exactly once with task "Respond with OK". Do not do anything else.\n'
    );
    const failureParent = await createWorkspace("pions-e2e-worker-failure", {
      XDG_STATE_HOME: stateDir,
    });
    parentWorkspaceIds.push(failureParent.workspaceId);
    const beforeWorkerFailure = await workspaceIds();
    const failureObserver = observeWorkerWorkspaces(
      beforeWorkerFailure,
      failureParent.workspaceId,
      failureParent.paneId
    );
    let failureTranscript;
    let failedWorkerWorkspaces;
    try {
      failureTranscript = await runPiInPane(
        runDir,
        failureParent.paneId,
        workerFailurePromptPath,
        "worker-failure",
        { allowNonZeroExitCode: true }
      );
    } finally {
      failedWorkerWorkspaces = await failureObserver.stop();
    }
    await writeFile(workerExtensionPath, originalWorkerExtension);
    const workerFailure = await extractToolResult(
      failureTranscript,
      "pions_delegate"
    );
    if (!workerFailure.isError) {
      throw new Error("a Worker startup failure was reported as success");
    }
    if ((await countToolResults(failureTranscript, "pions_delegate")) !== 1) {
      throw new Error("a failed delegation was executed more than once");
    }
    const failedOperationId = operationIdFromError(workerFailure);
    const failedWorkspaces = await observedOwnedWorkspaces(
      failedWorkerWorkspaces,
      stateDir
    );
    if (failedWorkspaces.length !== 1) {
      throw new Error(
        `expected one Worker workspace during failed startup, observed ${JSON.stringify(failedWorkspaces)}`
      );
    }
    const [failedWorkspaceId, failedWorkspace] = failedWorkspaces[0];
    if (failedWorkspace.label !== `Pions ${failedOperationId.slice(0, 8)}`) {
      throw new Error(
        "failed Worker workspace label did not match its Operation"
      );
    }
    if (!(await workspaceIds()).has(failedWorkspaceId)) {
      throw new Error(
        "failed or unknown Worker workspace was closed unexpectedly"
      );
    }
    const failedOperationPrompt = join(runDir, "failed-operation-prompt.txt");
    await writeFile(
      failedOperationPrompt,
      `Use the pions_operation tool exactly once with operationId "${failedOperationId}". Do not do anything else.\n`
    );
    const failureInspectionWorkspace = await createWorkspace(
      "pions-e2e-failed-operation",
      { XDG_STATE_HOME: stateDir }
    );
    parentWorkspaceIds.push(failureInspectionWorkspace.workspaceId);
    const failureInspectionTranscript = await runPiInPane(
      runDir,
      failureInspectionWorkspace.paneId,
      failedOperationPrompt,
      "failed-operation"
    );
    const failureInspection = await extractToolResult(
      failureInspectionTranscript,
      "pions_operation"
    );
    if (failureInspection.isError) {
      throw new Error(
        `failed Operation could not be inspected: ${JSON.stringify(failureInspection)}`
      );
    }
    const failedSnapshot = failureInspection.details ?? {};
    if (!["failed", "unknown"].includes(failedSnapshot.state)) {
      throw new Error(
        `expected a failed or unknown Operation, got ${failedSnapshot.state}`
      );
    }
    if (failedSnapshot.presentationCleanup?.state === "completed") {
      throw new Error(
        "a failed or unknown Operation completed presentation cleanup"
      );
    }
    if (!(await workspaceIds()).has(failedWorkspaceId)) {
      throw new Error("failed Worker workspace disappeared during inspection");
    }
    log(
      `failed Operation ${failedOperationId} remained inspectable with its Worker workspace open.`
    );

    const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    log(
      `PASS: Operation ${operationId} (digest ${originalDigest}) verified across two Pi sessions in ${elapsedSeconds}s.`
    );
  } catch (error) {
    failed = true;
    if (herdrReady) await captureDiagnostics(runDir);
    throw error;
  } finally {
    if (originalProjectConfig !== undefined) {
      await writeFile(
        join(CONSUMER_DIR, ".pions.json"),
        originalProjectConfig
      ).catch(() => undefined);
    }
    if (
      workerExtensionPath !== undefined &&
      originalWorkerExtension !== undefined
    ) {
      await writeFile(workerExtensionPath, originalWorkerExtension).catch(
        () => undefined
      );
    }
    await cleanupHerdr(parentWorkspaceIds, stateDir);
    if (failed && EVIDENCE_DIR !== undefined) {
      log(`diagnostics preserved at ${EVIDENCE_DIR}`);
    }
    await rm(runDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[e2e] FAIL: ${error.message}`);
  process.exitCode = 1;
});
