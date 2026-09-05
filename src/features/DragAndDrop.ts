import {
  type MarkdownView,
  Notice,
  Platform,
  Plugin,
  editorInfoField,
} from "obsidian";

import { getIndentUnit, indentString } from "@codemirror/language";
import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView } from "@codemirror/view";

import { CrossNoteMove, crossNoteHistory } from "./CrossNoteMove";
import { Feature } from "./Feature";

import { MyEditor, getEditorFromState } from "../editor";
import { getObsidianDomWindow } from "../obsidianDom";
import { MoveListToDifferentPosition } from "../operations/MoveListToDifferentPosition";
import { List, Root, cmpPos } from "../root";
import { ObsidianSettings } from "../services/ObsidianSettings";
import { OperationPerformer } from "../services/OperationPerformer";
import { Parser } from "../services/Parser";
import { Settings } from "../services/Settings";

const BODY_CLASS = "bullet-plugin-dnd";
const DRAG_START_DISTANCE_PX = 6;
const DROP_ZONE_VERTICAL_OFFSET_PX = 2;

interface DragAndDropDocumentContext {
  doc: Document;
  dropZone: HTMLDivElement;
}

export class DragAndDrop implements Feature {
  private documents = new Map<Document, DragAndDropDocumentContext>();
  private preStart: DragAndDropPreStartState | null = null;
  private state: DragAndDropState | null = null;
  private crossTarget: DragAndDropState | null = null;
  private crossMove: CrossNoteMove | null = null;
  private crossDestination: EditorView | null = null;

  constructor(
    private plugin: Plugin,
    private settings: Settings,
    private obisidian: ObsidianSettings,
    private parser: Parser,
    private operationPerformer: OperationPerformer,
  ) {}

  async load() {
    this.plugin.registerEditorExtension([
      draggingLinesStateField,
      crossNoteHistory,
    ]);
    this.enableFeatureToggle();
    this.addManagedDocument(activeDocument);
    this.plugin.registerEvent(
      this.plugin.app.workspace.on("window-open", this.handleWindowOpen),
    );
    this.plugin.registerEvent(
      this.plugin.app.workspace.on("window-close", this.handleWindowClose),
    );
  }

  async unload() {
    for (const doc of Array.from(this.documents.keys())) {
      this.removeManagedDocument(doc);
    }
    this.disableFeatureToggle();
  }

  private enableFeatureToggle() {
    this.settings.onChange(["dnd"], this.handleSettingsChange);
    this.handleSettingsChange();
  }

  private disableFeatureToggle() {
    this.settings.removeCallback(this.handleSettingsChange);
    for (const doc of this.documents.keys()) {
      doc.body.classList.remove(BODY_CLASS);
    }
  }

  private handleWindowOpen = (_win: unknown, window: Window) => {
    this.addManagedDocument(window.document);
  };

  private handleWindowClose = (_win: unknown, window: Window) => {
    this.removeManagedDocument(window.document);
  };

  private addManagedDocument(doc: Document) {
    if (this.documents.has(doc)) {
      return;
    }

    const domWindow = getObsidianDomWindow(doc);
    const dropZone = domWindow.createDiv();
    dropZone.classList.add("bullet-plugin-drop-zone");
    dropZone.setCssStyles({ display: "none" });
    doc.body.appendChild(dropZone);

    this.documents.set(doc, { doc, dropZone });
    this.addEventListeners(doc);

    if (isFeatureSupported() && this.settings.dragAndDrop) {
      doc.body.classList.add(BODY_CLASS);
    }
  }

  private removeManagedDocument(doc: Document) {
    if (this.preStart?.doc === doc) {
      this.preStart = null;
    }

    if (this.state?.doc === doc) {
      this.cancelDragging();
    }

    const context = this.documents.get(doc);
    if (!context) {
      return;
    }

    this.removeEventListeners(doc);
    doc.body.classList.remove(BODY_CLASS);
    if (context.dropZone.parentNode === doc.body) {
      doc.body.removeChild(context.dropZone);
    }
    this.documents.delete(doc);
  }

