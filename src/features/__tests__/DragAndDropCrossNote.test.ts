import { editorInfoField } from "obsidian";

import { history, redo, undo } from "@codemirror/commands";
import {
  EditorState,
  StateField,
  Transaction,
  TransactionSpec,
} from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { Parser } from "../../services/Parser";
import { coordinateCrossNoteHistory, crossNoteHistory } from "../CrossNoteMove";
import { DragAndDrop } from "../DragAndDrop";

jest.mock(
  "obsidian",
  () => ({
    editorInfoField: jest
      .requireActual<typeof import("@codemirror/state")>("@codemirror/state")
      .StateField.define({ create: () => null, update: (v: unknown) => v }),
    Notice: class {},
    Platform: { isDesktop: true },
  }),
  { virtual: true },
);
jest.mock(
  "../../editor",
  () => ({
    getEditorFromState: (state: EditorState) =>
      state.field(
        jest.requireMock<{ editorInfoField: StateField<{ editor: unknown }> }>(
          "obsidian",
        ).editorInfoField,
      ).editor,
  }),
  { virtual: true },
);

function setup(targetText: string) {
  const doc = {
    body: { classList: { add() {}, remove() {} } },
    elementFromPoint: (): unknown => target.dom,
  };
  function makeView(text: string, path: string, left: number) {
    const reader = {
      getCursor: () => ({ line: 0, ch: 0 }),
      getLine: (line: number) => view.state.doc.line(line + 1).text,
      lastLine: () => view.state.doc.lines - 1,
      listSelections: () => [
        { anchor: { line: 0, ch: 0 }, head: { line: 0, ch: 0 } },
      ],
      getAllFoldedLines: () => [],
      posToOffset: ({ line, ch }: { line: number; ch: number }) =>
        view.state.doc.line(line + 1).from + ch,
      offsetToPos: (offset: number) => {
        const line = view.state.doc.lineAt(offset);
        return { line: line.number - 1, ch: offset - line.from };
      },
    };
    const view = {
      state: EditorState.create({
        doc: text,
        extensions: [
          history(),
          crossNoteHistory,
          (editorInfoField as StateField<unknown>).init(() => ({
            file: { path },
            editor: reader,
          })),
        ],
      }),
      dom: {
        isConnected: true,
        ownerDocument: doc,
        classList: { contains: (name: string) => name === "cm-editor" },
        querySelector: (selector: string) =>
          selector === ".cm-indent"
            ? { offsetWidth: 16 }
            : { getBoundingClientRect: () => ({ left }) },
      },
      contentDOM: {
        offsetWidth: 400,
        getBoundingClientRect: () => ({ left, top: 0, width: 400 }),
      },
      focus: jest.fn(),
      defaultCharacterWidth: 4,
      posAtCoords: ({ y }: { y: number }) =>
        view.state.doc.line(
          Math.max(1, Math.min(view.state.doc.lines, Math.floor(y / 20) + 1)),
        ).from,
      coordsAtPos: (pos: number) => ({
        left,
        top: (view.state.doc.lineAt(pos).number - 1) * 20,
      }),
      lineBlockAt: () => ({ height: 20 }),
      dispatch(tr: Transaction | TransactionSpec) {
        this.state =
          tr instanceof Transaction ? tr.state : this.state.update(tr).state;
      },
    };
    coordinateCrossNoteHistory(view);
    return view;
  }
  const source = makeView("- move\n\t- child\n- keep", "source.md", 0);
  const target = makeView(targetText, "target.md", 500);
  jest
    .spyOn(EditorView, "findFromDOM")
    .mockReturnValue(target as unknown as EditorView);
  const parser = new Parser(
    { bind: () => () => {} } as never,
    { keepCursorWithinContent: "bullet-and-checkbox" } as never,
  );
  const targetLeaf = {
    view: { editor: target.state.field(editorInfoField).editor },
  };
  const setActiveLeaf = jest.fn();
  const feature = new DragAndDrop(
    {
      app: {
        workspace: { getLeavesOfType: () => [targetLeaf], setActiveLeaf },
      },
    } as never,
    { dragAndDrop: true } as never,
    { getDefaultIndentChars: () => "\t" } as never,
    parser,
    {} as never,
  );
  const internals = feature as unknown as {
    preStart: unknown;
    documents: Map<unknown, unknown>;
    startDragging(): void;
    detectAndDrawDropZone(x: number, y: number): void;
    stopDragging(): void;
  };
  const style: Record<string, string> = {};
  internals.documents.set(doc, {
    doc,
    dropZone: {
      setCssStyles: (next: Record<string, string>) =>
        Object.assign(style, next),
    },
  });
  internals.preStart = { x: 0, y: 0, view: source, target: null };
  internals.startDragging();
  return { source, target, internals, style, doc, targetLeaf, setActiveLeaf };
}
afterEach(() => jest.restoreAllMocks());

