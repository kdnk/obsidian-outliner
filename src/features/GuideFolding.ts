import {
  foldEffect,
  foldable,
  foldedRanges,
  unfoldEffect,
} from "@codemirror/language";
import { Extension, Range, Text } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  PluginValue,
  ViewUpdate,
  WidgetType,
  scrollPastEnd,
} from "@codemirror/view";

import {
  ensureFoldScrollReserve,
  stableFoldScrollSnapshot,
} from "./FoldScroll";

import { MyEditorPosition, getEditorFromState } from "../editor";
import { getObsidianDomWindow } from "../obsidianDom";
import { List, Root } from "../root";
import { Parser, Reader } from "../services/Parser";
import { Settings } from "../services/Settings";

const INDENT_GUIDE_SELECTOR = ".cm-indent";
const INDENT_CONTAINER_SELECTOR = ".cm-hmd-list-indent";
const LINE_INDENT_GUIDE_SELECTOR = ".cm-hmd-list-indent > .cm-indent";
const LINE_SELECTOR = ".cm-line";
const LIVE_PREVIEW_EDITOR_SELECTOR =
  ".markdown-source-view.mod-cm6.is-live-preview";
const PERSISTENT_GUIDE_MARKER = "bullet-plugin-persistent-indent-guide";
const PERSISTENT_GUIDE_SELECTOR = `.${PERSISTENT_GUIDE_MARKER}`;
const PERSISTENT_GUIDE_CANDIDATE_SELECTOR =
  ".cm-hmd-list-indent > .cm-indent-spacing:not(.cm-indent)";
const HOVERED_GUIDE_MARKER = "bullet-plugin-hovered-indent-guide";
const HOVERED_GUIDE_SELECTOR = `.${HOVERED_GUIDE_MARKER}`;
const HOVERED_GUIDE_START_MARKER = "bullet-plugin-hovered-indent-guide-start";
const HOVERED_GUIDE_START_SELECTOR = `.${HOVERED_GUIDE_START_MARKER}`;
const HOVERED_GUIDE_END_MARKER = "bullet-plugin-hovered-indent-guide-end";
const HOVERED_GUIDE_END_SELECTOR = `.${HOVERED_GUIDE_END_MARKER}`;
const SELECTED_GUIDE_MARKER = "bullet-plugin-selected-indent-guide";
const SELECTED_GUIDE_SELECTOR = `.${SELECTED_GUIDE_MARKER}`;
const SELECTED_GUIDE_START_MARKER = "bullet-plugin-selected-indent-guide-start";
const SELECTED_GUIDE_START_SELECTOR = `.${SELECTED_GUIDE_START_MARKER}`;
const SELECTED_GUIDE_END_MARKER = "bullet-plugin-selected-indent-guide-end";
const SELECTED_GUIDE_END_SELECTOR = `.${SELECTED_GUIDE_END_MARKER}`;
const HOVERED_GUIDE_CANDIDATE_SELECTOR =
  `${INDENT_GUIDE_SELECTOR}:hover, ` +
  ".cm-hmd-list-indent > .cm-indent-spacing:hover";
const RENDERED_GUIDE_CANDIDATE_SELECTOR =
  ".cm-hmd-list-indent > .cm-indent, " +
  ".cm-hmd-list-indent > .cm-indent-spacing";
const OUTER_LIST_GUIDE_CLASS = "bullet-plugin-outer-list-guide";
const OUTER_LIST_GUIDE_SELECTOR = `.${OUTER_LIST_GUIDE_CLASS}`;
const HOVERED_OUTER_LIST_GUIDE_CLASS = "bullet-plugin-hovered-outer-list-guide";
const HOVERED_OUTER_LIST_GUIDE_SELECTOR = `.${HOVERED_OUTER_LIST_GUIDE_CLASS}`;
const HOVERED_OUTER_LIST_GUIDE_START_CLASS =
  "bullet-plugin-hovered-outer-list-guide-start";
const HOVERED_OUTER_LIST_GUIDE_START_SELECTOR = `.${HOVERED_OUTER_LIST_GUIDE_START_CLASS}`;
const HOVERED_OUTER_LIST_GUIDE_END_CLASS =
  "bullet-plugin-hovered-outer-list-guide-end";
