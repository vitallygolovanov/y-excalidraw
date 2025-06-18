import type {
  BinaryFileData,
  BinaryFiles,
  Collaborator,
  ExcalidrawImperativeAPI,
  SocketId,
} from "@excalidraw/excalidraw/types";
import type * as awarenessProtocol from "y-protocols/awareness";
import * as Y from "yjs"
import { areElementsSame, debounce, yjsToExcalidraw } from "./helpers";
import { applyAssetOperations, applyElementOperations, getDeltaOperationsForAssets, getDeltaOperationsForElements, LastKnownOrderedElement, Operation } from "./diff";
export { yjsToExcalidraw }

export class ExcalidrawBinding {
  yElements: Y.Array<Y.Map<any>>
  yAssets: Y.Map<any>
  api: ExcalidrawImperativeAPI;
  awareness?: awarenessProtocol.Awareness;
  undoManager?: Y.UndoManager;

  subscriptions: (() => void)[] = [];
  collaborators: Map<SocketId, Collaborator> = new Map();
  lastKnownElements: LastKnownOrderedElement[] = []
  lastKnownFileIds: Set<string> = new Set();

  /**
   * Creates a binding between an Excalidraw instance and Yjs shared data structures,
   * enabling real-time collaborative editing of shapes, assets, and user presence.
   *
   * @param yElements - A Y.Array of Y.Map entries representing the shared Excalidraw elements.
   * @param yAssets   - A Y.Map for storing shared binary assets (images, files) by ID.
   * @param api       - The Excalidraw Imperative API instance used to read from and write to the canvas.
   * @param awareness - (optional) A Yjs Awareness instance for propagating and receiving
   *                    cursor positions, selections, user info, and other presence data.
   * @param undoConfig - (optional) Configuration for undo/redo support:
   *                     - excalidrawDom: The root HTMLElement of the Excalidraw canvas.
   *                     - undoManager: A Y.UndoManager instance managing shared undo/redo.
   * @param middleware - (optional) Hooks for customizing data before it is synced:
   *                     - transformLocalFiles:
   *                        Invoked before pushing local changes into Yjs.
   *                        Receives the current files, must return possibly mutated copy.
   *                     - transformRemoteFiles:
   *                        Invoked when new binary files arrive from remote peers;
   *                        receives an array of BinaryFileData and must return
   *                        the final array to be applied.
   */
  constructor(
    yElements: Y.Array<Y.Map<any>>,
    yAssets: Y.Map<any>,
    api: ExcalidrawImperativeAPI,
    awareness?: awarenessProtocol.Awareness,
    undoConfig?: { excalidrawDom: HTMLElement; undoManager: Y.UndoManager },
    middleware?: {
      /** intercept and mutate assets what we push to Yjs */
      transformLocalFiles?: (files: BinaryFiles) => BinaryFiles;
      /**
       * @param files   the incoming remote files
       * @returns       an array of files to add to Excalidraw, or `undefined` to skip auto‐add
       */
      transformRemoteFiles?: (
        files: BinaryFileData[]
      ) => BinaryFileData[] | void;
    }
  ) {
    this.yElements = yElements;
    this.yAssets = yAssets;
    this.api = api;
    this.awareness = awareness;
    const excalidrawDom = undoConfig?.excalidrawDom
    this.undoManager = undoConfig?.undoManager

    // Listener for changes made on excalidraw by current user
    this.subscriptions.push(
      this.api.onChange((_, state, files) => {
        // TODO: Excalidraw doesn't delete the asset from the map when the associated item is deleted.
        let elements = this.api.getSceneElements(); // This returns without deleted elements

        // Invoke a callback if provided
        if (middleware?.transformLocalFiles) {
          files = middleware.transformLocalFiles(files);
        }

        // This fires very often even when data is not changed, so keeping a fast procedure to check if anything changed or not
        // Even on move operations, the version property changes so this should work
        let operations: Operation[] = []
        if (!areElementsSame(this.lastKnownElements, elements)) {
          const res = getDeltaOperationsForElements(this.lastKnownElements, elements)
          operations = res.operations
          this.lastKnownElements = res.lastKnownElements
          applyElementOperations(this.yElements, operations, this)
        }

        const res = getDeltaOperationsForAssets(this.lastKnownFileIds, files)
        const assetOperations = res.operations
        this.lastKnownFileIds = res.lastKnownFileIds
        if (assetOperations.length > 0) {
          applyAssetOperations(this.yAssets, assetOperations, this)
        }

        if (this.awareness) {
          // update selected awareness
          this.awareness.setLocalStateField(
            "selectedElementIds",
            state.selectedElementIds,
          );
        }
      }),
    );

    // Listener for changes made on yElements by remote users
    const _remoteElementsChangeHandler = (event: Array<Y.YEvent<any>>, txn: Y.Transaction) => {
      if (txn.origin === this) {
        return
      }

      // Get changed elements from events
      const changedElementIds = new Set(event.flatMap(e => {
        if (e instanceof Y.YMapEvent) {
         return [e.target.get("el").id as string]
        }
        return []
      }));

      const remoteElements = yjsToExcalidraw(this.yElements);
      const elements = remoteElements.map((el) => {
        if (changedElementIds.has(el.id)) {
          return el;
        }
        return this.api.getSceneElements().find(existingEl => existingEl.id === el.id) || el;
      });

      this.lastKnownElements = this.yElements.toArray()
        .map((x) => ({ id: x.get("el").id, version: x.get("el").version, pos: x.get("pos") }))
        .sort((a, b) => {
          const key1 = a.pos;
          const key2 = b.pos;
          return key1 > key2 ? 1 : (key1 < key2 ? -1 : 0)
        })
      this.api.updateScene({ elements })
    }
    this.yElements.observeDeep(_remoteElementsChangeHandler)
    this.subscriptions.push(() => this.yElements.unobserveDeep(_remoteElementsChangeHandler))

    // Listener for changes made on yAssets by remote users
    const _remoteFilesChangeHandler = (events: Y.YMapEvent<any>, txn: Y.Transaction) => {
      if (txn.origin === this) {
        return
      }

      let addedFiles = [...events.keysChanged].map(
        (key) => this.yAssets.get(key) as BinaryFileData
      );

      if (middleware?.transformRemoteFiles) {
        const res = middleware.transformRemoteFiles(addedFiles);

        if (!res) return; // If the middleware indicates to skip auto-adding files, we do not add them

        addedFiles = res;
      }

      this.api.addFiles(addedFiles);
    }
    this.yAssets.observe(_remoteFilesChangeHandler);  // only observe and not observe deep as assets are only added/deleted not updated
    this.subscriptions.push(() => {
      this.yAssets.unobserve(_remoteFilesChangeHandler);
    });

    if (this.awareness) {
      const awareness = this.awareness;

      // Listener for awareness changes made by remote users
      const _remoteAwarenessChangeHandler = ({
        added,
        updated,
        removed,
      }: {
        added: number[];
        updated: number[];
        removed: number[];
      }) => {
        const states = awareness.getStates();

        const collaborators = new Map(this.collaborators);
        const update = [...added, ...updated];
        for (const id of update) {
          const state = states.get(id);
          if (!state) {
            continue;
          }

          collaborators.set(id.toString() as SocketId, {
            pointer: state.pointer,
            button: state.button,
            selectedElementIds: state.selectedElementIds,
            username: state.user?.name,
            color: state.user?.color,
            avatarUrl: state.user?.avatarUrl,
            userState: state.user?.state,
          });
        }
        for (const id of removed) {
          collaborators.delete(id.toString() as SocketId);
        }
        collaborators.delete(awareness.clientID.toString() as SocketId);
        this.api.updateScene({ collaborators });
        this.collaborators = collaborators;
      };
      this.awareness.on("change", _remoteAwarenessChangeHandler);
      this.subscriptions.push(() => {
        awareness.off("change", _remoteAwarenessChangeHandler);
      });
    }

    if (this.undoManager && excalidrawDom) {
      this.setupUndoRedo(excalidrawDom)
    } else if (this.undoManager && !excalidrawDom) {
      console.warn("ExcalidrawBinding: undoManager is set but excalidrawDom is not provided. Undo/Redo functionality will not be available.");
    }

    // init elements
    const initialValue = yjsToExcalidraw(this.yElements)
    this.lastKnownElements = this.yElements.toArray()
      .map((x) => ({ id: x.get("el").id, version: x.get("el").version, pos: x.get("pos") }))
      .sort((a, b) => {
        const key1 = a.pos;
        const key2 = b.pos;
        return key1 > key2 ? 1 : (key1 < key2 ? -1 : 0)
      })    
    this.api.updateScene({ elements: initialValue });

    const initialAssets = [...this.yAssets.keys()].map(
      (key) => this.yAssets.get(key) as BinaryFileData
    );
    // init assets
    if (middleware?.transformRemoteFiles) {
      const res = middleware?.transformRemoteFiles(initialAssets);

      if (res) {
        this.api.addFiles(res);
      }
    } else {
      this.api.addFiles(initialAssets);
    }

    // init collaborators
    const collaborators = new Map()

    if (this.awareness) {
      for (let id of this.awareness.getStates().keys()) {
        const state = this.awareness.getStates().get(id)

        if (!state) {
          continue;
        }

        collaborators.set(id.toString(), {
          pointer: state.pointer,
          button: state.button,
          selectedElementIds: state.selectedElementIds,
          username: state.user?.name,
          color: state.user?.color,
          avatarUrl: state.user?.avatarUrl,
          userState: state.user?.state,
        });
      }
    }

    this.api.updateScene({ collaborators });
    this.collaborators = collaborators;
  }

