import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/** Owns pointer arbitration and the pane-local presentation of zoom. */
export class ListZoomInteraction {
  private start: {
    x: number;
    y: number;
    from: number;
    state: EditorState;
  } | null = null;
  private container: Element | null;

  constructor(
    private view: EditorView,
    private isZoomed: () => boolean,
    private navigate: (from: number) => void,
  ) {
    this.container = view.dom.closest(".markdown-source-view");
    view.contentDOM.addEventListener("pointerdown", this.down, {
      capture: true,
    });
    view.contentDOM.addEventListener("click", this.click, { capture: true });
    view.dom.ownerDocument.addEventListener("pointermove", this.move, {
      capture: true,
    });
    view.dom.ownerDocument.addEventListener("pointercancel", this.cancel, {
      capture: true,
    });
    this.update();
  }

  update() {
    this.container?.classList.toggle("bullet-zoom-active", this.isZoomed());
  }

  destroy() {
    this.view.contentDOM.removeEventListener("pointerdown", this.down, {
      capture: true,
    });
    this.view.contentDOM.removeEventListener("click", this.click, {
      capture: true,
    });
    this.view.dom.ownerDocument.removeEventListener("pointermove", this.move, {
      capture: true,
    });
    this.view.dom.ownerDocument.removeEventListener(
      "pointercancel",
      this.cancel,
      { capture: true },
    );
    this.container?.classList.remove("bullet-zoom-active");
    this.start = null;
  }

  private bullet(event: Event) {
    const element = event.target as HTMLElement | null;
    if (element?.closest?.(".task-list-item-checkbox, .collapse-indicator"))
      return null;
    const bullet = element?.closest?.(".cm-formatting-list, .list-bullet");
    return bullet && this.view.contentDOM.contains(bullet) ? bullet : null;
  }

  private down = (event: PointerEvent) => {
    this.start = null;
    if (
      event.button !== 0 ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    )
      return;
    const bullet = this.bullet(event);
    if (!bullet) return;
    const from = this.view.posAtDOM(bullet, 0);
    this.start = {
      x: event.clientX,
      y: event.clientY,
      from,
      state: this.view.state,
    };
  };

  private move = (event: PointerEvent) => {
    if (
      this.start &&
      Math.hypot(event.clientX - this.start.x, event.clientY - this.start.y) >=
        6
    )
      this.start = null;
  };

  private cancel = () => {
    this.start = null;
  };

  private click = (event: MouseEvent) => {
    const start = this.start;
    this.start = null;
    if (
      !start ||
      !this.bullet(event) ||
      start.state.doc !== this.view.state.doc ||
      Math.hypot(event.clientX - start.x, event.clientY - start.y) >= 6
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    this.navigate(start.from);
  };
}