const HOVERED_OUTER_LIST_GUIDE_END_SELECTOR = `.${HOVERED_OUTER_LIST_GUIDE_END_CLASS}`;
const SELECTED_OUTER_LIST_GUIDE_CLASS =
  "bullet-plugin-selected-outer-list-guide";
const SELECTED_OUTER_LIST_GUIDE_SELECTOR = `.${SELECTED_OUTER_LIST_GUIDE_CLASS}`;
const SELECTED_OUTER_LIST_GUIDE_START_CLASS =
  "bullet-plugin-selected-outer-list-guide-start";
const SELECTED_OUTER_LIST_GUIDE_START_SELECTOR = `.${SELECTED_OUTER_LIST_GUIDE_START_CLASS}`;
const SELECTED_OUTER_LIST_GUIDE_END_CLASS =
  "bullet-plugin-selected-outer-list-guide-end";
const SELECTED_OUTER_LIST_GUIDE_END_SELECTOR = `.${SELECTED_OUTER_LIST_GUIDE_END_CLASS}`;
const CHUNK_LINE_ATTRIBUTE_RE = /^(0|[1-9]\d*)$/;

export const GUIDE_FOLDING_SCROLL_PAST_END_EXTENSION: Extension =
  scrollPastEnd();

type GuideMeasurement = {
  indentGuides: Element[];
  outerGuides: Element[];
  selection: {
    key: SelectedGuide | null;
    valid: boolean;
    indentGuides: Element[];
    outerGuides: Element[];
  };
};

type SelectedGuide =
  | { kind: "indent"; targetStart: MyEditorPosition }
  | { kind: "outer"; chunkId: string };

interface OuterListChunk {
  root: Root;
  startLine: number;
  endLine: number;
  id: string;
  actionable: boolean;
}

interface GuideFoldTarget {
  line: number;
  fallbackCursor: MyEditorPosition;
}

class OuterListGuideWidget extends WidgetType {
  constructor(
    private chunk: Pick<
      OuterListChunk,
      "id" | "startLine" | "endLine" | "actionable"
    >,
  ) {
    super();
  }

  eq(other: WidgetType) {
    return (
      other instanceof OuterListGuideWidget &&
      this.chunk.id === other.chunk.id &&
      this.chunk.actionable === other.chunk.actionable
    );
  }

  toDOM(view: EditorView) {
    const element = getObsidianDomWindow(view.dom.ownerDocument).createSpan();
    element.className = OUTER_LIST_GUIDE_CLASS;
    element.dataset.chunkId = this.chunk.id;
    element.dataset.chunkStart = String(this.chunk.startLine);
    element.dataset.chunkEnd = String(this.chunk.endLine);
    element.dataset.actionable = String(this.chunk.actionable);
    element.setAttribute("aria-hidden", "true");
    return element;
  }

  ignoreEvent() {
    return false;
  }
}

function collectHoveredOuterListGuides(contentDOM: ParentNode) {
  const hovered = contentDOM.querySelector<HTMLElement>(
    `${OUTER_LIST_GUIDE_SELECTOR}[data-actionable="true"]:hover`,
  );
  const chunkId = hovered?.dataset.chunkId;
  if (hovered?.dataset.actionable !== "true" || !chunkId) return [];

  return Array.from(
    contentDOM.querySelectorAll<HTMLElement>(OUTER_LIST_GUIDE_SELECTOR),
  ).filter((element) => element.dataset.chunkId === chunkId);
}

function synchronizeHoveredOuterListGuides(
  contentDOM: ParentNode,
  guides: Iterable<Element>,
) {
  synchronizeGuideMarkers(
    contentDOM,
    guides,
    HOVERED_OUTER_LIST_GUIDE_CLASS,
    HOVERED_OUTER_LIST_GUIDE_SELECTOR,
    HOVERED_OUTER_LIST_GUIDE_START_CLASS,
    HOVERED_OUTER_LIST_GUIDE_START_SELECTOR,
    HOVERED_OUTER_LIST_GUIDE_END_CLASS,
    HOVERED_OUTER_LIST_GUIDE_END_SELECTOR,
  );
}

