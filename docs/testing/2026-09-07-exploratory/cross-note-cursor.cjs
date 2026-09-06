const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const { createRequire } = require("node:module");

// Run from any directory; dependencies and product source come from this repository.
const repo = path.resolve(__dirname, "../../..");
const repoRequire = createRequire(path.join(repo, "package.json"));
const ts = repoRequire("typescript");
const { EditorState, EditorSelection, StateField, Transaction } =
  repoRequire("@codemirror/state");
const { history, undo, redo } = repoRequire("@codemirror/commands");
const readers = StateField.define({
  create: () => null,
  update: (value) => value,
});
const editorAdapter = {
  getEditorFromState: (state) => state.field(readers),
  getFoldedLinesFromState: () => [],
};
const loaded = new Map();
function loadSource(relative) {
  let filename = path.resolve(repo, relative);
  if (!fs.existsSync(filename) || fs.statSync(filename).isDirectory()) {
    if (fs.existsSync(filename + ".ts")) filename += ".ts";
    else filename = path.join(filename, "index.ts");
  }
  if (filename === path.join(repo, "src/editor/index.ts")) return editorAdapter;
  if (loaded.has(filename)) return loaded.get(filename).exports;
  const module = { exports: {} };
  loaded.set(filename, module);
  const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
    fileName: filename,
  }).outputText;
  const localRequire = (name) =>
    name.startsWith(".")
      ? loadSource(path.resolve(path.dirname(filename), name))
      : repoRequire(name);
  vm.runInThisContext(
    "(function(require,module,exports,__filename,__dirname){" + code + "\n})",
    { filename },
  )(localRequire, module, module.exports, filename, path.dirname(filename));
  return module.exports;
}

const { EditorSelectionsBehaviourOverride } = loadSource(
  "src/features/EditorSelectionsBehaviourOverride.ts",
);
const { CrossNoteMove, coordinateCrossNoteHistory, crossNoteHistory } =
  loadSource("src/features/CrossNoteMove.ts");
const { Parser } = loadSource("src/services/Parser.ts");
const { OperationPerformer } = loadSource("src/services/OperationPerformer.ts");
const { ChangesApplicator } = loadSource("src/services/ChangesApplicator.ts");

function setup({ separateFeatures = false } = {}) {
  let timerId = 0;
  const timers = new Map();
  const events = [];
  const repairs = [];
  global.window = {
    setTimeout: (callback) => {
      const id = ++timerId;
      timers.set(id, callback);
      events.push(["schedule", id]);
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
      events.push(["cancel", id]);
    },
  };
  const settings = { keepCursorWithinContent: "bullet-and-checkbox" };
  const parser = new Parser({ bind: () => () => {} }, settings);
  const performer = new OperationPerformer(parser, new ChangesApplicator());
  const parse = parser.parse.bind(parser);
  parser.parse = (editor, ...args) => {
    repairs.push(editor.name);
    return parse(editor, ...args);
  };
  function feature() {
    let extensions;
    const instance = new EditorSelectionsBehaviourOverride(
      {
        registerEditorExtension: (value) => {
          extensions = value;
        },
      },
      settings,
      parser,
      performer,
    );
    instance.load();
    assert.ok(extensions);
    return extensions;
  }
  const sharedExtensions = feature();
  function editor(name, doc, anchor = 2) {
    const view = {
      state: null,
      dispatch(tr) {
        const transaction =
          tr instanceof Transaction ? tr : view.state.update(tr);
        assert.equal(transaction.startState, view.state, "stale transaction");
        view.state = transaction.state;
        events.push([
          "dispatch",
          name,
          transaction.annotation(Transaction.userEvent),
          adapter.getCursor(),
        ]);
      },
    };
    const adapter = {
      name,
      getCodeMirrorView: () => view,
      getCursor: () => adapter.offsetToPos(view.state.selection.main.head),
      getLine: (line) => view.state.doc.line(line + 1).text,
      lastLine: () => view.state.doc.lines - 1,
      listSelections: () =>
        view.state.selection.ranges.map(({ anchor, head }) => ({
          anchor: adapter.offsetToPos(anchor),
          head: adapter.offsetToPos(head),
        })),
      getAllFoldedLines: () => [],
      offsetToPos(offset) {
        const line = view.state.doc.lineAt(offset);
        return { line: line.number - 1, ch: offset - line.from };
      },
      posToOffset: ({ line, ch }) => view.state.doc.line(line + 1).from + ch,
      getRange: (from, to) =>
        view.state.doc.sliceString(
          adapter.posToOffset(from),
          adapter.posToOffset(to),
        ),
      setSelections: (ranges) =>
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
        throw new Error("Unexpected document correction");
      },
      fold: () => {
        throw new Error("Unexpected fold");
      },
      unfold: () => {
        throw new Error("Unexpected unfold");
      },
    };
    view.reader = adapter;
    view.state = EditorState.create({
      doc,
      selection: { anchor },
      extensions: [
        history(),
        crossNoteHistory,
        readers.init(() => adapter),
        separateFeatures ? feature() : sharedExtensions,
      ],
    });
    coordinateCrossNoteHistory(view);
    return view;
  }
  function flush() {
    for (let count = 0; timers.size; count++) {
      assert.ok(count < 30, "cursor repair timer loop");
      const [id, callback] = timers.entries().next().value;
      timers.delete(id);
      callback();
    }
  }
  return { editor, flush, events, repairs };
}

