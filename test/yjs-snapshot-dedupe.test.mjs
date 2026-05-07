import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";
import * as Y from "yjs";

async function loadHelpersModule() {
  const entryPoint = path.resolve("src/helpers.ts");
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

const { yjsToExcalidraw, yjsToOrderedSnapshot } = await loadHelpersModule();

test("deduplicates duplicate Yjs Excalidraw ids before building scene snapshots", () => {
  const doc = new Y.Doc();
  const yElements = doc.getArray("elements");

  yElements.push([
    new Y.Map(Object.entries({ pos: "b0C", el: { id: "A", version: 1 } })),
    new Y.Map(Object.entries({ pos: "b0D", el: { id: "B", version: 1 } })),
    new Y.Map(Object.entries({ pos: "b0E", el: { id: "dup", version: 1 } })),
    new Y.Map(Object.entries({ pos: "b0E", el: { id: "C", version: 1 } })),
    new Y.Map(Object.entries({ pos: "b0F", el: { id: "dup", version: 1 } })),
    new Y.Map(Object.entries({ pos: "b0G", el: { id: "D", version: 1 } })),
  ]);

  assert.deepEqual(
    yjsToExcalidraw(yElements).map((element) => element.id),
    ["A", "B", "C", "dup", "D"],
  );

  assert.deepEqual(
    yjsToOrderedSnapshot(yElements),
    [
      { id: "A", version: 1, pos: "b0C" },
      { id: "B", version: 1, pos: "b0D" },
      { id: "C", version: 1, pos: "b0E" },
      { id: "dup", version: 1, pos: "b0F" },
      { id: "D", version: 1, pos: "b0G" },
    ],
  );
});