function synchronizeGuideMarkers(
  contentDOM: ParentNode,
  guides: Iterable<Element>,
  marker: string,
  markerSelector: string,
  startMarker: string,
  startSelector: string,
  endMarker: string,
  endSelector: string,
): void {
  const ordered = Array.from(guides);
  const next = new Set(ordered);

  for (const element of Array.from(
    contentDOM.querySelectorAll(startSelector),
  )) {
    element.classList.remove(startMarker);
  }
  for (const element of Array.from(contentDOM.querySelectorAll(endSelector))) {
    element.classList.remove(endMarker);
  }
  for (const element of Array.from(
    contentDOM.querySelectorAll(markerSelector),
  )) {
    if (!next.has(element)) {
      element.classList.remove(marker);
    }
  }
  for (const element of ordered) {
    element.classList.add(marker);
  }
  ordered[0]?.classList.add(startMarker);
  ordered[ordered.length - 1]?.classList.add(endMarker);
}

function buildOuterListGuideDecorations(
  doc: Text,
  chunks: readonly OuterListChunk[],
) {
  const ranges: Range<Decoration>[] = [];
  for (const chunk of chunks) {
    for (let line = chunk.startLine; line <= chunk.endLine; line++) {
      ranges.push(
        Decoration.widget({
          widget: new OuterListGuideWidget(chunk),
          side: -1,
        }).range(doc.line(line + 1).from),
      );
    }
  }
  return Decoration.set(ranges, true);
}

function collectOuterListChunks(
  parser: Parser,
  editor: Reader,
): OuterListChunk[] {
  const roots: Root[] = [];
  let segmentStart = 0;
  let notesIndent: string | null = null;

  const appendSegment = (segmentEnd: number) => {
    if (segmentStart <= segmentEnd) {
      roots.push(...parser.parseRange(editor, segmentStart, segmentEnd));
    }
  };

  for (let line = 0; line <= editor.lastLine(); line++) {
    const text = editor.getLine(line);
    if (text.trim().length > 0) {
      if (parser.isListItem(text)) {
        notesIndent = null;
      } else if (notesIndent === null) {
        notesIndent = text.match(/^[ \t]*/)?.[0] ?? "";
      }
      continue;
    }
    // Indented paragraph gaps belong to the item's continuation text.
    if (
      text.length > 0 &&
      notesIndent !== null &&
      notesIndent.length > 0 &&
      text.startsWith(notesIndent)
    )
      continue;
    appendSegment(line - 1);
    segmentStart = line + 1;
    notesIndent = null;
  }
  appendSegment(editor.lastLine());

  return roots.map((root) => {
    const startLine = root.getContentStart().line;
    const endLine = root.getContentEnd().line;
    return {
      root,
      startLine,
      endLine,
      id: `${startLine}:${endLine}`,
      actionable: isOuterListChunkActionable(root),
    };
  });
}

function isFoldableTopLevelList(list: List) {
  return list.getLineCount() > 1 || !list.isEmpty();
}

function isOuterListChunkActionable(root: Root) {
  return root.getChildren().some(isFoldableTopLevelList);
}

function foldInside(view: EditorView, from: number, to: number) {
  let found: { from: number; to: number } | null = null;
  foldedRanges(view.state).between(from, to, (from, to) => {
    if (!found || found.from > from) found = { from, to };
  });
  return found;
}

function setGuideTargetsFolded(
  view: EditorView,
  targets: readonly GuideFoldTarget[],
  folded: boolean,
): boolean {
  const resolved: Array<{
    range: { from: number; to: number };
    target: GuideFoldTarget;
  }> = [];
  for (const target of targets) {
    const line = view.lineBlockAt(view.state.doc.line(target.line + 1).from);
    const range = folded
      ? foldable(view.state, line.from, line.to)
      : foldInside(view, line.from, line.to);

    if (range && range.from !== range.to) {
      resolved.push({ range, target });
    }
  }

  if (resolved.length === 0) {
    return false;
  }

  ensureFoldScrollReserve(view);
  const effects = [
    stableFoldScrollSnapshot(view),
    ...resolved.map(({ range }) =>
      (folded ? foldEffect : unfoldEffect).of(range),
    ),
  ];
  const selectionHead = view.state.selection.main.head;
  const selectedTarget = folded
    ? resolved.find(
        ({ range }) => range.from < selectionHead && selectionHead < range.to,
      )
    : undefined;

  if (selectedTarget) {
    const fallbackCursor = selectedTarget.target.fallbackCursor;
    const fallbackLine = view.state.doc.line(fallbackCursor.line + 1);
    const fallbackOffset = Math.min(
      fallbackLine.from + fallbackCursor.ch,
      fallbackLine.to,
    );
    view.dispatch({
      selection: { anchor: fallbackOffset, head: fallbackOffset },
      effects,
    });
  } else {
    view.dispatch({ effects });
  }

  return true;
}