  public onPointerUpdate = (payload: {
    pointer: {
      x: number;
      y: number;
      tool: "pointer" | "laser";
    };
    button: "down" | "up";
  }) => {
    if (this.awareness) {
      this.awareness.setLocalStateField("pointer", payload.pointer);
      this.awareness.setLocalStateField("button", payload.button);
    }
  };

  private setupUndoRedo(excalidrawDom: HTMLElement) {
    if (!this.undoManager || !excalidrawDom) {
      console.warn("ExcalidrawBinding: undoManager is set but excalidrawDom is not provided. Undo/Redo functionality will not be available.");
      return;
    }
    const undoManager = this.undoManager;

    this.undoManager.addTrackedOrigin(this)
    this.subscriptions.push(() => undoManager.removeTrackedOrigin(this))

    // listen for undo/redo keys
    const _keyPressHandler = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.key?.toLocaleLowerCase() === 'z') {
        event.stopPropagation();
        undoManager.redo()
      }
      else if (event.ctrlKey && event.key?.toLocaleLowerCase() === 'z') {
        event.stopPropagation();
        undoManager.undo()
      }
    }
    excalidrawDom.addEventListener('keydown', _keyPressHandler, { capture: true });
    this.subscriptions.push(() => excalidrawDom?.removeEventListener('keydown', _keyPressHandler, { capture: true }))

    // hijack the undo/redo buttons
    // these get destroyed/recreated when view changes from desktop->mobile, so the listeners need to be added again
    let undoButton: HTMLButtonElement | null;
    let redoButton: HTMLButtonElement | null;

    const _undoBtnHandler = (event: MouseEvent) => {
      event.stopImmediatePropagation();
      undoManager.undo()
    }
    const _redoBtnHandler = (event: MouseEvent) => {
      event.stopImmediatePropagation();
      undoManager.redo()
    }

    const _resizeListener = () => {
      if (!undoButton || !undoButton.isConnected) {
        undoButton?.removeEventListener('click', _undoBtnHandler)
        undoButton = excalidrawDom.querySelector('[aria-label="Undo"]');  // Assuming new undoButton is added to dom by now
        undoButton?.addEventListener('click', _undoBtnHandler);
      }

      if (!redoButton || !redoButton.isConnected) {
        redoButton?.removeEventListener('click', _redoBtnHandler)
        redoButton = excalidrawDom.querySelector('[aria-label="Redo"]');  // Assuming new redoButton is added to dom by now
        redoButton?.addEventListener('click', _redoBtnHandler);
      }
    }

    const ro = new ResizeObserver(debounce(_resizeListener, 100))
    ro.observe(excalidrawDom)

    // Call resize on init
    _resizeListener()

    this.subscriptions.push(() => undoButton?.removeEventListener('click', _undoBtnHandler))
    this.subscriptions.push(() => redoButton?.removeEventListener('click', _redoBtnHandler))
    this.subscriptions.push(() => ro.disconnect())
  }

  destroy() {
    for (const s of this.subscriptions) {
      s();
    }
  }
}