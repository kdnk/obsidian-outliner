import { Command, editorInfoField } from "obsidian";

import {
  EditorSelection,
  EditorState,
  Extension,
  StateEffect,
} from "@codemirror/state";

import { makeLogger, makeSettings } from "../../__mocks__";
import { Parser } from "../../services/Parser";
import { ListZoom, ListZoomState, setListZoom } from "../ListZoom";

jest.mock(
  "obsidian",
  () => ({
    editorInfoField: jest
      .requireActual<typeof import("@codemirror/state")>("@codemirror/state")
      .StateField.define({
        create: () => null,
        update: (value: unknown) => value,
      }),
  }),
  { virtual: true },
);

const doc = "- work\n\t- project\n\t\t- task\n\t- other\n- personal";
function setup() {
  const zoom = new ListZoomState(new Parser(makeLogger(), makeSettings()));
  const state = EditorState.create({ doc, extensions: zoom.extension });
  return { zoom, state };
}

test("focuses a subtree without changing Markdown or another editor", () => {
  const { zoom, state } = setup();
  const focused = state.update({
    effects: setListZoom.of(7),
    selection: { anchor: 10 },
  }).state;
  expect(zoom.range(focused)).toMatchObject({ from: 7, to: 26, indent: "\t" });
  expect(focused.doc.toString()).toBe(doc);
  expect(zoom.range(state)).toBeNull();
});

test("recomputes the focused subtree after editing its children", () => {
  const { zoom, state } = setup();
  const focused = state.update({
    effects: setListZoom.of(7),
    selection: { anchor: 10 },
  }).state;
  const edited = focused.update({ changes: { from: 26, insert: "!" } }).state;
  expect(zoom.range(edited)?.to).toBe(27);
  expect(edited.doc.toString()).toBe(
    "- work\n\t- project\n\t\t- task!\n\t- other\n- personal",
  );
});

test("rejects edits that cross into hidden content", () => {
  const { state } = setup();
  const focused = state.update({
    effects: setListZoom.of(7),
    selection: { anchor: 10 },
  }).state;
  expect(
    focused
      .update({ changes: { from: 0, to: 10, insert: "oops" } })
      .state.doc.toString(),
  ).toBe(doc);
});

test("limits select-all to visible content", () => {
  const { state } = setup();
  const focused = state.update({
    effects: setListZoom.of(7),
    selection: { anchor: 10 },
  }).state;
  const selected = focused.update({
    selection: EditorSelection.single(0, doc.length),
  }).state;
  expect(selected.selection.main.from).toBe(8);
  expect(selected.selection.main.to).toBe(26);
});

test("exits zoom when the focused root is removed", () => {
  const { zoom, state } = setup();
  const focused = state.update({
    effects: setListZoom.of(7),
    selection: { anchor: 10 },
  }).state;
  const deleted = focused.update({
    changes: { from: 7, to: 26, insert: "" },
  }).state;
  expect(zoom.range(deleted)).toBeNull();
});

test("returning to the note leaves content unchanged", () => {
  const { zoom, state } = setup();
  const focused = state.update({
    effects: setListZoom.of(7),
    selection: { anchor: 10 },
  }).state;
  const restored = focused.update({ effects: setListZoom.of(null) }).state;
  expect(zoom.range(restored)).toBeNull();
  expect(restored.doc.toString()).toBe(doc);
});

test("reveals the note when native history or synchronization changes hidden text", () => {
  const { zoom, state } = setup();
  const focused = state.update({
    effects: setListZoom.of(7),
    selection: { anchor: 10 },
  }).state;
  const changed = focused.update({
    changes: { from: 2, to: 6, insert: "office" },
    filter: false,
  }).state;
  expect(zoom.range(changed)).toBeNull();
  expect(changed.doc.toString()).toContain("- office");
});

test("adds another child at the visible end without absorbing the next sibling", () => {
  const { zoom, state } = setup();
  const focused = state.update({
    effects: setListZoom.of(7),
    selection: { anchor: 26 },
  }).state;
  const edited = focused.update({
    changes: { from: 26, insert: "\n\t\t- next" },
  }).state;
  const range = zoom.range(edited)!;
  expect(edited.doc.sliceString(range.from, range.to)).toBe(
    "\t- project\n\t\t- task\n\t\t- next",
  );
  expect(edited.doc.toString()).toContain("\n\t- other\n- personal");
});