function toggleOuterListChunk(view: EditorView, root: Root) {
  const targets = root.getChildren().filter(isFoldableTopLevelList);
  if (targets.length === 0) return false;

  const shouldUnfold = targets.every((target) => target.isFolded());
  return setGuideTargetsFolded(
    view,
    targets.map((target) => {
      const fallbackCursor = target.getFirstLineContentStart();
      return { line: fallbackCursor.line, fallbackCursor };
    }),
    !shouldUnfold,
  );
}

function synchronizePersistentIndentGuides(
  contentDOM: ParentNode,
  enabled: boolean,
) {
  if (enabled) {
    for (const element of Array.from(
      contentDOM.querySelectorAll(PERSISTENT_GUIDE_CANDIDATE_SELECTOR),
    )) {
      element.classList.add("cm-indent", PERSISTENT_GUIDE_MARKER);
    }
    return;
  }

  for (const element of Array.from(
    contentDOM.querySelectorAll(PERSISTENT_GUIDE_SELECTOR),
  )) {
    element.classList.remove("cm-indent", PERSISTENT_GUIDE_MARKER);
  }
}

function getGuideIndentPrefix(pressedGuide: Element): string | null {
  const indentContainer = pressedGuide.parentElement;
  if (!indentContainer?.matches(INDENT_CONTAINER_SELECTOR)) {
    return null;
  }

  let prefix = "";
  for (const child of Array.from(indentContainer.childNodes)) {
    if (child === pressedGuide) {
      return prefix;
    }
    prefix += child.textContent ?? "";
  }

  return null;
}

function resolveVerticalGuideTarget(
  list: List,
  pressedGuide: Element,
): List | null {
  const indentPrefix = getGuideIndentPrefix(pressedGuide);
  if (indentPrefix === null) {
    return null;
  }

  let ancestor = list.getParent();
  while (ancestor?.getParent()) {
    if (ancestor.getFirstLineIndent() === indentPrefix) {
      return ancestor;
    }
    ancestor = ancestor.getParent();
  }

  return null;
}

function hasSameListStart(left: List, right: List | MyEditorPosition) {
  const leftStart = left.getFirstLineContentStart();
  const rightStart =
    right instanceof List ? right.getFirstLineContentStart() : right;
  return leftStart.line === rightStart.line && leftStart.ch === rightStart.ch;
}

function collectVerticalGuideGroup(
  hoveredGuide: Element,
  guides: Iterable<Element>,
  getListForGuide: (guide: Element) => List | null,
): Element[] {
  const hoveredList = getListForGuide(hoveredGuide);
  const hoveredTarget = hoveredList
    ? resolveVerticalGuideTarget(hoveredList, hoveredGuide)
    : null;
  if (!hoveredTarget) {
    return [];
  }

  return Array.from(guides).filter((guide) => {
    const list = getListForGuide(guide);
    const target = list ? resolveVerticalGuideTarget(list, guide) : null;
    return target ? hasSameListStart(target, hoveredTarget) : false;
  });
}

function synchronizeHoveredIndentGuides(
  contentDOM: ParentNode,
  highlightedGuides: Iterable<Element>,
) {
  synchronizeGuideMarkers(
    contentDOM,
    highlightedGuides,
    HOVERED_GUIDE_MARKER,
    HOVERED_GUIDE_SELECTOR,
    HOVERED_GUIDE_START_MARKER,
    HOVERED_GUIDE_START_SELECTOR,
    HOVERED_GUIDE_END_MARKER,
    HOVERED_GUIDE_END_SELECTOR,
  );
}