  private addEventListeners(doc: Document) {
    doc.addEventListener("mousedown", this.handleMouseDown, {
      capture: true,
    });
    doc.addEventListener("mousemove", this.handleMouseMove);
    doc.addEventListener("mouseup", this.handleMouseUp);
    doc.addEventListener("keydown", this.handleKeyDown);
  }

  private removeEventListeners(doc: Document) {
    doc.removeEventListener("mousedown", this.handleMouseDown, {
      capture: true,
    });
    doc.removeEventListener("mousemove", this.handleMouseMove);
    doc.removeEventListener("mouseup", this.handleMouseUp);
    doc.removeEventListener("keydown", this.handleKeyDown);
  }

  private handleSettingsChange = () => {
    if (!isFeatureSupported()) {
      return;
    }

    for (const doc of this.documents.keys()) {
      if (this.settings.dragAndDrop) {
        doc.body.classList.add(BODY_CLASS);
      } else {
        doc.body.classList.remove(BODY_CLASS);
      }
    }
  };

  private handleMouseDown = (e: MouseEvent) => {
    if (
      !isFeatureSupported() ||
      !this.settings.dragAndDrop ||
      !isClickOnBullet(e)
    ) {
      return;
    }

    const view = getEditorViewFromHTMLElement(e.target as HTMLElement);
    if (!view) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    this.preStart = {
      x: e.x,
      y: e.y,
      target: e.target instanceof Node ? e.target : null,
      view,
      doc: getEventDocument(e),
    };
  };

  private handleMouseMove = (e: MouseEvent) => {
    if (this.preStart && hasMovedEnoughToStartDragging(this.preStart, e)) {
      this.startDragging();
    }
    if (this.state) {
      this.detectAndDrawDropZone(e.x, e.y);
    }
  };

  private handleMouseUp = () => {
    if (this.preStart) {
      this.preStart = null;
    }
    if (this.state) {
      this.stopDragging();
    }
  };

  private handleKeyDown = (e: KeyboardEvent) => {
    if (this.state && e.code === "Escape") {
      this.cancelDragging();
    }
  };

  private startDragging() {
    if (!this.preStart) {
      return;
    }

    const { x, y, target, view } = this.preStart;
    this.preStart = null;

    const editor = getEditorFromState(view.state);
    if (!editor) {
      return;
    }

    const coordsPos = getDragStartOffset(view, target, x, y);
    if (coordsPos === null) {
      return;
    }

    const pos = editor.offsetToPos(coordsPos);
    const root = this.parser.parse(editor, pos);
    if (!root) {
      this.notifyInvalidListStructure();
      return;
    }

    const list = root.getListUnderLine(pos.line);
    if (!list) {
      this.notifyInvalidListStructure();
      return;
    }

    const state = new DragAndDropState(view, editor, root, list);

    this.state = state;
    this.highlightDraggingLines();
  }

