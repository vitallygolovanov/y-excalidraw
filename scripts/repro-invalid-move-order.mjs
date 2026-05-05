import { loadDiffModule } from "./load-diff-module.mjs";

const { getDeltaOperationsForElements } = await loadDiffModule();

const lastKnownElements = [
  { id: "A", version: 1, pos: "a1" },
  { id: "B", version: 1, pos: "a0" },
  { id: "C", version: 1, pos: "a2" },
];

const newElements = [
  { id: "A", version: 1 },
  { id: "C", version: 1 },
  { id: "B", version: 1 },
];

const result = getDeltaOperationsForElements(lastKnownElements, newElements);

console.log(JSON.stringify({
  operations: result.operations,
  lastKnownElements: result.lastKnownElements,
}, null, 2));