function synchronizeSelectedIndentGuides(
  contentDOM: ParentNode,
  highlightedGuides: Iterable<Element>,
): void {
  synchronizeGuideMarkers(
    contentDOM,
    highlightedGuides,
    SELECTED_GUIDE_MARKER,
    SELECTED_GUIDE_SELECTOR,
    SELECTED_GUIDE_START_MARKER,
    SELECTED_GUIDE_START_SELECTOR,
    SELECTED_GUIDE_END_MARKER,
    SELECTED_GUIDE_END_SELECTOR,
  );
}

function synchronizeSelectedOuterListGuides(
  contentDOM: ParentNode,
  guides: Iterable<Element>,
): void {
  synchronizeGuideMarkers(
    contentDOM,
    guides,
    SELECTED_OUTER_LIST_GUIDE_CLASS,
    SELECTED_OUTER_LIST_GUIDE_SELECTOR,
    SELECTED_OUTER_LIST_GUIDE_START_CLASS,
    SELECTED_OUTER_LIST_GUIDE_START_SELECTOR,
    SELECTED_OUTER_LIST_GUIDE_END_CLASS,
    SELECTED_OUTER_LIST_GUIDE_END_SELECTOR,
  );
}

function toggleVerticalGuideTarget(view: EditorView, list: List) {
  const children = list.getChildren().filter((child) => !child.isEmpty());
  if (children.length === 0) {
    return false;
  }

  const shouldUnfold = children.every((child) => child.isFolded());
  return setGuideTargetsFolded(
    view,
    children.map((child) => {
      const fallbackCursor = child.getFirstLineContentStart();
      return { line: fallbackCursor.line, fallbackCursor };
    }),
    !shouldUnfold,
  );
}

function isVerticalGuideTargetActionable(list: List) {
  return list.getChildren().some((child) => !child.isEmpty());
}

export class GuideFoldingPluginValue implements PluginValue {
  decorations: DecorationSet;

  private destroyed = false;
  private lastOuterVisibility: boolean;
  private lastPointerGuide: Element | null = null;
  private selectedGuide: SelectedGuide | null = null;
  private outerListChunks: readonly OuterListChunk[] | null = null;
  private activeDocument: Document | null;
  private measureKey = {};

  constructor(
    private settings: Settings,
    private parser: Parser,
    private view: EditorView,
  ) {
    this.lastOuterVisibility = this.outerVisibility();
    this.activeDocument = this.view.contentDOM.ownerDocument ?? null;
    this.decorations = this.buildOuterDecorations();
    this.view.contentDOM.addEventListener("mousedown", this.onMouseDown, true);
    this.view.contentDOM.addEventListener("click", this.onClick, true);
    this.activeDocument?.addEventListener("click", this.onDocumentClick, true);
    this.view.contentDOM.addEventListener(
      "pointermove",
      this.onPointerMove,
      true,
    );
    this.view.contentDOM.addEventListener(
      "pointerleave",
      this.onPointerLeave,
      true,
    );
    this.settings.onChange(
      ["outerListLines", "listLineAction"],
      this.onSettingsChange,
    );
    this.scheduleGuideSynchronization();
  }

  update(update: ViewUpdate) {
    if (update.docChanged) {
      this.selectedGuide = null;
      this.outerListChunks = null;
      this.decorations = this.buildOuterDecorations();
    }
    this.scheduleGuideSynchronization();
  }

  private handleMouseDown(event: MouseEvent) {
    return this.handleGuideInteraction(event, false);
  }

  private handleClick(event: MouseEvent) {
    return this.handleGuideInteraction(event, true);
  }

