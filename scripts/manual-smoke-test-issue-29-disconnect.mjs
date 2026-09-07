import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer, connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const stateHome = process.env.XDG_STATE_HOME?.startsWith("/")
  ? process.env.XDG_STATE_HOME
  : join(homedir(), ".local", "state");
const repositories = join(stateHome, "pions", "repositories");
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function workerConfigs(root) {
  const found = [];
  for (const repository of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!repository.isDirectory()) continue;
    const runtime = join(root, repository.name, "runtime");
    for (const operation of await readdir(runtime, { withFileTypes: true }).catch(() => [])) {
      if (operation.isDirectory()) found.push(join(runtime, operation.name, "worker.v7.json"));
    }
  }
  return found;
}

const existing = new Set(await workerConfigs(repositories));
console.log("次のpions_delegate呼び出しを待っています。");

let configPath;
let config;
for (let attempt = 0; attempt < 6_000; attempt += 1) {
  const candidate = (await workerConfigs(repositories)).find((path) => !existing.has(path));
  if (candidate !== undefined) {
    try {
      config = JSON.parse(await readFile(candidate, "utf8"));
      configPath = candidate;
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  await delay(10);
}
if (configPath === undefined || config === undefined) {
  throw new Error("60秒以内に新しいワーカー設定が作成されませんでした");
}
const suffix = createHash("sha256").update(config.operationId).digest("hex").slice(0, 16);
const proxyDirectory = join(tmpdir(), `pions-issue29-${process.getuid?.() ?? "user"}`);
const proxyPath = join(proxyDirectory, `${suffix}.sock`);
await mkdir(proxyDirectory, { recursive: true, mode: 0o700 });
await chmod(proxyDirectory, 0o700);
await rm(proxyPath, { force: true });

let disconnect;
const disconnected = new Promise((resolve) => {
  disconnect = resolve;
});
const server = createServer((workerSocket) => {
  const runtimeSocket = connect(config.socketPath);
  let controlBuffer = "";
  let didDisconnect = false;

  workerSocket.on("data", (chunk) => runtimeSocket.write(chunk));
  runtimeSocket.on("data", (chunk) => {
    workerSocket.write(chunk);
    controlBuffer += chunk.toString("utf8");
    const lines = controlBuffer.split("\n");
    controlBuffer = lines.pop() ?? "";
    if (!didDisconnect && lines.some((line) => line.includes('"type":"begin"'))) {
      didDisconnect = true;
      setTimeout(() => {
        runtimeSocket.end();
        disconnect();
      }, 250);
    }
  });
  workerSocket.on("error", () => undefined);
  runtimeSocket.on("error", () => undefined);
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(proxyPath, resolve);
});

const replacementPath = `${configPath}.issue29.tmp`;
await writeFile(replacementPath, `${JSON.stringify({ ...config, socketPath: proxyPath })}\n`, { mode: 0o600 });
await rename(replacementPath, configPath);
console.log(`Operation ${config.operationId} のbegin後に通信を切断します。`);

await Promise.race([
  disconnected,
  delay(30_000).then(() => {
    throw new Error("30秒以内にbeginを観測できませんでした");
  }),
]);
console.log("通信を切断しました。オペレーション状態とHerdrペインを確認してください。");
await delay(5_000);
server.close();
await rm(proxyPath, { force: true });