  private detectAndDrawDropZone(x: number, y: number) {
    const state = this.getState();
    this.crossMove = null;
    this.crossDestination = null;
    this.hideDropZone();
    const element = state.doc.elementFromPoint?.(x, y) as HTMLElement | null;
    const target = element
      ? getEditorViewFromHTMLElement(element)
      : typeof state.doc.elementFromPoint === "function"
        ? null
        : state.view;
    if (!target) {
      state.dropVariant = null;
      return;
    }
    if (target === state.view) {
      this.crossTarget = null;
      state.calculateNearestDropVariant(x, y);
      this.drawDropZone();
      return;
    }
    state.dropVariant = null;
    const sourcePath = getViewFilePath(state.view);
    const targetPath = getViewFilePath(target);
    if (
      !sourcePath ||
      !targetPath ||
      sourcePath === targetPath ||
      target.dom.ownerDocument !== state.doc ||
      state.view.state.doc !== state.snapshot
    )
      return;
    const targetEditor = getEditorFromState(target.state);
    if (!targetEditor) return;
    let insertion = 0;
    let indent = "";
    if (target.state.doc.length) {
      if (
        this.crossTarget?.view === target &&
        this.crossTarget.snapshot !== target.state.doc
      )
        return;
      const offset = target.posAtCoords({ x, y });
      if (offset === null) return;
      const root = this.parser.parse(
        targetEditor,
        targetEditor.offsetToPos(offset),
      );
      if (!root) return;
      if (
        this.crossTarget?.view !== target ||
        !isSameRoots(this.crossTarget.root, root)
      ) {
        this.crossTarget = new DragAndDropState(
          target,
          targetEditor,
          root,
          state.list,
        );
      }
      const cross = this.crossTarget;
      if (cross.snapshot !== target.state.doc) return;
      cross.calculateNearestDropVariant(x, y);
      const variant = cross.dropVariant;
      if (!variant) return;
      const list = variant.placeToMove;
      insertion =
        variant.whereToMove === "before"
          ? target.state.doc.line(list.getFirstLineContentStart().line + 1).from
          : target.state.doc.line(
              list.getContentEndIncludingChildren().line + 1,
            ).to;
      // Insert at the next physical line to preserve surrounding line breaks.
      if (
        variant.whereToMove !== "before" &&
        insertion < target.state.doc.length
      )
        insertion++;
      indent =
        list.getFirstLineIndent() +
        (variant.whereToMove === "inside"
          ? this.obisidian.getDefaultIndentChars()
          : "");
      this.drawDropZone(cross);
    } else {
      this.crossTarget = null;
      const rect = target.contentDOM.getBoundingClientRect();
      this.getDocumentContext(state.doc).dropZone.setCssStyles({
        display: "block",
        top: rect.top + "px",
        left: rect.left + "px",
        width: rect.width + "px",
      });
    }
    const from = state.view.state.doc.line(
      state.list.getFirstLineContentStart().line + 1,
    ).from;
    const to = state.view.state.doc.line(
      state.list.getContentEndIncludingChildren().line + 1,
    ).to;
    this.crossDestination = target;
    this.crossMove = new CrossNoteMove(
      state.view,
      target,
      { from, to },
      insertion,
      indent,
      () =>
        state.view.dom.isConnected &&
        target.dom.isConnected &&
        getViewFilePath(state.view) === sourcePath &&
        getViewFilePath(target) === targetPath,
      () =>
        new Notice(
          "Cannot undo or redo this move. Both original editors must remain open and writable. Undo later edits in the other note first.",
          5000,
        ),
    );
  }

  private cancelDragging() {
    this.crossMove = null;
    this.crossDestination = null;
    this.getState().dropVariant = null;
    this.stopDragging();
  }

  private stopDragging() {
    this.unhightlightDraggingLines();
    this.hideDropZone();
    this.applyChanges();
    this.state = null;
    this.crossTarget = null;
    this.crossMove = null;
    this.crossDestination = null;
  }

  private applyChanges() {
    const state = this.getState();
    if (this.crossMove) {
      if (this.crossMove.apply()) {
        const target = this.crossDestination;
        if (target) {
          const editor = target.state.field(editorInfoField, false)?.editor;
          const leaf = this.plugin.app.workspace
            .getLeavesOfType("markdown")
            .find((leaf) => (leaf.view as MarkdownView).editor === editor);
          if (leaf)
            this.plugin.app.workspace.setActiveLeaf(leaf, { focus: true });
          target.focus();
        }
      } else
        new Notice(
          "The item cannot be moved. An editor changed or is unavailable.",
          5000,
        );
      return;
    }
    if (!state.dropVariant) {
      return;
    }

    const { dropVariant, editor, root, list } = state;

    const newRoot = this.parser.parse(editor, root.getContentStart());
    if (!isSameRoots(root, newRoot)) {
      new Notice(
        `The item cannot be moved. The page content changed during the move.`,
        5000,
      );
      return;
    }

    this.operationPerformer.execute(
      root,
      new MoveListToDifferentPosition(
        root,
        list,
        dropVariant.placeToMove,
        dropVariant.whereToMove,
        this.obisidian.getDefaultIndentChars(),
        this.obisidian.isSmartIndentListEnabled(),
      ),
      editor,
    );
  }

