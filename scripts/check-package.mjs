import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
if (manifest.name !== "@yasuhito/pions" || manifest.version !== "0.1.0") {
  throw new Error("Unexpected package identity");
}
if (
  JSON.stringify(manifest.pi?.extensions) !==
  JSON.stringify(["./dist/src/extension.js"])
) {
  throw new Error("Pi manifest must declare only the Pions extension");
}
if (
  JSON.stringify(Object.keys(manifest.dependencies ?? {}).sort()) !==
  JSON.stringify(["effect", "typebox"])
) {
  throw new Error("Unexpected production dependencies");
}

execFileSync("npm", ["run", "build"], { stdio: "inherit" });
const [pack] = JSON.parse(
  execFileSync("npm", ["pack", "--ignore-scripts", "--dry-run", "--json"], {
    encoding: "utf8",
  })
);
const paths = new Set(pack.files.map(({ path }) => path));
const expected = new Set([
  "README.md",
  "package.json",
  "dist/src/extension.js",
  "dist/src/worker-extension.js",
  ...[
    "event-store/codec",
    "event-store/file-storage",
    "event-store/index",
    "event-store/intent",
    "event-store/model",
    "event-store/reducer",
    "event-store/store",
    "has-code",
    "herdr-presentation",
    "pi-extension",
    "project-worker-configuration",
    "repository-state",
    "result-acceptance-transaction",
    "result-acceptance",
    "result-digest",
    "result-runtime",
    "runtime",
    "services",
    "start-instruction",
    "sync-directory",
    "types",
    "visible-runtime",
    "visible-worker",
    "worker-configuration",
    "worker-extension-entry",
    "worker-extensions",
    "worker-process-control",
    "worker-protocol",
  ].map((name) => `dist/src/internal/${name}.js`),
]);
const unexpected = [...paths].filter((path) => !expected.has(path));
const missing = [...expected].filter((path) => !paths.has(path));
if (unexpected.length || missing.length) {
  throw new Error(
    `Unexpected tarball files: ${unexpected.join(", ")}; missing: ${missing.join(", ")}`
  );
}
console.error(`Package contents verified (${paths.size} files)`);
