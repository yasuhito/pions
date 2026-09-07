// THROWAWAY PROTOTYPE: authenticated host and acceptance gate.
import { appendFile, readFile, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HostProtocolPeer } from "/home/yasuhito/Work/pions/dist/src/internal/worker-protocol.js";

const execFileAsync = promisify(execFile);
const configPath = process.argv[2];
const config = JSON.parse(await readFile(configPath, "utf8"));
const log = async (event, details = {}) => appendFile(config.evidencePath, `${JSON.stringify({ at: Date.now(), actor: "host", event, ...details })}\n`, { mode: 0o600 });
await unlink(config.socketPath).catch(() => {});
const peer = new HostProtocolPeer({ operationId: config.operationId, capability: config.capability });
let workerPid;
let success = false;
let socket;
const server = createServer((accepted) => {
  if (socket) return accepted.destroy();
  socket = accepted;
  void log("connected");
  accepted.on("data", async (bytes) => {
    try {
      for (const event of peer.receive(bytes)) {
        await log("protocol_event", { protocolEvent: event });
        if (event.type === "started") {
          workerPid = event.processId;
          if (config.behavior === "cancel") {
            setTimeout(() => {
              const request = peer.requestCancellation();
              if (request) {
                accepted.write(request);
                void log("cancel_sent");
              }
            }, config.cancelDelayMs ?? 500);
          } else if (config.behavior === "disconnect") {
            setTimeout(() => {
              void log("disconnecting_without_ack");
              accepted.destroy();
              server.close();
            }, config.disconnectDelayMs ?? 500);
          }
        }
        if (event.type === "results_received") {
          success = true;
          const delivery = event.reception.deliveries[0];
          await log("before_ack", { workerAlive: isAlive(workerPid), delayMs: config.ackDelayMs });
          await sleep(config.ackDelayMs ?? 0);
          const acknowledgement = peer.acknowledgeResult({
            operationId: config.operationId,
            digest: delivery.digest,
            sequenceNumber: delivery.sequenceNumber,
          });
          accepted.write(acknowledgement.bytes);
          await log("ack_sent", { complete: acknowledgement.complete, workerAlive: isAlive(workerPid) });
          accepted.end();
        } else if (event.type === "worker_failed" || event.type === "worker_cancelled" || event.type === "worker_configuration_failed") {
          await log("non_success_retained", { kind: event.type, workerAlive: isAlive(workerPid) });
          accepted.end();
        }
      }
    } catch (error) {
      await log("host_protocol_error", { error: String(error) });
      accepted.destroy();
    }
  });
  accepted.on("close", async () => {
    await log("connection_closed", { success, workerAlive: isAlive(workerPid) });
    if (success && config.closeOnSuccess) {
      const stopped = await waitStopped(workerPid, 10000);
      await log("worker_stop_observed", { stopped });
      if (stopped) {
        try {
          const { stdout, stderr } = await execFileAsync("herdr", ["pane", "close", config.paneId]);
          await log("pane_close_requested", { stdout: stdout.trim(), stderr: stderr.trim() });
        } catch (error) {
          await log("pane_close_failed", { error: String(error) });
        }
      }
    }
    server.close();
  });
});
server.listen(config.socketPath, async () => {
  await log("listening", { socketPath: config.socketPath });
  console.log("READY");
});
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function waitStopped(pid, timeout) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (!isAlive(pid)) return true;
    await sleep(50);
  }
  return !isAlive(pid);
}
