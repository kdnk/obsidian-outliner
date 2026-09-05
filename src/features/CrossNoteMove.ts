import {
  invertedEffects,
  isolateHistory,
  redo,
  undo,
} from "@codemirror/commands";
import {
  ChangeDesc,
  EditorState,
  StateEffect,
  Text,
  Transaction,
  TransactionSpec,
} from "@codemirror/state";
import { ViewPlugin } from "@codemirror/view";

interface MoveEditor {
  state: EditorState;
  dispatch: (transaction: Transaction) => void;
}

interface MovePair {
  source: MoveEditor;
  target: MoveEditor;
  sourceBefore: Text;
  targetBefore: Text;
  sourceAfter: Text;
  targetAfter: Text;
  available: () => boolean;
  onRejected: () => void;
}

const linkedMove = StateEffect.define<{ pair: MovePair; applied: boolean }>();
let coordinating = false;
interface DispatchGate {
  allowed?: Transaction;
  timeline: Transaction[];
  pending: Array<{ editor: MoveEditor; transaction: Transaction }>;
}
const dispatchGates = new WeakMap<MoveEditor, DispatchGate>();

// A listener in the first editor may synchronously dispatch into the second.
// Hold those updates until both halves exist, then map them through the move.
function dispatchPaired(
  first: MoveEditor,
  firstTr: Transaction,
  second: MoveEditor,
  secondTr: Transaction,
) {
  const pending: DispatchGate["pending"] = [];
  const firstGate: DispatchGate = { timeline: [], pending };
  const secondGate: DispatchGate = { timeline: [], pending };
  dispatchGates.set(first, firstGate);
  dispatchGates.set(second, secondGate);
  const dispatch = (editor: MoveEditor, tr: Transaction) => {
    const gate = dispatchGates.get(editor)!;
    gate.allowed = tr;
    try {
      editor.dispatch(tr);
    } catch (error) {
      if (editor.state !== tr.state) throw error;
    }
  };
  let committed = false;
  try {
    try {
      dispatch(first, firstTr);
      const pair = firstTr.effects.find((effect) => effect.is(linkedMove))
        ?.value.pair;
      if (second.state !== secondTr.startState || (pair && !pair.available()))
        throw new Error("Editor changed during paired dispatch");
      dispatch(second, secondTr);
      committed = true;
    } catch {
      // Only invert our exact first transaction. Never restore a document
      // snapshot over another editor's intervening changes.
      if (first.state === firstTr.state) {
        let rollback: Transaction | undefined;
        (firstTr.isUserEvent("undo") ? redo : undo)({
          state: first.state,
          dispatch: (tr) => {
            rollback = tr;
          },
        });
        if (rollback?.newDoc.eq(firstTr.startState.doc))
          dispatch(first, rollback);
      }
    }
    while (pending.length) {
      const { editor, transaction } = pending.shift()!;
      const gate = dispatchGates.get(editor)!;
      let state = transaction.startState;
      let mapping: ChangeDesc = state.changes([]);
      for (const step of gate.timeline) {
        if (step.startState !== state) continue;
        mapping = mapping.composeDesc(step.changes);
        state = step.state;
      }
      if (state !== editor.state)
        throw new Error("Cannot map a deferred editor update");
      const afterMapping = mapping.mapDesc(transaction.changes);
      const userEvent = transaction.annotation(Transaction.userEvent);
      dispatch(
        editor,
        editor.state.update({
          changes: transaction.changes.map(mapping),
          selection: transaction.selection?.map(afterMapping),
          effects: StateEffect.mapEffects(transaction.effects, afterMapping),
          annotations: [
            isolateHistory.of("full"),
            Transaction.addToHistory.of(
              transaction.annotation(Transaction.addToHistory) !== false,
            ),
            ...(userEvent ? [Transaction.userEvent.of(userEvent)] : []),
          ],
          scrollIntoView: transaction.scrollIntoView,
        }),
      );
    }
  } finally {
    dispatchGates.delete(first);
    dispatchGates.delete(second);
  }
  return committed;
}

