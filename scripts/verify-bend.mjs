import { spawnSync } from "node:child_process";

import { bend } from "./bend-executable.mjs";

const environment = { ...process.env, BEND: bend };
const check = spawnSync(bend, ["--help"], {
  env: environment,
  stdio: "ignore",
});
if (check.error || check.status !== 0) {
  console.error(
    `Cannot start Bend executable ${JSON.stringify(bend)}. Install Bend 2 and add it to PATH, or set BEND to its executable path.`
  );
  process.exit(1);
}

const tests = spawnSync(
  process.execPath,
  ["--test", "scripts/verify-bend.test.mjs"],
  {
    env: environment,
    stdio: "inherit",
  }
);
if (tests.status !== 0) process.exit(tests.status ?? 1);

const proof = spawnSync(bend, ["verification/bend/PROOF.bend", "--safe"], {
  env: environment,
  stdio: "inherit",
});
process.exit(proof.status ?? 1);