  private handleGuideInteraction(event: MouseEvent, shouldToggle: boolean) {
    const pressedTarget = event.target;
    if (!isElementLike(pressedTarget)) {
      return false;
    }

    if (pressedTarget.matches(OUTER_LIST_GUIDE_SELECTOR)) {
      if (!this.settings.outerVerticalLines) {
        return false;
      }
      const startAttribute = pressedTarget.getAttribute("data-chunk-start");
      const endAttribute = pressedTarget.getAttribute("data-chunk-end");
      if (
        startAttribute === null ||
        endAttribute === null ||
        !CHUNK_LINE_ATTRIBUTE_RE.test(startAttribute) ||
        !CHUNK_LINE_ATTRIBUTE_RE.test(endAttribute)
      ) {
        return false;
      }
      const startLine = Number(startAttribute);
      const endLine = Number(endAttribute);
      const editor = getEditorFromState(this.view.state);
      if (!editor) {
        return false;
      }
      if (
        !Number.isInteger(startLine) ||
        !Number.isInteger(endLine) ||
        startLine < 0 ||
        endLine < startLine ||
        endLine > editor.lastLine()
      ) {
        return false;
      }
      const chunkId = `${startLine}:${endLine}`;
      if (
        this.outerListChunks !== null &&
        !this.outerListChunks.some((chunk) => chunk.id === chunkId)
      ) {
        return false;
      }
      if (shouldToggle) {
        this.selectedGuide = {
          kind: "outer",
          chunkId,
        };
        this.scheduleGuideSynchronization();
      }
      if (
        !shouldToggle ||
        !this.interactionEnabled() ||
        pressedTarget.getAttribute("data-actionable") !== "true"
      ) {
        event.preventDefault();
        return true;
      }
      const roots = this.parser.parseRange(editor, startLine, endLine) ?? [];
      if (roots.length !== 1) {
        event.preventDefault();
        return true;
      }
      const root = roots[0];
      if (
        !root ||
        root.getContentStart().line !== startLine ||
        root.getContentEnd().line !== endLine
      ) {
        event.preventDefault();
        return true;
      }
      if (isOuterListChunkActionable(root)) {
        toggleOuterListChunk(this.view, root);
      }
      event.preventDefault();
      return true;
    }

    const pressedGuide = pressedTarget.matches(INDENT_GUIDE_SELECTOR)
      ? pressedTarget
      : this.resolveMobileIndentGuide(pressedTarget, event.clientX);
    if (!pressedGuide) {
      return false;
    }

    const lineElement = pressedGuide.closest(LINE_SELECTOR);
    if (!lineElement) {
      return false;
    }

    const editor = getEditorFromState(this.view.state);
    if (!editor) {
      return false;
    }

    let offset: number;
    try {
      offset = this.view.posAtDOM(lineElement);
    } catch {
      return false;
    }

    const line = this.view.state.doc.lineAt(offset).number - 1;
    const root = this.parser.parse(editor, { line, ch: 0 });
    const list = root?.getListUnderLine(line);
    if (!list) {
      return false;
    }

    const target = resolveVerticalGuideTarget(list, pressedGuide);
    if (!target) {
      return false;
    }

    if (shouldToggle) {
      this.selectedGuide = {
        kind: "indent",
        targetStart: target.getFirstLineContentStart(),
      };
      this.scheduleGuideSynchronization();
      if (
        this.interactionEnabled() &&
        isVerticalGuideTargetActionable(target)
      ) {
        toggleVerticalGuideTarget(this.view, target);
      }
    }

    event.preventDefault();
    return true;
  }

  private resolveMobileIndentGuide(target: Element, clientX: number) {
    if (
      !this.interactionEnabled() ||
      !target.matches(LINE_SELECTOR) ||
      !Number.isFinite(clientX)
    ) {
      return null;
    }

    if (
      !target.ownerDocument.body.classList.contains("is-mobile") ||
      !target.closest(LIVE_PREVIEW_EDITOR_SELECTOR)
    ) {
      return null;
    }

    return (
      Array.from(target.querySelectorAll(LINE_INDENT_GUIDE_SELECTOR)).find(
        (guide) => {
          const rect = guide.getBoundingClientRect();
          return rect.left <= clientX && clientX < rect.right;
        },
      ) ?? null
    );
  }

  destroy() {
    this.destroyed = true;
    this.view.contentDOM.removeEventListener(
      "mousedown",
      this.onMouseDown,
      true,
    );
    this.view.contentDOM.removeEventListener("click", this.onClick, true);
    this.activeDocument?.removeEventListener(
      "click",
      this.onDocumentClick,
      true,
    );
    this.view.contentDOM.removeEventListener(
      "pointermove",
      this.onPointerMove,
      true,
    );
    this.view.contentDOM.removeEventListener(
      "pointerleave",
      this.onPointerLeave,
      true,
    );
    this.settings.removeCallback(this.onSettingsChange);
    synchronizeHoveredIndentGuides(this.view.contentDOM, []);
    synchronizeHoveredOuterListGuides(this.view.contentDOM, []);
    synchronizeSelectedIndentGuides(this.view.contentDOM, []);
    synchronizeSelectedOuterListGuides(this.view.contentDOM, []);
    synchronizePersistentIndentGuides(this.view.contentDOM, false);
  }

