import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { ListZoomInteraction } from "../ListZoomInteraction";

function setup() {
  const owner = new EventTarget();
  const content = new EventTarget();
  const classes = new Set<string>();
  const container = {
    classList: {
      toggle: (s: string, on: boolean) =>
        on ? classes.add(s) : classes.delete(s),
      remove: (s: string) => classes.delete(s),
    },
  };
  const bullet = {
    closest: (s: string): unknown =>
      s === ".cm-formatting-list, .list-bullet" ? bullet : null,
  };
  const view = {
    state: EditorState.create({ doc: "- item\n- other" }),
    dom: { ownerDocument: owner, closest: () => container },
    contentDOM: Object.assign(content, { contains: () => true }),
    posAtDOM: () => 0,
  };
  let active = false;
  const navigated: number[] = [];
  const interaction = new ListZoomInteraction(
    view as unknown as EditorView,
    () => active,
    (from) => navigated.push(from),
  );
  function event(type: string, x = 0, target: unknown = bullet) {
    const e = new Event(type, { cancelable: true });
    Object.defineProperties(e, {
      target: { value: target },
      button: { value: 0 },
      clientX: { value: x },
      clientY: { value: 0 },
      detail: { value: 1 },
    });
    (type === "pointermove" ? owner : content).dispatchEvent(e);
    return e;
  }
  return {
    event,
    navigated,
    interaction,
    classes,
    activate: () => {
      active = true;
      interaction.update();
    },
  };
}

test("a bullet click navigates to that item and consumes native click", () => {
  const s = setup();
  s.event("pointerdown");
  const click = s.event("click");
  expect(s.navigated).toEqual([0]);
  expect(click.defaultPrevented).toBe(true);
  s.interaction.destroy();
});

test("a drag returning to its origin must not zoom on release", () => {
  const s = setup();
  s.event("pointerdown");
  s.event("pointermove", 20);
  s.event("pointermove", 0);
  s.event("click");
  expect(s.navigated).toEqual([]);
  s.interaction.destroy();
});

test("checkbox and chevron clicks retain their native behavior", () => {
  const s = setup();
  const target = { closest: () => null };
  s.event("pointerdown", 0, target);
  const click = s.event("click", 0, target);
  expect(s.navigated).toEqual([]);
  expect(click.defaultPrevented).toBe(false);
  s.interaction.destroy();
});

test("zoom visibility is scoped to its pane and removed on teardown", () => {
  const a = setup();
  const b = setup();
  a.activate();
  expect(a.classes.has("bullet-zoom-active")).toBe(true);
  expect(b.classes.size).toBe(0);
  a.interaction.destroy();
  expect(a.classes.size).toBe(0);
  a.event("pointerdown");
  a.event("click");
  expect(a.navigated).toEqual([]);
  b.interaction.destroy();
});
