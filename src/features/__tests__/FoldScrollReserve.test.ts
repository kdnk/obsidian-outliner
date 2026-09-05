import { FoldScrollReservePluginValue } from "../FoldScrollReserve";

function makeView() {
  const properties = new Map<string, string>();
  const classes = new Set<string>();
  const measurements: Array<{ read(): number; write(value: number): void }> =
    [];
  const view = {
    scrollDOM: { clientHeight: 544 },
    defaultLineHeight: 24,
    documentPadding: { top: 0 },
    dom: {
      style: {
        setProperty: (key: string, value: string) => properties.set(key, value),
        removeProperty: (key: string) => properties.delete(key),
      },
      classList: {
        add: (key: string) => classes.add(key),
        remove: (key: string) => classes.delete(key),
      },
    },
    requestMeasure: (request: (typeof measurements)[number]) =>
      measurements.push(request),
  };
  const flush = () => {
    for (const request of measurements.splice(0)) request.write(request.read());
  };
  return { view, properties, classes, flush };
}

describe("fold scroll reserve", () => {
  test("publishes the standard reserve outside Obsidian's content style", () => {
    const { view, properties, classes, flush } = makeView();
    new FoldScrollReservePluginValue(view as never);
    expect(classes.size).toBe(0);
    flush();
    expect(properties.get("--bullet-fold-scroll-reserve")).toBe("519.5px");
    expect(classes.has("bullet-plugin-fold-scroll-reserve")).toBe(true);
  });

  test("tracks editor height changes including a smaller split pane", () => {
    const { view, properties, flush } = makeView();
    const plugin = new FoldScrollReservePluginValue(view as never);
    flush();
    view.scrollDOM.clientHeight = 300;
    plugin.update({ geometryChanged: true } as never);
    flush();
    expect(properties.get("--bullet-fold-scroll-reserve")).toBe("275.5px");
  });

  test("does not leave a reserve when disabled during a pending measurement", () => {
    const { view, properties, classes, flush } = makeView();
    const plugin = new FoldScrollReservePluginValue(view as never);
    flush();
    plugin.update({ geometryChanged: true } as never);
    plugin.destroy();
    flush();
    expect(properties.size).toBe(0);
    expect(classes.size).toBe(0);
  });
});
