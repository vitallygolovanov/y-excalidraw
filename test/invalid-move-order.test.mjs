import test from "node:test";
import assert from "node:assert/strict";

import { loadDiffModule } from "../scripts/load-diff-module.mjs";

const { getDeltaOperationsForElements } = await loadDiffModule();

test("repairs invalid tracked ordering before computing a move", () => {
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
  const reindexOperation = result.operations.find((operation) => operation.type === "reindex");
  const moveOperation = result.operations.find((operation) => operation.type === "move");

  assert.ok(reindexOperation, "expected a reindex operation before the move");
  assert.ok(moveOperation, "expected the move operation to still be emitted");
  assert.equal(moveOperation.id, "C");
  assert.deepEqual(result.lastKnownElements.map((element) => element.id), ["A", "C", "B"]);

  const repairedPositions = reindexOperation.data.map((entry) => entry.pos);
  for (let index = 1; index < repairedPositions.length; index += 1) {
    assert.ok(repairedPositions[index - 1] < repairedPositions[index]);
  }
});

test("reports invalid tracked ordering recovery details to callers", () => {
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

  const recoveryEvents = [];

  getDeltaOperationsForElements(lastKnownElements, newElements, true, {
    onInvalidMoveOrderingRecovery: (event) => recoveryEvents.push(event),
  });

  assert.equal(recoveryEvents.length, 1);
  assert.deepEqual(recoveryEvents[0], {
    id: "C",
    fromIndex: 2,
    toIndex: 1,
    leftSortIndex: "a1",
    rightSortIndex: "a0",
    orderWindow: [
      { id: "A", index: 0, pos: "a1" },
      { id: "B", index: 1, pos: "a0" },
      { id: "C", index: 2, pos: "a2" },
    ],
  });
});

test("deduplicates duplicate local scene ids before diffing", () => {
  const lastKnownElements = [
    { id: "A", version: 1, pos: "a0" },
    { id: "B", version: 1, pos: "a1" },
  ];

  const newElements = [
    { id: "A", version: 1, updated: 1 },
    { id: "dup", version: 1, updated: 1 },
    { id: "B", version: 1, updated: 1 },
    { id: "dup", version: 1, updated: 2 },
  ];

  const result = getDeltaOperationsForElements(lastKnownElements, newElements);

  assert.deepEqual(
    result.lastKnownElements.map((element) => element.id),
    ["A", "B", "dup"],
  );

  assert.equal(
    result.lastKnownElements.filter((element) => element.id === "dup").length,
    1,
  );
});

test("deduplicates duplicate last-known ids before move computation", () => {
  const lastKnownElements = [
    { id: "A", version: 1, pos: "a0" },
    { id: "dup", version: 1, pos: "a1" },
    { id: "B", version: 1, pos: "a2" },
    { id: "dup", version: 1, pos: "a3" },
  ];

  const newElements = [
    { id: "A", version: 1 },
    { id: "B", version: 1 },
    { id: "dup", version: 1 },
  ];

  const result = getDeltaOperationsForElements(lastKnownElements, newElements);

  assert.deepEqual(
    result.lastKnownElements.map((element) => element.id),
    ["A", "B", "dup"],
  );

  assert.equal(
    result.lastKnownElements.filter((element) => element.id === "dup").length,
    1,
  );
});