  private highlightDraggingLines() {
    const state = this.getState();
    const { list, editor, view } = state;

    const lines = [];
    const fromLine = list.getFirstLineContentStart().line;
    const tillLine = list.getContentEndIncludingChildren().line;
    for (let i = fromLine; i <= tillLine; i++) {
      lines.push(editor.posToOffset({ line: i, ch: 0 }));
    }
    view.dispatch({
      effects: [
        dndStarted.of({
          lines,
          sourceLine: editor.posToOffset({ line: fromLine, ch: 0 }),
        }),
      ],
    });

    state.doc.body.classList.add("bullet-plugin-dragging");
  }

  private notifyInvalidListStructure() {
    new Notice(
      `The item cannot be moved. Fix the invalid list indentation and try again.`,
      5000,
    );
  }

  private unhightlightDraggingLines() {
    const state = this.getState();
    state.doc.body.classList.remove("bullet-plugin-dragging");

    state.view.dispatch({
      effects: [dndEnded.of()],
    });
  }

  private drawDropZone(state = this.getState()) {
    const { view, dropVariant } = state;
    if (!dropVariant) {
      return;
    }

    const { dropZone } = this.getDocumentContext(state.doc);
    const width = Math.round(
      view.contentDOM.offsetWidth - (dropVariant.left - state.leftPadding),
    );

    dropZone.setCssStyles({
      display: "block",
      top: dropVariant.top + DROP_ZONE_VERTICAL_OFFSET_PX + "px",
      left: dropVariant.left + "px",
      width: width + "px",
    });
  }

  private hideDropZone() {
    this.getDocumentContext(this.getState().doc).dropZone.setCssStyles({
      display: "none",
    });
  }

  private getDocumentContext(doc: Document) {
    const context = this.documents.get(doc);
    if (!context) {
      throw new Error(`Missing drag-and-drop document context`);
    }

    return context;
  }

  private getState(): DragAndDropState {
    if (!this.state) {
      throw new Error("Missing drag-and-drop state");
    }

    return this.state;
  }
}

interface DropVariant {
  line: number;
  level: number;
  left: number;
  top: number;
  placeToMove: List;
  whereToMove: "after" | "before" | "inside";
}

interface DragAndDropPreStartState {
  x: number;
  y: number;
  target: Node | null;
  view: EditorView;
  doc: Document;
}

function getDragAndDropLeftPadding(view: {
  dom: Pick<HTMLElement, "querySelector">;
}) {
  const cmLine = view.dom.querySelector("div.cm-line");
  if (isElementLike(cmLine)) {
    return cmLine.getBoundingClientRect().left;
  }

  const scroller = view.dom.querySelector("div.cm-scroller");
  if (isElementLike(scroller)) {
    return (
      scroller.getBoundingClientRect().left +
      Number.parseFloat(getComputedStyleFor(scroller).paddingLeft || "0")
    );
  }

  return 0;
}

function isElementLike(
  value: unknown,
): value is Pick<HTMLElement, "getBoundingClientRect"> {
  return (
    typeof value === "object" &&
    value !== null &&
    "getBoundingClientRect" in value &&
    typeof value.getBoundingClientRect === "function"
  );
}

function getComputedStyleFor(
  element: Element,
): Pick<CSSStyleDeclaration, "paddingLeft"> {
  if (
    typeof window !== "undefined" &&
    typeof window.getComputedStyle === "function"
  ) {
    return window.getComputedStyle(element);
  }

  return { paddingLeft: "0" };
}