  private onMouseDown = (event: MouseEvent) => {
    if (this.handleMouseDown(event)) {
      event.stopPropagation();
    }
  };

  private onClick = (event: MouseEvent) => {
    if (this.handleClick(event)) {
      event.stopPropagation();
    }
  };

  private onDocumentClick = (event: MouseEvent) => {
    const target = event.target;
    if (
      isElementLike(target) &&
      this.view.contentDOM.contains(target) &&
      (target.matches(INDENT_GUIDE_SELECTOR) ||
        target.matches(OUTER_LIST_GUIDE_SELECTOR))
    ) {
      return;
    }
    if (!this.selectedGuide) {
      return;
    }
    this.selectedGuide = null;
    this.scheduleGuideSynchronization();
  };

  private interactionEnabled() {
    return this.settings.verticalLinesAction === "toggle-folding";
  }

  private outerInteractionEnabled() {
    return this.interactionEnabled() && this.settings.outerVerticalLines;
  }

  private getLineForGuide(guide: Element): number | null {
    const lineElement = guide.closest(LINE_SELECTOR);
    if (!lineElement) {
      return null;
    }
    try {
      const offset = this.view.posAtDOM(lineElement);
      return this.view.state.doc.lineAt(offset).number - 1;
    } catch {
      return null;
    }
  }

  private getListForGuide(root: Root, guide: Element) {
    const line = this.getLineForGuide(guide);
    return line === null ? null : root.getListUnderLine(line);
  }

  private readHoveredIndentGuideGroup(): Element[] {
    if (!this.interactionEnabled()) return [];
    const hoveredGuide = this.view.contentDOM.querySelector(
      HOVERED_GUIDE_CANDIDATE_SELECTOR,
    );
    if (!hoveredGuide) {
      return [];
    }
    const hoveredLine = this.getLineForGuide(hoveredGuide);
    const editor = getEditorFromState(this.view.state);
    if (hoveredLine === null || !editor) {
      return [];
    }
    const root = this.parser.parse(editor, { line: hoveredLine, ch: 0 });
    if (!root) {
      return [];
    }
    return collectVerticalGuideGroup(
      hoveredGuide,
      Array.from(
        this.view.contentDOM.querySelectorAll(
          RENDERED_GUIDE_CANDIDATE_SELECTOR,
        ),
      ),
      (guide) => this.getListForGuide(root, guide),
    );
  }

  private readSelectedGuideMeasurement(): GuideMeasurement["selection"] {
    const key = this.selectedGuide;
    if (!key) {
      return { key, valid: true, indentGuides: [], outerGuides: [] };
    }
    if (key.kind === "outer") {
      const valid =
        this.outerListChunks === null ||
        this.outerListChunks.some((chunk) => chunk.id === key.chunkId);
      return {
        key,
        valid,
        indentGuides: [],
        outerGuides: valid
          ? Array.from(
              this.view.contentDOM.querySelectorAll<HTMLElement>(
                OUTER_LIST_GUIDE_SELECTOR,
              ),
            ).filter((guide) => guide.dataset.chunkId === key.chunkId)
          : [],
      };
    }

    const { targetStart } = key;
    const editor = getEditorFromState(this.view.state);
    if (!editor) {
      return { key, valid: true, indentGuides: [], outerGuides: [] };
    }
    const root = this.parser.parse(editor, targetStart);
    const selectedList = root?.getListUnderLine(targetStart.line);
    if (
      !root ||
      !selectedList ||
      !hasSameListStart(selectedList, targetStart)
    ) {
      return { key, valid: false, indentGuides: [], outerGuides: [] };
    }

    const indentGuides = Array.from(
      this.view.contentDOM.querySelectorAll(RENDERED_GUIDE_CANDIDATE_SELECTOR),
    ).filter((guide) => {
      const list = this.getListForGuide(root, guide);
      const target = list ? resolveVerticalGuideTarget(list, guide) : null;
      return target ? hasSameListStart(target, targetStart) : false;
    });
    return { key, valid: true, indentGuides, outerGuides: [] };
  }

