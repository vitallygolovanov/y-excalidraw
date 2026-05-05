import { ExcalidrawElement, NonDeletedExcalidrawElement } from "@excalidraw/excalidraw/element/types"
import { moveArrayItem, yjsToExcalidraw } from "./helpers"
import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';
import * as Y from 'yjs'
import { BinaryFileData, BinaryFiles } from "@excalidraw/excalidraw/types";
import { ExcalidrawBinding } from "./index";

export type FixedIndex = number & { _brand: "FixedIndex" };
export type OrderedRemoteElement = { index: FixedIndex, element: ExcalidrawElement}
export type NullableOrderedRemoteElement = { index: FixedIndex, element: ExcalidrawElement | undefined}


export type UpdateOperation = { type: 'update', id: string, index: number, element: ExcalidrawElement }
export type AppendOperation = { type: 'append', id: string, pos: string, element: ExcalidrawElement }
export type DeleteOperation = { type: 'delete', id: string, index: number }
export type MoveOperation = { type: 'move', id: string, fromIndex: number, toIndex: number, pos: string; }
export type ReindexOperation = { type: 'reindex', data: { id: string, pos: string }[] }
export type BulkAppendOperation = { type: 'bulkAppend', data: { id: string, pos: string; element: ExcalidrawElement }[] }
export type BulkDeleteOperation = { type: 'bulkDelete', id: string, index: number, data: { id: string, index: number }[] }

export type Operation = UpdateOperation | AppendOperation | DeleteOperation | MoveOperation | ReindexOperation | BulkAppendOperation | BulkDeleteOperation

export type DestructiveWriteClassification =
  | {
      kind: 'safe'
      previousCount: number
      nextCount: number
      deleteCount: number
    }
  | {
      kind: 'full-scene-clear'
      previousCount: number
      nextCount: number
      deleteCount: number
    }

type OperationTracker = { elementIds: string[], idMap: { [id: string]: { id: string, version: number, pos: string; index: number } } }

export type LastKnownOrderedElement = {id: string, version: number, pos: string}
export type InvalidMoveOrderingRecoveryEvent = {
  id: string
  fromIndex: number
  toIndex: number
  leftSortIndex: string
  rightSortIndex: string
  orderWindow: { id: string, index: number, pos: string | null }[]
}

const getMoveBoundarySortIndices = (opsTracker: OperationTracker, fromIndex: number, toIndex: number) => {
  let leftSortIndex: string | null = null
  let rightSortIndex: string | null = null

  if (fromIndex >= 0 && fromIndex < toIndex) {
    leftSortIndex = opsTracker.idMap[opsTracker.elementIds[toIndex]]?.pos || null
    rightSortIndex = opsTracker.idMap[opsTracker.elementIds[toIndex + 1]]?.pos || null
  }
  else {
    leftSortIndex = opsTracker.idMap[opsTracker.elementIds[toIndex - 1]]?.pos || null
    rightSortIndex = opsTracker.idMap[opsTracker.elementIds[toIndex]]?.pos || null
  }

  return { leftSortIndex, rightSortIndex }
}

const buildTrackedOrderWindow = (opsTracker: OperationTracker, centerIndex: number, radius = 2) => {
  const start = Math.max(0, centerIndex - radius)
  const end = Math.min(opsTracker.elementIds.length, centerIndex + radius + 1)

  return opsTracker.elementIds.slice(start, end).map((trackedId, offset) => ({
    id: trackedId,
    index: start + offset,
    pos: opsTracker.idMap[trackedId]?.pos || null,
  }))
}

const reindexTrackedPositions = (opsTracker: OperationTracker, stableIds: ReadonlySet<string>) => {
  let previousSortIndex: string | null = null
  const data: { id: string, pos: string }[] = []

  for (const id of opsTracker.elementIds) {
    if (!stableIds.has(id)) {
      continue
    }

    const pos = generateKeyBetween(previousSortIndex, null)
    previousSortIndex = pos
    opsTracker.idMap[id].pos = pos
    data.push({ id, pos })
  }

  return data
}

export const countDeletedElementsInOperations = (operations: readonly Operation[]): number => {
  let deleteCount = 0

  for (const operation of operations) {
    switch (operation.type) {
      case 'delete': {
        deleteCount += 1
        break
      }
      case 'bulkDelete': {
        deleteCount += operation.data.length
        break
      }
    }
  }

  return deleteCount
}