/** Native history carries the link, so unrelated edits keep their own undo steps. */
export const crossNoteHistory = [
  invertedEffects.of((tr) =>
    tr.effects
      .filter((effect) => effect.is(linkedMove))
      .map((effect) =>
        linkedMove.of({
          pair: effect.value.pair,
          applied: !effect.value.applied,
        }),
      ),
  ),
  ViewPlugin.define((view) => {
    const restore = coordinateCrossNoteHistory(view);
    return { destroy: restore };
  }),
];

export function coordinateCrossNoteHistory(editor: MoveEditor) {
  const original = editor.dispatch;
  const coordinated: typeof original = (...args) => {
    const first: unknown = args[0];
    const transactions: readonly Transaction[] =
      first instanceof Transaction
        ? [first]
        : Array.isArray(first)
          ? (first as readonly Transaction[])
          : [];
    const gate = dispatchGates.get(editor);
    if (gate) {
      if (first === gate.allowed) {
        gate.allowed = undefined;
        try {
          Reflect.apply(original, editor, args);
        } finally {
          if (editor.state === (first as Transaction).state)
            gate.timeline.push(first as Transaction);
        }
      } else {
        const deferred = transactions.length
          ? transactions
          : [editor.state.update(...(args as unknown as TransactionSpec[]))];
        for (const transaction of deferred) {
          // A nested history command cannot be replayed as an ordinary edit.
          if (
            transaction.isUserEvent("undo") ||
            transaction.isUserEvent("redo")
          )
            continue;
          gate.pending.push({ editor, transaction });
        }
      }
      return;
    }
    // Batch history is not emitted by native commands. Reject a linked batch
    // rather than risk applying only some of its paired operations.
    if (
      transactions.length > 1 &&
      transactions.some((tr: Transaction) =>
        tr.effects.some((effect) => effect.is(linkedMove)),
      )
    )
      return;
    if (transactions.every((tr: Transaction) => allowHistory(tr)))
      Reflect.apply(original, editor, args);
  };
  editor.dispatch = coordinated;
  return () => {
    if (editor.dispatch === coordinated) editor.dispatch = original;
  };
}

function allowHistory(tr: Transaction): boolean {
  if (coordinating || !(tr.isUserEvent("undo") || tr.isUserEvent("redo")))
    return true;
  const link = tr.effects.find((effect) => effect.is(linkedMove));
  if (!link) return true;
  const { pair, applied } = link.value;
  const own = pair.source.state === tr.startState ? pair.source : pair.target;
  const other = own === pair.source ? pair.target : pair.source;
  if (
    !pair.available() ||
    own.state !== tr.startState ||
    pair.source.state.readOnly ||
    pair.target.state.readOnly
  )
    return rejectHistory(pair);
  const ownBefore = own === pair.source ? pair.sourceBefore : pair.targetBefore;
  const ownAfter = own === pair.source ? pair.sourceAfter : pair.targetAfter;
  const otherBefore =
    other === pair.source ? pair.sourceBefore : pair.targetBefore;
  const otherAfter =
    other === pair.source ? pair.sourceAfter : pair.targetAfter;
  if (
    !tr.startState.doc.eq(applied ? ownBefore : ownAfter) ||
    !tr.newDoc.eq(applied ? ownAfter : ownBefore) ||
    !other.state.doc.eq(applied ? otherBefore : otherAfter)
  )
    return rejectHistory(pair);
  let partner: Transaction | undefined;
  coordinating = true;
  try {
    (applied ? redo : undo)({
      state: other.state,
      dispatch: (candidate) => {
        partner = candidate;
      },
    });
    const partnerLink = partner?.effects.find((effect) =>
      effect.is(linkedMove),
    );
    if (
      !partner ||
      partnerLink?.value.pair !== pair ||
      partnerLink.value.applied !== applied ||
      !partner.newDoc.eq(applied ? otherAfter : otherBefore)
    )
      return rejectHistory(pair);
    if (!dispatchPaired(other, partner, own, tr)) return rejectHistory(pair);
    return false;
  } finally {
    coordinating = false;
  }
}

