import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

export function foldScrollReserveHeight(view: EditorView): number {
  return (
    view.scrollDOM.clientHeight -
    view.defaultLineHeight -
    view.documentPadding.top -
    0.5
  );
}

export function ensureFoldScrollReserve(view: EditorView): void {
  const expected = foldScrollReserveHeight(view);
  const current = Number.parseFloat(view.contentDOM.style.paddingBottom);
  if (
    Number.isFinite(expected) &&
    expected >= 0 &&
    (!Number.isFinite(current) || current < expected)
  ) {
    view.contentDOM.style.paddingBottom = `${expected}px`;
  }
}

function correctFoldScrollSnapshotAnchor(
  view: EditorView,
  value: unknown,
): void {
  if (
    !value ||
    typeof value !== "object" ||
    !("range" in value) ||
    !("yMargin" in value) ||
    typeof value.yMargin !== "number"
  ) {
    return;
  }

  const scaleY = view.scaleY;
  const scrollTop = view.scrollDOM.scrollTop;
  const scrollViewportTop = view.scrollDOM.getBoundingClientRect().top;
  const documentTop = view.documentTop;
  if (
    !Number.isFinite(scaleY) ||
    scaleY <= 0 ||
    !Number.isFinite(scrollTop) ||
    !Number.isFinite(scrollViewportTop) ||
    !Number.isFinite(documentTop)
  ) {
    return;
  }

  const viewportDocumentTop = scrollViewportTop - documentTop;
  const anchor = view.lineBlockAtHeight(Math.max(0, viewportDocumentTop + 8));
  if (!Number.isFinite(anchor.from) || !Number.isFinite(anchor.top)) {
    return;
  }

  value.range = EditorSelection.cursor(anchor.from);
  value.yMargin = anchor.top - scrollTop;
}

export function stableFoldScrollSnapshot(view: EditorView) {
  const snapshot = view.scrollSnapshot();
  const value: unknown = snapshot.value;
  correctFoldScrollSnapshotAnchor(view, value);
  if (
    !value ||
    typeof value !== "object" ||
    !("yMargin" in value) ||
    typeof value.yMargin !== "number" ||
    !Number.isFinite(value.yMargin)
  ) {
    return snapshot;
  }

  const window = view.dom.ownerDocument.defaultView;
  const devicePixelRatio = window?.devicePixelRatio ?? 1;
  const pixelScale =
    Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
      ? devicePixelRatio
      : 1;
  // Keep repeated fold cycles on the physical-pixel grid.
  value.yMargin = Math.round(value.yMargin * pixelScale) / pixelScale;
  return snapshot;
}