export const classifyElementOperationsForDestructiveWrite = ({
  previousCount,
  nextCount,
  operations,
}: {
  previousCount: number
  nextCount: number
  operations: readonly Operation[]
}): DestructiveWriteClassification => {
  const deleteCount = countDeletedElementsInOperations(operations)

  if (previousCount > 0 && nextCount === 0 && deleteCount >= previousCount) {
    return {
      kind: 'full-scene-clear',
      previousCount,
      nextCount,
      deleteCount,
    }
  }

  return {
    kind: 'safe',
    previousCount,
    nextCount,
    deleteCount,
  }
}

export const getDeltaOperationsForElements = (
  lastKnownElements: LastKnownOrderedElement[],
  newElements: readonly NonDeletedExcalidrawElement[],
  bulkify = true,
  options?: {
    onInvalidMoveOrderingRecovery?: (event: InvalidMoveOrderingRecoveryEvent) => void
  },
): {operations: Operation[], lastKnownElements: LastKnownOrderedElement[]} => {
  // Final operations are always in this order -> All updates + All appends + All deletes + All moves
  const updateOperations: UpdateOperation[] = []
  const appendOperations: AppendOperation[] = []
  const deleteOperations: DeleteOperation[] = []
  const moveOperations: MoveOperation[] = []
  const reindexOperations: ReindexOperation[] = []
  const stableIds = new Set(lastKnownElements.map((x) => x.id))

  // Updates the old elements as and when an operation is performed on it
  const opsTracker: OperationTracker = {
    elementIds: lastKnownElements.map((x) => x.id),
    // id map is needed to quickly look up index for the element with a given id
    idMap: lastKnownElements.reduce((map: any, data, index) => {
      map[data.id ] = { id: data.id, version: data.version, pos: data.pos, index }
      return map
    }, {})
  }

  const _updateIdIndexLookup = () => {
    opsTracker.idMap = opsTracker.elementIds.reduce((map: any, id, index) => {
      map[id] = { ...opsTracker.idMap[id], index }
      return map
    }, {})
  }

  for (let newElement of newElements) {
    let oldIndex: number | null = null;
    let oldElement: LastKnownOrderedElement | null = null
    if (opsTracker.idMap[newElement.id]) {
      const {index, ...rest} = opsTracker.idMap[newElement.id]
      oldIndex = index
      oldElement = rest
    }
    if (!oldElement) {
      // Always add at the end
      const op = {
        id: newElement.id, version: newElement.version, 
        pos: !bulkify ? generateKeyBetween(opsTracker.idMap[opsTracker.elementIds[opsTracker.elementIds.length - 1]]?.pos, null) : "",
        index: opsTracker.elementIds.length
      }
      opsTracker.elementIds.push(op.id);
      opsTracker.idMap[op.id] = op;
      appendOperations.push({ type: 'append', id: newElement.id, pos: op.pos, element: newElement })
    }
    else if (oldElement && newElement.version !== oldElement.version) {
      const op = {
        // oldIndex is guaranteed to be not null, we are setting it only along with oldElement. 
        // Probably, not a good practice, but I don't want to change the original code too much (yet) If it works, it works
        id: newElement.id, version: newElement.version, pos: oldElement.pos, index: oldIndex! 
      }
      opsTracker.idMap[newElement.id] = op
      updateOperations.push({ type: 'update', id: op.id, index: op.index, element: newElement })
    }
  }

  // Form delete operations
  // We are deleting from left to right
  const newElementIds = new Set(newElements.map((x) => x.id))
  const newOpsTrackerElementIds: string[] = []
  let runningIndex = 0
  for (let i = 0; i < opsTracker.elementIds.length; i++) {
    const id = opsTracker.elementIds[i]
    if (!newElementIds.has(id)) {
      deleteOperations.push({ type: 'delete', index: runningIndex, id })
    }
    else {
      newOpsTrackerElementIds.push(id)
      runningIndex += 1
    }
  }
  if (deleteOperations.length > 0) {
    // Update ops tracker
    opsTracker.elementIds = newOpsTrackerElementIds
    _updateIdIndexLookup()
  }

  // Find move operations
  for (let toIndex = 0; toIndex < newElements.length; toIndex++) {
    const id = newElements[toIndex].id
    const { index: fromIndex } = opsTracker.idMap[id]

    if (toIndex !== fromIndex) {
      let { leftSortIndex, rightSortIndex } = getMoveBoundarySortIndices(opsTracker, fromIndex, toIndex)

      if (leftSortIndex !== null && rightSortIndex !== null && leftSortIndex >= rightSortIndex) {
        const orderWindow = buildTrackedOrderWindow(opsTracker, toIndex)
        const data = reindexTrackedPositions(opsTracker, stableIds)
        const recoveryEvent: InvalidMoveOrderingRecoveryEvent = {
          id,
          fromIndex,
          toIndex,
          leftSortIndex,
          rightSortIndex,
          orderWindow,
        }

        if (data.length > 0) {
          reindexOperations.push({ type: 'reindex', data })
        }

        console.warn('[ExcalidrawBinding] Reindexed invalid move ordering', {
          ...recoveryEvent,
        })
        options?.onInvalidMoveOrderingRecovery?.(recoveryEvent)

        ;({ leftSortIndex, rightSortIndex } = getMoveBoundarySortIndices(opsTracker, fromIndex, toIndex))
      }

      const newSortIndex = generateKeyBetween(leftSortIndex, rightSortIndex)

      // move to correct position, O(n)
      opsTracker.elementIds = moveArrayItem(opsTracker.elementIds, fromIndex, toIndex, true)
      opsTracker.idMap[id].pos = newSortIndex  // update the element's sort index
      _updateIdIndexLookup()  // update every items indices
      moveOperations.push({type: 'move', id, fromIndex, toIndex, pos: newSortIndex})
    }
  }

  const bulkAppendOperations: BulkAppendOperation[] = []
  const bulkDeleteOperations: BulkDeleteOperation[] = []
  if (bulkify) {
    // Merge append operations
    if (appendOperations.length > 0) {
      const sortIndexes = generateNKeysBetween(lastKnownElements[lastKnownElements.length - 1]?.pos, null, appendOperations.length)
      for (let [i, op] of appendOperations.entries()) {
        opsTracker.idMap[op.id].pos = sortIndexes[i]
      }
      bulkAppendOperations.push({
        type: 'bulkAppend',
        data: appendOperations.map((op, _index) => ({ id: op.id, pos: sortIndexes[_index], element: op.element }))
      })
    }

    // Merge continuos delete operations
    // deleteOperations is already sorted i.e items are deleted from left to right
    let lastIndex: number | null = null
    for (let op of deleteOperations) {
      if (lastIndex === null || op.index > lastIndex) {
        bulkDeleteOperations.push({
          type: 'bulkDelete',
          index: op.index,
          id: op.id,
          data: [{ id: op.id, index: op.index }]
        })
        lastIndex = op.index
      }
      else {
        bulkDeleteOperations[bulkDeleteOperations.length - 1].data.push({ id: op.id, index: op.index })
      }
    }
  }

  const operations: Operation[] = !bulkify ?
    [...updateOperations, ...appendOperations, ...deleteOperations, ...reindexOperations, ...moveOperations] :
    [...updateOperations, ...bulkAppendOperations, ...bulkDeleteOperations, ...reindexOperations, ...moveOperations]

  const updatedLastKnownElements = opsTracker.elementIds.map((x) => {
    const {index, ...rest} = opsTracker.idMap[x]
    return rest
  })
  
  return {operations, lastKnownElements: updatedLastKnownElements};
}

