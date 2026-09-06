import { Plugin, editorInfoField } from "obsidian";

import { history, redo, undo } from "@codemirror/commands";
import {
  EditorSelection,
  EditorState,
  Extension,
  StateField,
  Transaction,
  TransactionSpec,
} from "@codemirror/state";

import { makeLogger, makeSettings } from "../../__mocks__";
import { MyEditorPosition, MyEditorSelection } from "../../editor";
import { ChangesApplicator } from "../../services/ChangesApplicator";
import { OperationPerformer } from "../../services/OperationPerformer";
import { Parser } from "../../services/Parser";
import { BulletTypingGuard } from "../BulletTypingGuard";
import {
  CrossNoteMove,
  coordinateCrossNoteHistory,
  crossNoteHistory,
} from "../CrossNoteMove";
import { EditorSelectionsBehaviourOverride } from "../EditorSelectionsBehaviourOverride";

jest.mock(
  "obsidian",
  () => ({
    Editor: class {},
    editorInfoField: jest
      .requireActual<typeof import("@codemirror/state")>("@codemirror/state")
      .StateField.define({
        create: () => null,
        update: (value: unknown) => value,
      }),
  }),
  { virtual: true },
);

async function setup() {
  const extensions: Extension[] = [];
  const plugin = {
    registerEditorExtension: (extension: Extension) =>
      extensions.push(extension),
  } as unknown as Plugin;
  const settings = makeSettings();
  settings.keepBodyTextInBullets = true;
  settings.onChange = () => {};
  settings.removeCallback = () => {};
  const logger = makeLogger();
  const parser = new Parser(logger, settings);
  const feature = new EditorSelectionsBehaviourOverride(
    plugin,
    settings,
    parser,
    new OperationPerformer(parser, new ChangesApplicator()),
  );
  await feature.load();
  await new BulletTypingGuard(plugin, settings, logger).load();

  function editor(doc: string) {
    const view = {
      state: EditorState.create(),
      dispatch(transaction: Transaction | TransactionSpec) {
        const tr =
          transaction instanceof Transaction
            ? transaction
            : view.state.update(transaction);
        if (tr.startState !== view.state) throw new Error("Stale transaction");
        view.state = tr.state;
      },
    };
    const adapter = {
      cm: view,
      getCursor: () => adapter.offsetToPos(view.state.selection.main.head),
      getLine: (line: number) => view.state.doc.line(line + 1).text,
      lastLine: () => view.state.doc.lines - 1,
      listSelections: () =>
        view.state.selection.ranges.map(({ anchor, head }) => ({
          anchor: adapter.offsetToPos(anchor),
          head: adapter.offsetToPos(head),
        })),
      offsetToPos: (offset: number) => {
        const line = view.state.doc.lineAt(offset);
        return { line: line.number - 1, ch: offset - line.from };
      },
      posToOffset: ({ line, ch }: MyEditorPosition) =>
        view.state.doc.line(line + 1).from + ch,
      getRange: (from: MyEditorPosition, to: MyEditorPosition) =>
        view.state.doc.sliceString(
          adapter.posToOffset(from),
          adapter.posToOffset(to),
        ),
      setSelections: (ranges: MyEditorSelection[]) =>
        view.dispatch({
          selection: EditorSelection.create(
            ranges.map(({ anchor, head }) =>
              EditorSelection.range(
                adapter.posToOffset(anchor),
                adapter.posToOffset(head),
              ),
            ),
          ),
        }),
      replaceRange: () => {
        throw new Error("Cursor repair must not change the document");
      },
    };
    view.state = EditorState.create({
      doc,
      selection: { anchor: 2 },
      extensions: [
        history(),
        crossNoteHistory,
        (editorInfoField as StateField<unknown>).init(() => ({
          editor: adapter,
        })),
        extensions,
      ],
    });
    coordinateCrossNoteHistory(view);
    return view;
  }
  return { editor, feature };
}

