import { history, redo, undo } from "@codemirror/commands";
import {
  EditorState,
  StateEffect,
  Transaction,
  TransactionSpec,
} from "@codemirror/state";

import {
  CrossNoteMove,
  coordinateCrossNoteHistory,
  crossNoteHistory,
} from "../CrossNoteMove";

function editor(
  doc: string,
  fail?: (tr: Transaction | TransactionSpec) => boolean,
) {
  const view = {
    state: EditorState.create({
      doc,
      extensions: [history(), crossNoteHistory],
    }),
    dispatch(tr: Transaction | TransactionSpec) {
      if (fail?.(tr)) throw new Error("Rejected dispatch");
      if (tr instanceof Transaction && tr.startState !== this.state)
        throw new Error("Stale transaction");
      this.state =
        tr instanceof Transaction ? tr.state : this.state.update(tr).state;
    },
  };
  coordinateCrossNoteHistory(view);
  return view;
}

test("moves a branch and continuation lines with destination indentation", () => {
  const source = editor(
    "- keep\n\t- move\n\t  continuation\n\t\t- child\n- tail",
  );
  const target = editor("- target");
  const move = new CrossNoteMove(
    source,
    target,
    { from: 7, to: 40 },
    8,
    "\t\t",
  );
  expect(move.apply()).toBe(true);
  expect(source.state.doc.toString()).toBe("- keep\n- tail");
  expect(target.state.doc.toString()).toBe(
    "- target\n\t\t- move\n\t\t  continuation\n\t\t\t- child",
  );
});

test("moves the only branch to an empty note and restores both with undo/redo from either editor", () => {
  const source = editor("- branch\n\t- child");
  const target = editor("");
  expect(
    new CrossNoteMove(source, target, { from: 0, to: 17 }, 0, "").apply(),
  ).toBe(true);
  expect(source.state.doc.toString()).toBe("");
  expect(target.state.doc.toString()).toBe("- branch\n\t- child");
  expect(undo(target)).toBe(true);
  expect(source.state.doc.toString()).toBe("- branch\n\t- child");
  expect(target.state.doc.toString()).toBe("");
  redo(source);
  expect(source.state.doc.toString()).toBe("");
  expect(target.state.doc.toString()).toBe("- branch\n\t- child");
});

test("rejects stale source and destination snapshots", () => {
  for (const which of ["source", "target"]) {
    const source = editor("- branch");
    const target = editor("");
    const move = new CrossNoteMove(source, target, { from: 0, to: 8 }, 0, "");
    (which === "source" ? source : target).dispatch({
      changes: { from: 0, insert: "edit" },
    });
    expect(move.apply()).toBe(false);
    expect(source.state.doc.toString()).toBe(
      which === "source" ? "edit- branch" : "- branch",
    );
    expect(target.state.doc.toString()).toBe(which === "target" ? "edit" : "");
  }
});

test("does not undo one side across intervening edits in the other note", () => {
  const source = editor("- branch");
  const target = editor("");
  new CrossNoteMove(source, target, { from: 0, to: 8 }, 0, "").apply();
  source.dispatch({
    changes: { from: 0, insert: "- later" },
    userEvent: "input",
  });
  expect(undo(target)).toBe(true);
  expect(source.state.doc.toString()).toBe("- later");
  expect(target.state.doc.toString()).toBe("- branch");
  undo(source);
  expect(undo(target)).toBe(true);
  expect(source.state.doc.toString()).toBe("- branch");
  expect(target.state.doc.toString()).toBe("");
});

test("preflights editing filters before removing source", () => {
  const source = editor("- branch");
  const target = editor("");
  target.state = EditorState.create({
    extensions: [
      history(),
      crossNoteHistory,
      EditorState.transactionFilter.of((tr) => (tr.docChanged ? [] : tr)),
    ],
  });
  expect(
    new CrossNoteMove(source, target, { from: 0, to: 8 }, 0, "").apply(),
  ).toBe(false);
  expect(source.state.doc.toString()).toBe("- branch");
  expect(target.state.doc.toString()).toBe("");
});

test("preserves all dispatch arguments and restores the original on destroy", () => {
  let state = EditorState.create({ doc: "ab" });
  const original = (...specs: TransactionSpec[]) => {
    state = state.update(...specs).state;
  };
  const view = { state, dispatch: original };
  const restore = coordinateCrossNoteHistory(view);
  view.dispatch(
    { changes: { from: 0, insert: "1" } },
    { changes: { from: 2, insert: "2" } },
  );
  expect(state.doc.toString()).toBe("1ab2");
  restore();
  expect(view.dispatch).toBe(original);
});

test("rejects a move when a filter strips the coordinated history link", () => {
  const source = editor("- branch");
  const target = editor("");
  target.state = EditorState.create({
    extensions: [
      history(),
      crossNoteHistory,
      EditorState.transactionFilter.of((tr) => ({ changes: tr.changes })),
    ],
  });
  expect(
    new CrossNoteMove(source, target, { from: 0, to: 8 }, 0, "").apply(),
  ).toBe(false);
  expect(source.state.doc.toString()).toBe("- branch");
  expect(target.state.doc.toString()).toBe("");
});

test("blocks paired history when the other note has been closed or replaced", () => {
  const source = editor("- branch");
  const target = editor("");
  let available = true;
  new CrossNoteMove(
    source,
    target,
    { from: 0, to: 8 },
    0,
    "",
    () => available,
  ).apply();
  available = false;
  undo(source);
  expect(source.state.doc.toString()).toBe("");
  expect(target.state.doc.toString()).toBe("- branch");
});