class DragAndDropState {
  private dropVariants: Map<string, DropVariant> = new Map();
  public dropVariant: DropVariant | null = null;
  public leftPadding = 0;
  public tabWidth = 0;
  public readonly snapshot;

  constructor(
    public readonly view: EditorView,
    public readonly editor: MyEditor,
    public readonly root: Root,
    public readonly list: List,
    public readonly doc: Document = view.dom.ownerDocument,
  ) {
    this.snapshot = view.state.doc;
    this.collectDropVariants();
    this.calculateLeftPadding();
    this.calculateTabWidth();
  }

  getDropVariants() {
    return Array.from(this.dropVariants.values());
  }

  hasDropVariants() {
    return this.dropVariants.size > 0;
  }

  calculateNearestDropVariant(x: number, y: number) {
    const { view, editor } = this;

    const dropVariants = this.getDropVariants();
    const possibleDropVariants: DropVariant[] = [];

    for (const v of dropVariants) {
      const { placeToMove } = v;

      const positionAfterList =
        v.whereToMove === "after" || v.whereToMove === "inside";
      const line = positionAfterList
        ? placeToMove.getContentEndIncludingChildren().line
        : placeToMove.getFirstLineContentStart().line;
      const linePos = editor.posToOffset({
        line,
        ch: 0,
      });

      const coords = view.coordsAtPos(linePos, -1);

      if (!coords) {
        continue;
      }

      v.left = this.leftPadding + (v.level - 1) * this.tabWidth;
      v.top = coords.top;

      if (positionAfterList) {
        v.top += view.lineBlockAt(linePos).height;
      }

      // Better vertical alignment
      v.top -= 8;

      possibleDropVariants.push(v);
    }

    const nearestLineVariant = possibleDropVariants.sort(
      (a, b) => Math.abs(y - a.top) - Math.abs(y - b.top),
    )[0];
    if (!nearestLineVariant) {
      this.dropVariant = null;
      return;
    }

    const nearestLineTop = nearestLineVariant.top;

    const variansOnNearestLine = possibleDropVariants.filter(
      (v) => Math.abs(v.top - nearestLineTop) <= 4,
    );

    this.dropVariant =
      variansOnNearestLine.sort(
        (a, b) => Math.abs(x - a.left) - Math.abs(x - b.left),
      )[0] ?? null;
  }

  private addDropVariant(v: DropVariant) {
    this.dropVariants.set(`${v.line} ${v.level}`, v);
  }

  private collectDropVariants() {
    const visit = (lists: List[]) => {
      for (const placeToMove of lists) {
        const lineBefore = placeToMove.getFirstLineContentStart().line;
        const lineAfter = placeToMove.getContentEndIncludingChildren().line + 1;

        const level = placeToMove.getLevel();

        this.addDropVariant({
          line: lineBefore,
          level,
          left: 0,
          top: 0,
          placeToMove,
          whereToMove: "before",
        });
        this.addDropVariant({
          line: lineAfter,
          level,
          left: 0,
          top: 0,
          placeToMove,
          whereToMove: "after",
        });

        if (placeToMove === this.list) {
          continue;
        }

        if (placeToMove.isEmpty()) {
          this.addDropVariant({
            line: lineAfter,
            level: level + 1,
            left: 0,
            top: 0,
            placeToMove,
            whereToMove: "inside",
          });
        } else {
          visit(placeToMove.getChildren());
        }
      }
    };

    visit(this.root.getChildren());
  }

  private calculateLeftPadding() {
    this.leftPadding = getDragAndDropLeftPadding(this.view);
  }

