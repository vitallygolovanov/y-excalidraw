import path from "node:path";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

export async function loadDiffModule() {
  const entryPoint = path.resolve("src/diff.ts");
  const result = await build({
    entryPoints: [entryPoint],
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
    sourcemap: "inline",
    absWorkingDir: path.resolve(),
    sourceRoot: pathToFileURL(path.resolve()).href,
  });

  const output = result.outputFiles[0];
  return import(`data:text/javascript;base64,${Buffer.from(output.contents).toString("base64")}`);
}