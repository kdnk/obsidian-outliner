import {
  EditorView,
  PluginValue,
  ViewPlugin,
  ViewUpdate,
  scrollPastEnd,
} from "@codemirror/view";

import { foldScrollReserveHeight } from "./FoldScroll";

const RESERVE_CLASS = "bullet-plugin-fold-scroll-reserve";
const RESERVE_PROPERTY = "--bullet-fold-scroll-reserve";

export class FoldScrollReservePluginValue implements PluginValue {
  private destroyed = false;

  private measure = {
    read: () => foldScrollReserveHeight(this.view),
    write: (height: number) => {
      if (this.destroyed || !Number.isFinite(height) || height < 0) return;
      this.view.dom.style.setProperty(RESERVE_PROPERTY, `${height}px`);
      this.view.dom.classList.add(RESERVE_CLASS);
    },
  };

  constructor(private view: EditorView) {
    view.requestMeasure(this.measure);
  }

  update(update: ViewUpdate) {
    if (update.geometryChanged) this.view.requestMeasure(this.measure);
  }

  destroy() {
    this.destroyed = true;
    this.view.dom.classList.remove(RESERVE_CLASS);
    this.view.dom.style.removeProperty(RESERVE_PROPERTY);
  }
}

export function foldScrollReserve() {
  return [
    scrollPastEnd(),
    ViewPlugin.fromClass(FoldScrollReservePluginValue),
    EditorView.baseTheme({
      // Obsidian writes an inline 100px padding on resize. Keep the standard
      // reserve in CSS so that write cannot clamp the scroll position first.
      [`&.${RESERVE_CLASS} .cm-content`]: {
        paddingBottom: `var(${RESERVE_PROPERTY}) !important`,
      },
    }),
  ];
}
