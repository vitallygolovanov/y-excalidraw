import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";
import * as Y from "yjs";

async function loadBindingModule() {
  const entryPoint = path.resolve("src/index.ts");
  const result = await build({
    entryPoints: [entryPoint],
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
    sourcemap: "inline",
    absWorkingDir: path.resolve(),
    sourceRoot: pathToFileURL(path.resolve()).href,
    plugins: [
      {
        name: "stub-excalidraw-runtime",
        setup(build) {
          build.onResolve({ filter: /^@excalidraw\/excalidraw$/ }, () => ({
            path: "@excalidraw/excalidraw",
            namespace: "stub-excalidraw-runtime",
          }));

          build.onLoad({ filter: /.*/, namespace: "stub-excalidraw-runtime" }, () => ({
            contents: `export const CaptureUpdateAction = { IMMEDIATELY: "IMMEDIATELY", NEVER: "NEVER", EVENTUALLY: "EVENTUALLY" };`,
            loader: "js",
          }));
        },
      },
    ],
  });

  const output = result.outputFiles[0];
  return import(`data:text/javascript;base64,${Buffer.from(output.contents).toString("base64")}`);
}

function createYElement(id, version = 1, pos = id) {
  return new Y.Map(Object.entries({
    pos,
    el: {
      id,
      version,
      versionNonce: version,
      isDeleted: false,
    },
  }));
}

function createApi() {
  let sceneElements = [];
  const updateSceneCalls = [];

  return {
    api: {
      id: "test-api",
      onChange() {
        return () => undefined;
      },
      getSceneElements() {
        return sceneElements;
      },
      updateScene(payload) {
        updateSceneCalls.push(payload);
        if (payload.elements) {
          sceneElements = payload.elements;
        }
      },
      addFiles() {},
    },
    updateSceneCalls,
  };
}

const { ExcalidrawBinding } = await loadBindingModule();

test("initial Yjs hydration is never captured in Excalidraw history", () => {
  const doc = new Y.Doc();
  const yElements = doc.getArray("elements");
  const yAssets = doc.getMap("assets");
  yElements.push([createYElement("A")]);

  const { api, updateSceneCalls } = createApi();
  const binding = new ExcalidrawBinding(yElements, yAssets, api);

  assert.equal(updateSceneCalls.length, 1);
  assert.equal(updateSceneCalls[0].captureUpdate, "NEVER");
  assert.deepEqual(updateSceneCalls[0].elements.map((element) => element.id), ["A"]);

  binding.destroy();
});

test("remote Yjs element updates are never captured in Excalidraw history", () => {
  const doc = new Y.Doc();
  const yElements = doc.getArray("elements");
  const yAssets = doc.getMap("assets");
  yElements.push([createYElement("A")]);

  const { api, updateSceneCalls } = createApi();
  const binding = new ExcalidrawBinding(yElements, yAssets, api);

  updateSceneCalls.length = 0;
  yElements.push([createYElement("B", 1, "b")]);

  assert.equal(updateSceneCalls.length, 1);
  assert.equal(updateSceneCalls[0].captureUpdate, "NEVER");
  assert.deepEqual(updateSceneCalls[0].elements.map((element) => element.id), ["A", "B"]);

  binding.destroy();
});