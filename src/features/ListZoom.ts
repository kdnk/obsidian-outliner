import { Plugin, editorInfoField } from "obsidian";

import { foldedRanges, unfoldEffect } from "@codemirror/language";
import {
  EditorSelection,
  EditorState,
  Extension,
  MapMode,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  Panel,
  ViewUpdate,
  showPanel,
} from "@codemirror/view";

import { Feature } from "./Feature";

import { MyEditor } from "../editor";
import { getObsidianDomWindow } from "../obsidianDom";
import { List } from "../root";
import { Parser, Reader } from "../services/Parser";

export const setListZoom = StateEffect.define<number | null>();

interface ZoomRange {
  filePath: string | null;
  from: number;
  to: number;
  indent: string;
  ancestors: { from: number; label: string }[];
  decorations: DecorationSet;
}

function reader(state: EditorState): Reader {
  const pos = {
    line: state.doc.lineAt(state.selection.main.head).number - 1,
    ch: 0,
  };
  return {
    getCursor: () => pos,
    getLine: (n) => state.doc.line(n + 1).text,
    lastLine: () => state.doc.lines - 1,
    listSelections: () => [{ anchor: pos, head: pos }],
    getAllFoldedLines: () => [],
  };
}

export class ListZoomState {
  readonly field: StateField<ZoomRange | null>;
  readonly extension: Extension;

  constructor(private parser: Parser) {
    this.field = StateField.define<ZoomRange | null>({
      create: () => null,
      update: (value, tr) => {
        const effect = tr.effects.find((e) => e.is(setListZoom));
        if (effect?.is(setListZoom)) {
          return effect.value === null
            ? null
            : this.resolve(tr.state, effect.value);
        }
        if (!value) return null;
        if (
          (tr.state.field(editorInfoField, false)?.file?.path ?? null) !==
          value.filePath
        )
          return null;
        if (!tr.docChanged) return value;
        let changedOutside = false;
        tr.changes.iterChangedRanges((from, to) => {
          if (from < value.from || to > value.to) changedOutside = true;
        });
        // Native history and synchronization can bypass transaction filters.
        // Reveal their result rather than leave a hidden change on screen.
        if (changedOutside) return null;
        const mapped = tr.changes.mapPos(value.from, 1, MapMode.TrackDel);
        if (mapped === null) return null;
        const next = this.resolve(tr.state, mapped);
        // A removed marker must not silently focus its parent or next sibling.
        if (!next || next.from !== tr.state.doc.lineAt(mapped).from)
          return null;
        return next;
      },
      provide: (field) =>
        EditorView.decorations.from(
          field,
          (value) => value?.decorations ?? Decoration.none,
        ),
    });
    this.extension = [
      this.field,
      EditorState.transactionFilter.of((tr) => {
        const range = tr.startState.field(this.field);
        // Obsidian synchronizes other panes and file loads with userEvent=set.
        // These updates must reach the document; the field then exits zoom.
        if (
          !range ||
          tr.isUserEvent("set") ||
          tr.effects.some((e) => e.is(setListZoom))
        )
          return tr;
        let outside = false;
        tr.changes.iterChangedRanges((from, to) => {
          if (from < range.from || to > range.to) outside = true;
        });
        if (outside) return [];
        const next = tr.state.field(this.field);
        if (!next) return tr;
        const low = next.from + next.indent.length;
        const clamp = (pos: number) => Math.max(low, Math.min(next.to, pos));
        const ranges = tr.newSelection.ranges.map((r) =>
          EditorSelection.range(clamp(r.anchor), clamp(r.head)),
        );
        const selection = EditorSelection.create(
          ranges,
          tr.newSelection.mainIndex,
        );
        return selection.eq(tr.newSelection)
          ? tr
          : [tr, { selection, sequential: true }];
      }),
    ];
  }

  range(state: EditorState) {
    return state.field(this.field, false) ?? null;
  }

  resolve(state: EditorState, offset: number): ZoomRange | null {
    if (offset < 0 || offset > state.doc.length) return null;
    const line = state.doc.lineAt(offset).number - 1;
    const root = this.parser.parse(reader(state), { line, ch: 0 });
    const list = root?.getListUnderLine(line);
    if (!list) return null;
    const from = state.doc.line(list.getFirstLineContentStart().line + 1).from;
    const to = state.doc.line(
      list.getContentEndIncludingChildren().line + 1,
    ).to;
    const indent = list.getFirstLineIndent();
    const ancestors: ZoomRange["ancestors"] = [];
    let ancestor: List | null = list;
    while (ancestor && ancestor.getParent()) {
      const start = state.doc.line(
        ancestor.getFirstLineContentStart().line + 1,
      );
      ancestors.unshift({
        from: start.from,
        label: ancestor.getLines()[0] || "Empty item",
      });
      ancestor = ancestor.getParent();
    }
    const decorations = [];
    if (from > 0)
      decorations.push(Decoration.replace({ block: true }).range(0, from));
    if (to < state.doc.length)
      decorations.push(
        Decoration.replace({ block: true }).range(to, state.doc.length),
      );
    if (indent) {
      for (
        let n = state.doc.lineAt(from).number;
        n <= state.doc.lineAt(to).number;
        n++
      ) {
        const current = state.doc.line(n);
        if (current.text.startsWith(indent))
          decorations.push(
            Decoration.replace({}).range(
              current.from,
              current.from + indent.length,
            ),
          );
      }
    }
    return {
      filePath: state.field(editorInfoField, false)?.file?.path ?? null,
      from,
      to,
      indent,
      ancestors,
      decorations: Decoration.set(decorations, true),
    };
  }
}