const results = [];
for (const paired of [false, true]) {
  const h = setup();
  const a = h.editor("source", "- Alpha");
  const b = h.editor("target", "- Beta");
  a.dispatch({ selection: { anchor: 0 } });
  if (paired) b.dispatch({ selection: { anchor: 0 } });
  h.flush();
  const source = a.reader.getCursor();
  const target = b.reader.getCursor();
  results.push({
    case: paired
      ? "same-turn two-editor selection"
      : "single-editor selection control",
    source,
    target,
    repairs: h.repairs,
    events: h.events,
  });
  if (!paired) assert.equal(source.ch, 2);
  assert.equal(target.ch, 2);
}

for (const separateFeatures of [false, true]) {
  const h = setup({ separateFeatures });
  const a = h.editor("source", "- Alpha\n\t- child\n- Beta");
  const b = h.editor("target", "- Destination");
  const stages = [];
  const capture = (stage) =>
    stages.push({
      stage,
      source: a.reader.getCursor(),
      target: b.reader.getCursor(),
      sourceDoc: a.state.doc.toString(),
      targetDoc: b.state.doc.toString(),
    });
  capture("initial: both cursors in content");
  assert.equal(
    new CrossNoteMove(
      a,
      b,
      { from: 0, to: 16 },
      b.state.doc.length,
      "\t",
    ).apply(),
    true,
  );
  h.flush();
  capture("move");
  assert.equal(undo(b), true);
  h.flush();
  capture("destination undo");
  a.dispatch({ selection: { anchor: 4 }, userEvent: "select.pointer" });
  h.flush();
  capture("click source Alpha text");
  const oldRepairs = h.repairs.length;
  const oldEvents = h.events.length;
  assert.equal(redo(a), true);
  h.flush();
  capture("source redo");
  results.push({
    case: separateFeatures
      ? "cross-note history, one feature per editor control"
      : "cross-note history, production shared feature",
    stages,
    repairsAfterSourceRedo: h.repairs.slice(oldRepairs),
    eventsAfterSourceRedo: h.events.slice(oldEvents),
  });
  assert.equal(a.state.doc.toString(), "- Beta");
  if (separateFeatures) assert.equal(a.reader.getCursor().ch, 2);
}

const production = results.find(
  (item) => item.case === "cross-note history, production shared feature",
);
const paired = results.find(
  (item) => item.case === "same-turn two-editor selection",
);
const failures = [];
if (paired.source.ch < 2)
  failures.push(
    "source cursor after paired selection is ch" +
      paired.source.ch +
      ", expected >= 2",
  );
if (production.stages.at(-1).source.ch < 2)
  failures.push(
    "source cursor after paired Redo is ch" +
      production.stages.at(-1).source.ch +
      ", expected >= 2",
  );
console.log(
  JSON.stringify(
    {
      node: process.version,
      productSourcesEditedByHarness: false,
      status: failures.length ? "failed" : "passed",
      failures,
      results,
    },
    null,
    2,
  ),
);
for (const failure of failures) console.error("FAIL: " + failure);
if (failures.length) process.exitCode = 1;