test("routes a drag to another pane, draws its indent, and moves a subtree as a child", () => {
  const { source, target, internals, style } = setup("- parent");
  internals.detectAndDrawDropZone(516, 12);
  expect(style.left).toBe("516px");
  internals.stopDragging();
  expect(source.state.doc.toString()).toBe("- keep");
  expect(target.state.doc.toString()).toBe("- parent\n\t- move\n\t\t- child");
  undo(target);
  expect(source.state.doc.toString()).toBe("- move\n\t- child\n- keep");
  expect(target.state.doc.toString()).toBe("- parent");
});

test("routes a drop into an empty note", () => {
  const { source, target, internals } = setup("");
  internals.detectAndDrawDropZone(500, 0);
  internals.stopDragging();
  expect(source.state.doc.toString()).toBe("- keep");
  expect(target.state.doc.toString()).toBe("- move\n\t- child");
});

test("rejects a drop if the destination changed after drawing its indicator", () => {
  const { source, target, internals } = setup("- parent");
  internals.detectAndDrawDropZone(516, 12);
  target.dispatch({ changes: { from: 0, insert: "edit" } });
  internals.stopDragging();
  expect(source.state.doc.toString()).toBe("- move\n\t- child\n- keep");
  expect(target.state.doc.toString()).toBe("edit- parent");
});

test("follows the hovered list chunk within the destination pane", () => {
  const { source, target, internals } = setup("- first\n\n# gap\n\n- second");
  internals.detectAndDrawDropZone(500, 0);
  internals.detectAndDrawDropZone(500, 80);
  internals.stopDragging();
  expect(source.state.doc.toString()).toBe("- keep");
  expect(target.state.doc.toString()).toBe(
    "- first\n\n# gap\n\n- move\n\t- child\n- second",
  );
});

test("cancels the pending drop when the pointer leaves the document", () => {
  const { source, target, internals, doc, style } = setup("- parent");
  internals.detectAndDrawDropZone(516, 12);
  doc.elementFromPoint = () => null;
  internals.detectAndDrawDropZone(9000, 9000);
  expect(style.display).toBe("none");
  internals.stopDragging();
  expect(source.state.doc.toString()).toBe("- move\n\t- child\n- keep");
  expect(target.state.doc.toString()).toBe("- parent");
});

test("activates the exact destination pane and focuses the moved item after a successful drop", () => {
  const { target, internals, targetLeaf, setActiveLeaf } = setup("- parent");
  internals.detectAndDrawDropZone(516, 12);
  internals.stopDragging();
  expect(target.state.selection.main.head).toBe(12);
  expect(setActiveLeaf).toHaveBeenCalledWith(targetLeaf, { focus: true });
  expect(target.focus).toHaveBeenCalledTimes(1);
});

test.each([
  { text: "\n", y: 20, want: "\n- move\n\t- child" },
  { text: "# Heading", y: 12, want: "# Heading\n- move\n\t- child" },
  {
    text: "```md\n- code\n```\nBody",
    y: 72,
    want: "```md\n- code\n```\nBody\n- move\n\t- child",
  },
  {
    text: "---\ntags:\n- example\n---",
    y: 40,
    want: "---\ntags:\n- example\n---\n- move\n\t- child",
  },
  {
    text: "Plain paragraph",
    y: 12,
    want: "Plain paragraph\n- move\n\t- child",
  },
  { text: "Plain paragraph", y: 0, want: "- move\n\t- child\nPlain paragraph" },
  {
    text: "Before\n\nAfter",
    y: 20,
    want: "Before\n- move\n\t- child\n\nAfter",
  },
  {
    text: "---\ntitle: Example\n---",
    y: 20,
    want: "---\ntitle: Example\n---\n- move\n\t- child",
  },
  {
    text: "---\ntitle: Example\n---\n",
    y: 60,
    want: "---\ntitle: Example\n---\n- move\n\t- child",
  },
])(
  "moves into a non-list destination at a line boundary: $text / $y",
  ({ text, y, want }) => {
    const { source, target, internals, style } = setup(text);
    internals.detectAndDrawDropZone(500, y);
    expect(style.display).toBe("block");
    internals.stopDragging();
    expect(source.state.doc.toString()).toBe("- keep");
    expect(target.state.doc.toString()).toBe(want);
    undo(target);
    expect(source.state.doc.toString()).toBe("- move\n\t- child\n- keep");
    expect(target.state.doc.toString()).toBe(text);
    redo(source);
    expect(source.state.doc.toString()).toBe("- keep");
    expect(target.state.doc.toString()).toBe(want);
  },
);

test.each(["```md\n- code\n```", "~~~\nplain\n~~~", "---\ntitle: unfinished"])(
  "does not drop into fenced code or unclosed frontmatter: %s",
  (text) => {
    const { source, target, internals, style } = setup(text);
    internals.detectAndDrawDropZone(500, 20);
    expect(style.display).toBe("none");
    internals.stopDragging();
    expect(source.state.doc.toString()).toBe("- move\n\t- child\n- keep");
    expect(target.state.doc.toString()).toBe(text);
  },
);