export type AssetAppendOperation = { type: 'append', id: string, asset:BinaryFileData }
export type AssetDeleteOperation = { type: 'delete', id: string }
export type AssetOperation = AssetAppendOperation | AssetDeleteOperation

export const getDeltaOperationsForAssets = (lastKnownFileIds: Set<string>, files: BinaryFiles): {operations: AssetOperation[], lastKnownFileIds: Set<string>} => {
  const operations: AssetOperation[] = []

  const newFields: Set<string> = new Set()
  for (let fileId in files) {
    if (!files.hasOwnProperty(fileId)) {
      continue
    }
    newFields.add(fileId)
    if (!lastKnownFileIds.has(fileId)) {
      operations.push({type: "append", id: fileId, asset: files[fileId]})    
    }
  }

  for (let fileId in lastKnownFileIds) {
    if (!files.hasOwnProperty(fileId)) {
      operations.push({type: "delete", id: fileId})
    }
  }

  return {operations, lastKnownFileIds: newFields}
}

export const applyElementOperations = (yElements: Y.Array<Y.Map<any>>, operations: Operation[], origin: ExcalidrawBinding) => {
  // NOTE: yArray doesn't support a move operation (that is reordering elements within an array).
  // So to re-order the only way is to delete the element and insert it at the desired location
  // But that can lead to duplocation in some cases (when 1 person updates the same element and other reorders it)
  // So in order to avoid those cases, for sort order we are creating a new variable called pos which stores the fractoral index
  // We depend on that rather than the elements position in the array to get its correct ordering
  // See the post to understand more -> https://discuss.yjs.dev/t/moving-elements-in-lists/92/15
  // See this to understand more about fratcoral indexing -> https://observablehq.com/@dgreensp/implementing-fractional-indexing

  // Also we could have used yMap at top level rather than yArray
  // But yMaps at top level are not very efficient (memory wise). See this comment for more info -> https://discuss.yjs.dev/t/moving-elements-in-lists/92/23

  yElements.doc!.transact(tr => {
    const _updateYjsIndexMap = () => {
      for (let i=0; i<yElements.length; i++) {
        let item = yElements.get(i).get("el") as ExcalidrawElement
        idYjsIndexMap[item.id] = i
      }
    }
  
    const idYjsIndexMap: {[key: string]: number} = {}
    _updateYjsIndexMap()

    // Apply element operations
    // while adding/updating element, using spread operator and not directly assigning it as when later excalidraw updates the elements, it was affecting the undo-redo feature as it was still refering to the the same object
    for (let op of operations) {
      switch (op.type) {
        case "update": {
          yElements.get(idYjsIndexMap[op.id]).set("el", {...op.element})
          break
        }
        case "append":
        case "bulkAppend": {
          if (op.type === "append") {
            idYjsIndexMap[op.id] = yElements.length;
            yElements.push([new Y.Map<ExcalidrawElement | string>(Object.entries({ pos: op.pos, el: {...op.element } }))])
          }
          else {
            for (let i=0; i<op.data.length; i++) {
              idYjsIndexMap[op.data[i].id] = yElements.length + i;
            }
            yElements.push(
              op.data.map((x) => new Y.Map<any>(Object.entries({ pos: x.pos, el: {...x.element} })))
            )
          }
          break
        }
        case "delete":
        case "bulkDelete": {
          if (op.type === "delete") {
            const deleteIndex = idYjsIndexMap[op.id]
            if (typeof deleteIndex === "number" && deleteIndex >= 0 && deleteIndex < yElements.length) {
              yElements.delete(deleteIndex, 1)
              _updateYjsIndexMap()
            }
          }
          else {
            const indicesToDelete = op.data
              .map((item) => idYjsIndexMap[item.id])
              .filter((index): index is number => (
                typeof index === "number" && index >= 0 && index < yElements.length
              ))
              .sort((a, b) => b - a)

            for (const index of indicesToDelete) {
              if (index >= 0 && index < yElements.length) {
                yElements.delete(index, 1)
              }
            }

            if (indicesToDelete.length > 0) {
              _updateYjsIndexMap()
            }
          }
          break
        }
        case "reindex": {
          for (const item of op.data) {
            const yjsIndex = idYjsIndexMap[item.id]
            if (typeof yjsIndex === "number" && yjsIndex >= 0 && yjsIndex < yElements.length) {
              yElements.get(yjsIndex).set("pos", item.pos)
            }
          }
          break
        }
        case "move": {
          yElements.get(idYjsIndexMap[op.id]).set("pos", op.pos)
          break
        }
      }
    }
  }, origin)
}

export const applyAssetOperations = (yAssets: Y.Map<any>, operations: AssetOperation[], origin?: ExcalidrawBinding) => {
  yAssets.doc!.transact(tr => {
    for (let op of operations) {
      switch (op.type) {
        case "append": {
          yAssets.set(op.id, op.asset)
          break
        }
        case "delete": {
          yAssets.delete(op.id)
          break
        }
      }
    }
  }, origin)
}