  private calculateTabWidth() {
    const { view } = this;

    const indentDom = view.dom.querySelector(".cm-indent");
    if (indentDom) {
      this.tabWidth = (indentDom as HTMLElement).offsetWidth;
      return;
    }

    const singleIndent = indentString(view.state, getIndentUnit(view.state));

    for (let i = 1; i <= view.state.doc.lines; i++) {
      const line = view.state.doc.line(i);

      if (line.text.startsWith(singleIndent)) {
        const a = view.coordsAtPos(line.from, -1);
        if (!a) {
          continue;
        }

        const b = view.coordsAtPos(line.from + singleIndent.length, -1);
        if (!b) {
          continue;
        }

        this.tabWidth = b.left - a.left;
        return;
      }
    }

    this.tabWidth = view.defaultCharacterWidth * getIndentUnit(view.state);
  }
}

interface DraggingLines {
  lines: number[];
  sourceLine: number;
}

const dndStarted = StateEffect.define<DraggingLines>({
  map: ({ lines, sourceLine }, change) => ({
    lines: lines.map((line) => change.mapPos(line)),
    sourceLine: change.mapPos(sourceLine),
  }),
});

const dndEnded = StateEffect.define<void>();

const draggingLineDecoration = Decoration.line({
  class: "bullet-plugin-dragging-line",
});

const draggingSourceLineDecoration = Decoration.line({
  class: "bullet-plugin-dragging-line bullet-plugin-dragging-source-line",
});

const draggingLinesStateField = StateField.define<DecorationSet>({
  create: () => Decoration.none,

  update: (dndState, tr) => {
    dndState = dndState.map(tr.changes);

    for (const e of tr.effects) {
      if (e.is(dndStarted)) {
        dndState = dndState.update({
          add: e.value.lines.map((line) => {
            const decoration =
              line === e.value.sourceLine
                ? draggingSourceLineDecoration
                : draggingLineDecoration;
            return decoration.range(line, line);
          }),
        });
      }

      if (e.is(dndEnded)) {
        dndState = Decoration.none;
      }
    }

    return dndState;
  },

  provide: (f) => EditorView.decorations.from(f),
});

function getEditorViewFromHTMLElement(e: HTMLElement | null) {
  while (e && !e.classList.contains("cm-editor")) {
    e = e.parentElement;
  }

  if (!e) {
    return null;
  }

  return EditorView.findFromDOM(e);
}

function isClickOnBullet(e: MouseEvent) {
  let el = e.target as HTMLElement | null;

  while (el) {
    if (
      el.classList.contains("cm-formatting-list") ||
      el.classList.contains("cm-fold-indicator") ||
      el.classList.contains("task-list-item-checkbox")
    ) {
      return true;
    }

    el = el.parentElement;
  }

  return false;
}

function isSameRoots(a: Root, b: Root | null) {
  if (!b) {
    return false;
  }

  const [aStart, aEnd] = a.getContentRange();
  const [bStart, bEnd] = b.getContentRange();

  if (cmpPos(aStart, bStart) !== 0 || cmpPos(aEnd, bEnd) !== 0) {
    return false;
  }

  return a.print() === b.print();
}

function isFeatureSupported() {
  return Platform.isDesktop;
}

function hasMovedEnoughToStartDragging(
  start: DragAndDropPreStartState,
  current: Pick<MouseEvent, "x" | "y">,
) {
  return (
    Math.hypot(current.x - start.x, current.y - start.y) >=
    DRAG_START_DISTANCE_PX
  );
}

function getDragStartOffset(
  view: EditorView,
  target: Node | null,
  x: number,
  y: number,
) {
  if (target) {
    try {
      return view.posAtDOM(target, 0);
    } catch {
      // Fall back to coordinates when CodeMirror cannot map the clicked token.
    }
  }

  return view.posAtCoords({ x, y });
}

function getEventDocument(e: Event) {
  const target = e.target;
  if (target instanceof Node && target.ownerDocument) {
    return target.ownerDocument;
  }

  return activeDocument;
}

function getViewFilePath(view: EditorView): string | undefined {
  return view.state.field(editorInfoField, false)?.file?.path;
}