function rejectHistory(pair: MovePair): false {
  pair.onRejected();
  return false;
}

/** A prepared move uses immutable snapshots and preflights both editors' filters. */
export class CrossNoteMove {
  private sourceDoc: Text;
  private targetDoc: Text;

  constructor(
    private source: MoveEditor,
    private target: MoveEditor,
    private range: { from: number; to: number },
    private insertion: number,
    private indent: string,
    private available: () => boolean = () => true,
    private onRejected: () => void = () => {},
  ) {
    this.sourceDoc = source.state.doc;
    this.targetDoc = target.state.doc;
  }

  apply(): boolean {
    const { source, target, range, insertion, sourceDoc, targetDoc } = this;
    if (
      source === target ||
      !this.available() ||
      source.state.readOnly ||
      target.state.readOnly ||
      source.state.doc !== sourceDoc ||
      target.state.doc !== targetDoc ||
      range.from < 0 ||
      range.to > sourceDoc.length ||
      range.from >= range.to ||
      insertion < 0 ||
      insertion > targetDoc.length
    )
      return false;
    const original = sourceDoc.sliceString(range.from, range.to);
    const base = original.match(/^[\t ]*/)?.[0] ?? "";
    const branch = original
      .split("\n")
      .map((line) =>
        line.startsWith(base) ? this.indent + line.slice(base.length) : line,
      )
      .join("\n");
    const before = targetDoc.sliceString(0, insertion);
    const after = targetDoc.sliceString(insertion);
    const prefix = before && !before.endsWith("\n") ? "\n" : "";
    const insert = prefix + branch + (after ? "\n" : "");
    let from = range.from;
    let to = range.to;
    if (to < sourceDoc.length && sourceDoc.sliceString(to, to + 1) === "\n")
      to++;
    else if (from > 0 && sourceDoc.sliceString(from - 1, from) === "\n") from--;
    const sourceChanges = { from, to, insert: "" };
    const targetChanges = { from: insertion, insert };
    const sourceAfter = source.state.changes(sourceChanges).apply(sourceDoc);
    const targetAfter = target.state.changes(targetChanges).apply(targetDoc);
    const pair: MovePair = {
      source,
      target,
      sourceBefore: sourceDoc,
      targetBefore: targetDoc,
      sourceAfter,
      targetAfter,
      available: this.available,
      onRejected: this.onRejected,
    };
    const common = {
      effects: linkedMove.of({ pair, applied: true }),
      annotations: isolateHistory.of("full"),
      userEvent: "move.drop",
    };
    const sourceTransaction = source.state.update({
      ...common,
      changes: sourceChanges,
    });
    const bodyStart =
      branch.match(/^[\t ]*(?:[-*+]|\d+\.)(?:[ \t](?:\[[^[\]]\][ \t])?)?/)?.[0]
        .length ?? this.indent.length;
    const targetTransaction = target.state.update({
      ...common,
      changes: targetChanges,
      selection: { anchor: insertion + prefix.length + bodyStart },
    });
    if (
      !sourceTransaction.newDoc.eq(sourceAfter) ||
      !targetTransaction.newDoc.eq(targetAfter) ||
      [sourceTransaction, targetTransaction].some(
        (tr) =>
          !tr.effects.some(
            (effect) => effect.is(linkedMove) && effect.value.pair === pair,
          ) ||
          tr.annotation(Transaction.addToHistory) === false ||
          tr.annotation(isolateHistory) !== "full",
      )
    )
      return false;
    return dispatchPaired(target, targetTransaction, source, sourceTransaction);
  }
}
