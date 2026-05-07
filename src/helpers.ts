import { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import * as Y from "yjs"

export type OrderedElementSnapshot = {
  id: string,
  version: number,
  pos: string,
}

type OrderedYjsEntry = {
  el: ExcalidrawElement,
  pos: string,
}


export const moveArrayItem = <T>(arr: T[], from: number, to: number, inPlace = true) => {
  if (!inPlace) {
    arr = [...arr]
  }
  arr.splice(to, 0, arr.splice(from, 1)[0]);
  return arr
};

// https://stackoverflow.com/a/75988895
export const debounce = (callback: any, wait: number) => {
  let timeoutId: NodeJS.Timeout | null = null;
  return (...args: unknown[]): void => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      callback(...args);
    }, wait);
  };
}

export const areElementsSame = (els1: readonly {id: string, version: number}[], els2: readonly {id: string, version: number}[]) => {
  if (els1.length !== els2.length) {
    return false
  }

  for (let i=0; i<els1.length; i++) {
    if (els1[i].id !==  els2[i].id || els1[i].version !== els2[i].version ) {
      return false
    }
  }

  return true
}

const compareOrderedYjsEntries = (a: OrderedYjsEntry, b: OrderedYjsEntry) => {
  if (a.pos > b.pos) {
    return 1
  }

  if (a.pos < b.pos) {
    return -1
  }

  return a.el.id > b.el.id ? 1 : (a.el.id < b.el.id ? -1 : 0)
}

const shouldReplaceDuplicateEntry = (current: OrderedYjsEntry, candidate: OrderedYjsEntry) => {
  if (candidate.el.version !== current.el.version) {
    return candidate.el.version > current.el.version
  }

  if (candidate.pos !== current.pos) {
    return candidate.pos > current.pos
  }

  return false
}

const getOrderedUniqueYjsEntries = (yArray: Y.Array<Y.Map<any>>): OrderedYjsEntry[] => {
  const entries = yArray.toArray()
    .map((entry) => ({
      el: entry.get("el") as ExcalidrawElement,
      pos: (entry.get("pos") as string | undefined) ?? "",
    }))
    .sort(compareOrderedYjsEntries)

  const uniqueEntries = new Map<string, OrderedYjsEntry>()

  for (const entry of entries) {
    const current = uniqueEntries.get(entry.el.id)

    if (!current || shouldReplaceDuplicateEntry(current, entry)) {
      uniqueEntries.set(entry.el.id, entry)
    }
  }

  return [...uniqueEntries.values()].sort(compareOrderedYjsEntries)
}

export const yjsToExcalidraw = (yArray: Y.Array<Y.Map<any>>): ExcalidrawElement[] => {
  return getOrderedUniqueYjsEntries(yArray).map((entry) => entry.el)
}

export const yjsToOrderedSnapshot = (yArray: Y.Array<Y.Map<any>>): OrderedElementSnapshot[] => {
  return getOrderedUniqueYjsEntries(yArray).map((entry) => ({
    id: entry.el.id,
    version: entry.el.version,
    pos: entry.pos,
  }))
}