test("does not redo a paired move over new edits", () => {
  const source = editor("- branch");
  const target = editor("");
  new CrossNoteMove(source, target, { from: 0, to: 8 }, 0, "").apply();
  undo(source);
  target.dispatch({
    changes: { from: 0, insert: "- later" },
    userEvent: "input",
  });
  redo(source);
  expect(source.state.doc.toString()).toBe("- branch");
  expect(target.state.doc.toString()).toBe("- later");
});

test("preserves surrounding lines when dropping before a nested list", () => {
  const source = editor("- move");
  const target = editor("- parent\n\t- existing\n- tail");
  new CrossNoteMove(source, target, { from: 0, to: 6 }, 9, "\t").apply();
  expect(source.state.doc.toString()).toBe("");
  expect(target.state.doc.toString()).toBe(
    "- parent\n\t- move\n\t- existing\n- tail",
  );
});

test("explains a blocked undo and respects a note becoming read-only", () => {
  const source = editor("- branch");
  const target = editor("");
  const rejected = jest.fn();
  new CrossNoteMove(
    source,
    target,
    { from: 0, to: 8 },
    0,
    "",
    () => false,
    rejected,
  ).apply();
  const move = new CrossNoteMove(
    source,
    target,
    { from: 0, to: 8 },
    0,
    "",
    () => true,
    rejected,
  );
  move.apply();
  source.state = source.state.update({
    effects: StateEffect.appendConfig.of(EditorState.readOnly.of(true)),
  }).state;
  undo(target);
  expect(source.state.doc.toString()).toBe("");
  expect(target.state.doc.toString()).toBe("- branch");
  expect(rejected).toHaveBeenCalledTimes(1);
});

test.each([false, true])(
  "keeps a move atomic when a target listener updates the source (document edit: %s)",
  (documentEdit) => {
    const source = editor("- branch");
    const target = editor("");
    const targetDispatch = target.dispatch.bind(target);
    let once = true;
    target.dispatch = (tr) => {
      targetDispatch(tr);
      if (once) {
        once = false;
        source.dispatch(
          documentEdit
            ? { changes: { from: 8, insert: "\n- later" }, userEvent: "input" }
            : { selection: { anchor: 2 } },
        );
      }
    };
    expect(() =>
      new CrossNoteMove(source, target, { from: 0, to: 8 }, 0, "").apply(),
    ).not.toThrow();
    expect(source.state.doc.toString()).toBe(documentEdit ? "\n- later" : "");
    expect(target.state.doc.toString()).toBe("- branch");
  },
);

test("keeps coordinated undo atomic when the partner listener changes the initiating selection", () => {
  const source = editor("- branch");
  const target = editor("");
  new CrossNoteMove(source, target, { from: 0, to: 8 }, 0, "").apply();
  const sourceDispatch = source.dispatch.bind(source);
  let once = true;
  source.dispatch = (tr) => {
    sourceDispatch(tr);
    if (once) {
      once = false;
      target.dispatch({ selection: { anchor: 2 } });
    }
  };
  expect(() => undo(target)).not.toThrow();
  expect(source.state.doc.toString()).toBe("- branch");
  expect(target.state.doc.toString()).toBe("");
});

test("rolls back the destination when source dispatch fails before applying", () => {
  const source = editor("- branch");
  const target = editor("");
  const original = source.dispatch.bind(source);
  source.dispatch = () => {
    throw new Error("Unavailable editor");
  };
  expect(
    new CrossNoteMove(source, target, { from: 0, to: 8 }, 0, "").apply(),
  ).toBe(false);
  expect(source.state.doc.toString()).toBe("- branch");
  expect(target.state.doc.toString()).toBe("");
  source.dispatch = original;
  redo(target);
  expect(source.state.doc.toString()).toBe("- branch");
  expect(target.state.doc.toString()).toBe("");
});

test("preserves a reentrant document edit during paired undo", () => {
  const source = editor("- branch");
  const target = editor("");
  new CrossNoteMove(source, target, { from: 0, to: 8 }, 0, "").apply();
  const original = source.dispatch.bind(source);
  let once = true;
  source.dispatch = (tr) => {
    original(tr);
    if (once) {
      once = false;
      target.dispatch({
        changes: { from: 8, insert: "later" },
        userEvent: "input",
      });
    }
  };
  undo(target);
  expect(source.state.doc.toString()).toBe("- branch");
  expect(target.state.doc.toString()).toBe("later");
  redo(source);
  expect(source.state.doc.toString()).toBe("- branch");
  expect(target.state.doc.toString()).toBe("later");
});

test("keeps queued listener edits when the move is rolled back", () => {
  const source = editor(
    "- branch",
    (tr) => tr instanceof Transaction && tr.isUserEvent("move.drop"),
  );
  const target = editor("");
  const originalSource = source.dispatch.bind(source);
  const originalTarget = target.dispatch.bind(target);
  let once = true;
  target.dispatch = (tr) => {
    originalTarget(tr);
    if (once) {
      once = false;
      source.dispatch({
        changes: { from: 8, insert: "!" },
        userEvent: "input",
      });
    }
  };
  source.dispatch = (tr) => {
    originalSource(tr);
  };
  expect(
    new CrossNoteMove(source, target, { from: 0, to: 8 }, 0, "").apply(),
  ).toBe(false);
  expect(source.state.doc.toString()).toBe("- branch!");
  expect(target.state.doc.toString()).toBe("");
});

test.each([
  ["- branch", 2],
  ["- [ ] task", 6],
  ["12. ordered", 4],
])(
  "places the destination caret in the moved item body: %s",
  (branch, bodyOffset) => {
    const source = editor(branch);
    const target = editor("- parent");
    new CrossNoteMove(
      source,
      target,
      { from: 0, to: branch.length },
      8,
      "\t",
    ).apply();
    expect(target.state.selection.main.anchor).toBe(10 + bodyOffset);
    expect(target.state.selection.main.empty).toBe(true);
  },
);
