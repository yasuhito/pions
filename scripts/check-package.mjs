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
const paths = pack.files.map(({ path }) => path);
const forbidden = paths.filter(
  (path) =>
    !["README.md", "package.json"].includes(path) &&
    (!path.startsWith("dist/src/") ||
      /(?:^|\/)(?:test|review|testing)(?:\/|\.|$)/i.test(path) ||
      path.endsWith(".map") ||
      path.endsWith(".d.ts"))
);
if (forbidden.length > 0)
  throw new Error(`Unexpected tarball files: ${forbidden.join(", ")}`);
if (
  !paths.includes("dist/src/extension.js") ||
  !paths.includes("dist/src/worker-extension.js")
) {
  throw new Error("Tarball is missing an extension entry point");
}
console.log(`Package contents verified (${paths.length} files)`);