export class ListZoom implements Feature {
  private zoom: ListZoomState;
  private snapshots = new WeakMap<EditorView, StateEffect<unknown>>();

  constructor(
    private plugin: Plugin,
    parser: Parser,
  ) {
    this.zoom = new ListZoomState(parser);
  }

  async load() {
    this.plugin.registerEditorExtension([
      this.zoom.extension,
      showPanel.from(this.zoom.field, (range) => (range ? this.panel : null)),
    ]);
    this.plugin.addCommand({
      id: "zoom-in",
      name: "Zoom into list",
      icon: "focus",
      editorCheckCallback: (checking, editor) => {
        const view = new MyEditor(editor).getCodeMirrorView();
        const target = this.zoom.resolve(
          view.state,
          view.state.selection.main.head,
        );
        if (!target) return false;
        if (!checking) this.navigate(view, target.from);
        return true;
      },
    });
    this.plugin.addCommand({
      id: "zoom-out",
      name: "Zoom out one level",
      icon: "arrow-up-left",
      editorCheckCallback: (checking, editor) => {
        const view = new MyEditor(editor).getCodeMirrorView();
        const range = this.zoom.range(view.state);
        if (!range) return false;
        if (!checking)
          this.navigate(
            view,
            range.ancestors[range.ancestors.length - 2]?.from ?? null,
          );
        return true;
      },
    });
    this.plugin.addCommand({
      id: "zoom-reset",
      name: "Show whole note",
      icon: "maximize",
      editorCheckCallback: (checking, editor) => {
        const view = new MyEditor(editor).getCodeMirrorView();
        if (!this.zoom.range(view.state)) return false;
        if (!checking) this.navigate(view, null);
        return true;
      },
    });
  }

  async unload() {}

  private navigate(view: EditorView, from: number | null) {
    const effects: StateEffect<unknown>[] = [setListZoom.of(from)];
    if (from !== null) {
      if (!this.zoom.range(view.state))
        this.snapshots.set(view, view.scrollSnapshot());
      const range = this.zoom.resolve(view.state, from);
      if (!range) return;
      // Reveal ancestors as well as a folded focused root before narrowing.
      foldedRanges(view.state).between(0, range.to, (a, b) => {
        if (a <= from && b > from)
          effects.push(unfoldEffect.of({ from: a, to: b }));
        else if (view.state.doc.lineAt(a).from === from)
          effects.push(unfoldEffect.of({ from: a, to: b }));
      });
      effects.push(
        EditorView.scrollIntoView(from + range.indent.length, { y: "start" }),
      );
      view.dispatch({
        effects,
        selection: {
          anchor: Math.min(range.to, from + range.indent.length + 2),
        },
      });
    } else {
      const snapshot = this.snapshots.get(view);
      if (snapshot) effects.push(snapshot);
      this.snapshots.delete(view);
      view.dispatch({ effects });
    }
    view.focus();
  }

  private panel = (view: EditorView): Panel => {
    const dom = getObsidianDomWindow(view.dom.ownerDocument).createDiv();
    dom.classList.add("bullet-zoom-breadcrumbs");
    dom.setAttribute("role", "navigation");
    dom.setAttribute("aria-label", "List zoom");
    const render = () => {
      dom.replaceChildren();
      const range = this.zoom.range(view.state);
      const items = [
        { from: null, label: "Whole note" },
        ...(range?.ancestors ?? []),
      ];
      for (const [index, item] of items.entries()) {
        if (index) dom.createSpan({ text: "›", cls: "bullet-zoom-separator" });
        const button = dom.createEl("button", { text: item.label });
        button.title = item.label;
        if (index === items.length - 1)
          button.setAttribute("aria-current", "location");
        button.addEventListener("click", () => this.navigate(view, item.from));
      }
    };
    render();
    return {
      dom,
      top: true,
      update: (update: ViewUpdate) => {
        const snapshot = this.snapshots.get(view);
        if (snapshot && update.docChanged) {
          const mapped = snapshot.map(update.changes);
          if (mapped) this.snapshots.set(view, mapped);
        }
        if (
          update.startState.field(this.zoom.field) !==
          update.state.field(this.zoom.field)
        )
          render();
      },
    };
  };
}