describe("cursor correction across editors", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

  beforeEach(() => {
    jest.useFakeTimers();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { setTimeout, clearTimeout },
    });
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    if (originalWindow)
      Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });

  test("corrects both editors when their selections change in the same turn", async () => {
    const { editor, feature } = await setup();
    const source = editor("- Alpha");
    const target = editor("- Beta");
    source.dispatch({ selection: { anchor: 0 } });
    target.dispatch({ selection: { anchor: 0 } });
    jest.runAllTimers();
    expect(source.state.selection.main.head).toBe(2);
    expect(target.state.selection.main.head).toBe(2);
    expect(feature.hasPendingSelectionAdjustment()).toBe(false);
  });

  test("replaces work in one editor without letting a stale callback clear its replacement", async () => {
    const { editor, feature } = await setup();
    const source = editor("- Alpha");
    const schedule = jest.spyOn(window, "setTimeout");
    source.dispatch({ selection: { anchor: 0 } });
    const staleCallback = schedule.mock.calls[0][0] as () => void;
    source.dispatch({ selection: { anchor: 4 } });
    expect(jest.getTimerCount()).toBe(1);
    staleCallback();
    expect(feature.hasPendingSelectionAdjustment()).toBe(true);
    jest.runAllTimers();
    expect(source.state.selection.main.head).toBe(4);
    expect(feature.hasPendingSelectionAdjustment()).toBe(false);
    schedule.mockRestore();
  });

  test("keeps typing in the restored item's body after source Undo", async () => {
    const { editor } = await setup();
    const source = editor("- Alpha\n\t- child\n- Beta");
    const target = editor("- Destination");
    expect(
      new CrossNoteMove(source, target, { from: 0, to: 16 }, 13, "\t").apply(),
    ).toBe(true);
    jest.runAllTimers();
    expect(undo(target)).toBe(true);
    jest.runAllTimers();
    expect(redo(target)).toBe(true);
    jest.runAllTimers();
    source.dispatch({ selection: { anchor: 4 }, userEvent: "select.pointer" });
    jest.runAllTimers();

    expect(undo(source)).toBe(true);
    jest.runAllTimers();
    expect(source.state.doc.toString()).toBe("- Alpha\n\t- child\n- Beta");
    expect(target.state.doc.toString()).toBe("- Destination");
    expect(source.state.selection.main.head).toBe(2);
    source.dispatch({
      ...source.state.replaceSelection("X"),
      userEvent: "input.type",
    });
    jest.runAllTimers();
    expect(source.state.doc.toString()).toBe("- XAlpha\n\t- child\n- Beta");
  });

  test.each(["source", "target"] as const)(
    "keeps typing in the remaining item's body after coordinated Redo from %s",
    async (redoFrom) => {
      const { editor } = await setup();
      const source = editor("- Alpha\n\t- child\n- Beta");
      const target = editor("- Destination");
      expect(
        new CrossNoteMove(
          source,
          target,
          { from: 0, to: 16 },
          13,
          "\t",
        ).apply(),
      ).toBe(true);
      jest.runAllTimers();
      expect(undo(target)).toBe(true);
      jest.runAllTimers();
      expect(source.state.doc.toString()).toBe("- Alpha\n\t- child\n- Beta");
      expect(target.state.doc.toString()).toBe("- Destination");
      source.dispatch({
        selection: { anchor: 4 },
        userEvent: "select.pointer",
      });
      jest.runAllTimers();

      expect(redo(redoFrom === "source" ? source : target)).toBe(true);
      jest.runAllTimers();
      expect(source.state.doc.toString()).toBe("- Beta");
      expect(target.state.doc.toString()).toBe(
        "- Destination\n\t- Alpha\n\t\t- child",
      );
      expect(source.state.selection.main.head).toBe(2);
      source.dispatch({
        ...source.state.replaceSelection("X"),
        userEvent: "input.type",
      });
      jest.runAllTimers();
      expect(source.state.doc.toString()).toBe("- XBeta");
    },
  );

  test.each(["reset", "unload"] as const)(
    "%s cancels pending repairs in every editor",
    async (action) => {
      const { editor, feature } = await setup();
      const source = editor("- Alpha");
      const target = editor("- Beta");
      source.dispatch({ selection: { anchor: 0 } });
      target.dispatch({ selection: { anchor: 0 } });
      if (action === "reset") feature.resetState();
      else await feature.unload();
      jest.runAllTimers();
      expect(source.state.selection.main.head).toBe(0);
      expect(target.state.selection.main.head).toBe(0);
      expect(feature.hasPendingSelectionAdjustment()).toBe(false);
    },
  );
});