  private readGuideMeasurement(): GuideMeasurement {
    return {
      indentGuides: this.readHoveredIndentGuideGroup(),
      outerGuides: this.outerInteractionEnabled()
        ? collectHoveredOuterListGuides(this.view.contentDOM)
        : [],
      selection: this.readSelectedGuideMeasurement(),
    };
  }

  private onPointerMove = (event: PointerEvent) => {
    const guide =
      isElementLike(event.target) &&
      (event.target.matches(INDENT_GUIDE_SELECTOR) ||
        (event.target.matches(OUTER_LIST_GUIDE_SELECTOR) &&
          event.target.getAttribute("data-actionable") === "true"))
        ? event.target
        : null;
    if (!guide) {
      this.lastPointerGuide = null;
      synchronizeHoveredIndentGuides(this.view.contentDOM, []);
      synchronizeHoveredOuterListGuides(this.view.contentDOM, []);
      return;
    }
    if (guide === this.lastPointerGuide) return;
    this.lastPointerGuide = guide;
    this.scheduleGuideSynchronization();
  };

  private onPointerLeave = () => {
    this.lastPointerGuide = null;
    synchronizeHoveredIndentGuides(this.view.contentDOM, []);
    synchronizeHoveredOuterListGuides(this.view.contentDOM, []);
  };

  private onSettingsChange = () => {
    const outerVisibility = this.outerVisibility();
    if (outerVisibility !== this.lastOuterVisibility) {
      this.lastOuterVisibility = outerVisibility;
      this.decorations = this.buildOuterDecorations();
      this.view.dispatch({});
    }
    if (!this.interactionEnabled()) {
      this.lastPointerGuide = null;
      synchronizeHoveredIndentGuides(this.view.contentDOM, []);
    }
    if (!this.outerInteractionEnabled()) {
      synchronizeHoveredOuterListGuides(this.view.contentDOM, []);
    }
    this.scheduleGuideSynchronization();
  };

  private outerVisibility() {
    return this.settings.outerVerticalLines;
  }

  private buildOuterDecorations() {
    if (!this.settings.outerVerticalLines) {
      return Decoration.none;
    }
    const editor = getEditorFromState(this.view.state);
    if (!editor) {
      return Decoration.none;
    }
    const chunks = collectOuterListChunks(this.parser, editor);
    this.outerListChunks = chunks;
    return buildOuterListGuideDecorations(this.view.state.doc, chunks);
  }

  private scheduleGuideSynchronization() {
    if (this.destroyed) {
      return;
    }

    this.view.requestMeasure({
      key: this.measureKey,
      read: () => this.readGuideMeasurement(),
      write: (measurement: GuideMeasurement) => {
        if (this.destroyed) {
          return;
        }

        synchronizePersistentIndentGuides(
          this.view.contentDOM,
          this.interactionEnabled(),
        );
        synchronizeHoveredIndentGuides(
          this.view.contentDOM,
          this.interactionEnabled() ? (measurement?.indentGuides ?? []) : [],
        );
        synchronizeHoveredOuterListGuides(
          this.view.contentDOM,
          this.outerInteractionEnabled()
            ? (measurement?.outerGuides ?? [])
            : [],
        );
        const measuredSelection = measurement?.selection;
        if (measuredSelection?.key === this.selectedGuide) {
          if (!measuredSelection.valid) {
            this.selectedGuide = null;
            synchronizeSelectedIndentGuides(this.view.contentDOM, []);
            synchronizeSelectedOuterListGuides(this.view.contentDOM, []);
          } else {
            synchronizeSelectedIndentGuides(
              this.view.contentDOM,
              measuredSelection.indentGuides,
            );
            synchronizeSelectedOuterListGuides(
              this.view.contentDOM,
              measuredSelection.outerGuides,
            );
          }
        }
      },
    });
  }
}

function isElementLike(value: EventTarget | null): value is Element {
  if (!value || typeof value !== "object") {
    return false;
  }

  const element = value as Partial<Element>;
  return (
    typeof element.matches === "function" &&
    typeof element.closest === "function"
  );
}