test("the zoom command accepts an empty bare marker at EOF", async () => {
  const commands: Command[] = [];
  const extensions: Extension[] = [];
  const feature = new ListZoom(
    {
      addCommand: (command: Command) => commands.push(command),
      registerEditorExtension: (extension: Extension) =>
        extensions.push(extension),
    } as never,
    new Parser(makeLogger(), makeSettings()),
  );
  await feature.load();
  const view = {
    state: EditorState.create({ doc: "-", extensions }),
    scrollSnapshot: () => StateEffect.define<void>().of(),
    dispatch: (spec: Parameters<EditorState["update"]>[0]) => {
      view.state = view.state.update(spec).state;
    },
    focus: () => undefined,
  };
  const command = commands.find((entry) => entry.id === "zoom-in")!;
  expect(
    command.editorCheckCallback!(false, { cm: view } as never, {} as never),
  ).toBe(true);
  expect(view.state.selection.main.head).toBe(1);
  expect(view.state.doc.toString()).toBe("-");
});

test("accepts Obsidian set transactions from another pane and leaves zoom", () => {
  const { zoom, state } = setup();
  const focused = state.update({
    effects: setListZoom.of(7),
    selection: { anchor: 10 },
  }).state;
  const synced = focused.update({
    changes: {
      from: 0,
      to: doc.length,
      insert: "- office\n\t- project\n\t\t- task\n\t- other\n- personal",
    },
    userEvent: "set",
  }).state;
  expect(synced.doc.toString()).toBe(
    "- office\n\t- project\n\t\t- task\n\t- other\n- personal",
  );
  expect(zoom.range(synced)).toBeNull();
});

test("clears zoom when a reused editor changes files without changing text", () => {
  const zoom = new ListZoomState(new Parser(makeLogger(), makeSettings()));
  const info = { file: { path: "first.md" } };
  const state = EditorState.create({
    doc,
    extensions: [zoom.extension, editorInfoField.init(() => info as never)],
  });
  const focused = state.update({
    effects: setListZoom.of(7),
    selection: { anchor: 10 },
  }).state;
  info.file = { path: "second.md" };
  expect(zoom.range(focused.update({}).state)).toBeNull();
});

test("removing the plugin extension while zoomed reveals the unchanged document", () => {
  const { state, zoom } = setup();
  const focused = state.update({ effects: setListZoom.of(7) }).state;
  const removed = focused.update({
    effects: StateEffect.reconfigure.of([]),
  }).state;
  expect(removed.doc.toString()).toBe(doc);
  expect(zoom.range(removed)).toBeNull();
});

test("the breadcrumb panel tolerates the zoom field disappearing during plugin reload", async () => {
  const extensions: Extension[] = [];
  const feature = new ListZoom(
    {
      addCommand: () => undefined,
      registerEditorExtension: (extension: Extension) =>
        extensions.push(extension),
    } as never,
    new Parser(makeLogger(), makeSettings()),
  );
  await feature.load();
  const labels: string[] = [];
  const panelDom = {
    classList: { add: () => undefined },
    setAttribute: () => undefined,
    replaceChildren: () => {
      labels.length = 0;
    },
    createSpan: () => undefined,
    createEl: (_tag: string, { text }: { text: string }) => {
      labels.push(text);
      return {
        setAttribute: () => undefined,
        addEventListener: () => undefined,
      };
    },
  };
  const focused = EditorState.create({ doc, extensions }).update({
    effects: setListZoom.of(7),
  }).state;
  const view = {
    state: focused,
    dom: { ownerDocument: { win: { createDiv: () => panelDom } } },
  };
  const panel = (
    feature as unknown as {
      panel(view: unknown): import("@codemirror/view").Panel;
    }
  ).panel(view);
  expect(labels).toContain("project");
  // The callback can run as the panel extension is being torn down.
  view.state = EditorState.create({ doc });
  panel.update!({
    startState: focused,
    state: view.state,
    docChanged: false,
  } as never);
  expect(labels).toEqual(["Whole note"]);
});
