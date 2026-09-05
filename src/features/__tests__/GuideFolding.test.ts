import {
  foldEffect,
  foldable,
  foldedRanges,
  unfoldEffect,
} from "@codemirror/language";
import { EditorSelection, Text } from "@codemirror/state";
import { Decoration, DecorationSet } from "@codemirror/view";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  makeEditor,
  makeLogger,
  makeRoot,
  makeSettings,
} from "../../__mocks__";
import { Parser, Reader } from "../../services/Parser";
import { Settings } from "../../services/Settings";
import { GuideFoldingPluginValue } from "../GuideFolding";

type ExtraGuideFoldingInterfaceKeys = Exclude<
  keyof GuideFoldingPluginValue,
  "decorations" | "update" | "destroy"
>;

const guideFoldingInterfaceIsClosed: ExtraGuideFoldingInterfaceKeys extends never
  ? true
  : false = true;

const mockGetEditorFromState = jest.fn<unknown, unknown[]>();

jest.mock(
  "../../editor",
  () => ({
    getEditorFromState: (...args: unknown[]) => {
      return mockGetEditorFromState(...args);
    },
  }),
  { virtual: true },
);

jest.mock("@codemirror/language", () => ({
  foldEffect: { of: jest.fn() },
  foldable: jest.fn(),
  foldedRanges: jest.fn(() => ({
    between: jest.fn(),
  })),
  unfoldEffect: { of: jest.fn() },
}));

function makeClassList() {
  const values = new Set<string>();

  return {
    add: jest.fn((...classes: string[]) => {
      for (const className of classes) {
        values.add(className);
      }
    }),
    remove: jest.fn((...classes: string[]) => {
      for (const className of classes) {
        values.delete(className);
      }
    }),
    contains: (value: string) => values.has(value),
  };
}

function makeGuideElement(
  classes: string[],
  options: { insideListIndent?: boolean } = {},
) {
  const classList = makeClassList();
  classList.add(...classes);

  return {
    classList,
    insideListIndent: options.insideListIndent ?? true,
  };
}

function makeGuideDOM(elements: Array<ReturnType<typeof makeGuideElement>>) {
  const querySelectorAll = jest.fn((selector: string) => {
    if (
      selector === ".cm-hmd-list-indent > .cm-indent-spacing:not(.cm-indent)"
    ) {
      return elements.filter(
        (element) =>
          element.insideListIndent &&
          element.classList.contains("cm-indent-spacing") &&
          !element.classList.contains("cm-indent"),
      );
    }

    if (selector === ".bullet-plugin-persistent-indent-guide") {
      return elements.filter((element) =>
        element.classList.contains("bullet-plugin-persistent-indent-guide"),
      );
    }

    if (selector === ".bullet-plugin-hovered-indent-guide") {
      return elements.filter((element) =>
        element.classList.contains("bullet-plugin-hovered-indent-guide"),
      );
    }

    if (selector === ".bullet-plugin-hovered-indent-guide-start") {
      return elements.filter((element) =>
        element.classList.contains("bullet-plugin-hovered-indent-guide-start"),
      );
    }

    if (selector === ".bullet-plugin-hovered-indent-guide-end") {
      return elements.filter((element) =>
        element.classList.contains("bullet-plugin-hovered-indent-guide-end"),
      );
    }

    return [];
  });

  return {
    contentDOM: {
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      querySelectorAll,
    },
    elements,
    querySelectorAll,
  };
}
function makeFoldEditor() {
  return {
    lastLine: jest.fn().mockReturnValue(9),
    getLine: jest.fn().mockReturnValue(""),
  };
}

function makeGuideLine(
  indentSegments: string[] = ["  "],
  options: {
    guideRects?: Array<{ left: number; right: number }>;
    livePreview?: boolean;
    mobile?: boolean;
  } = {},
) {
  const editorRoot = {};
  let guides: Array<{
    textContent: string;
    parentElement: typeof indentContainer;
    classList: ReturnType<typeof makeClassList>;
    matches: jest.Mock;
    closest: jest.Mock;
    getBoundingClientRect: jest.Mock;
  }> = [];
  const line = {
    ownerDocument: {
      body: {
        classList: {
          contains: (className: string) =>
            className === "is-mobile" && options.mobile !== false,
        },
      },
    },
    matches: jest.fn((selector: string) => selector === ".cm-line"),
    closest: jest.fn(),
    querySelectorAll: jest.fn((selector: string) =>
      selector === ".cm-hmd-list-indent > .cm-indent" ? guides : [],
    ),
  };
  line.closest.mockImplementation((selector: string) => {
    if (selector === ".cm-line") return line;
    if (selector === ".markdown-source-view.mod-cm6.is-live-preview") {
      return options.livePreview === false ? null : editorRoot;
    }
    return null;
  });
  const indentContainer = {
    matches: jest.fn((selector: string) => selector === ".cm-hmd-list-indent"),
    childNodes: [] as Array<{ textContent: string | null }>,
  };
  guides = indentSegments.map((textContent, index) => ({
    textContent,
    parentElement: indentContainer,
    classList: makeClassList(),
    matches: jest.fn((selector: string) => selector === ".cm-indent"),
    closest: jest.fn((selector: string) =>
      selector === ".cm-line" ? line : null,
    ),
    getBoundingClientRect: jest.fn(() => ({
      left: options.guideRects?.[index]?.left ?? index * 36,
      right: options.guideRects?.[index]?.right ?? (index + 1) * 36,
    })),
  }));
  indentContainer.childNodes.push(...guides);

  return { guides, indentContainer, line };
}

type HoverMeasurement = {
  indentGuides: Element[];
  outerGuides: Element[];
};

type MeasureRequest = {
  read?: () => HoverMeasurement;
  write?: (measurement: HoverMeasurement) => void;
};

function makeHoverFixture(options: {
  editor: ReturnType<typeof makeEditor>;
  root: ReturnType<typeof makeRoot>;
  hoveredGuide: ReturnType<typeof makeGuideLine>["guides"][number];
  candidates: Array<ReturnType<typeof makeGuideLine>["guides"][number]>;
  lineByElement: Map<unknown, number>;
}) {
  type CapturedListener = (event: Event) => void;
  const addEventListener = jest.fn<void, [string, CapturedListener, boolean]>();
  const querySelector = jest.fn((selector: string) =>
    selector ===
    ".cm-indent:hover, .cm-hmd-list-indent > .cm-indent-spacing:hover"
      ? options.hoveredGuide
      : null,
  );
  const querySelectorAll = jest.fn((selector: string) => {
    if (
      selector ===
      ".cm-hmd-list-indent > .cm-indent, .cm-hmd-list-indent > .cm-indent-spacing"
    ) {
      return options.candidates;
    }
    if (selector === ".bullet-plugin-hovered-indent-guide") {
      return options.candidates.filter((guide) =>
        guide.classList.contains("bullet-plugin-hovered-indent-guide"),
      );
    }
    if (selector === ".bullet-plugin-hovered-indent-guide-start") {
      return options.candidates.filter((guide) =>
        guide.classList.contains("bullet-plugin-hovered-indent-guide-start"),
      );
    }
    if (selector === ".bullet-plugin-hovered-indent-guide-end") {
      return options.candidates.filter((guide) =>
        guide.classList.contains("bullet-plugin-hovered-indent-guide-end"),
      );
    }
    return [];
  });
  const contentDOM = {
    addEventListener,
    removeEventListener: jest.fn(),
    querySelector,
    querySelectorAll,
  };
  const requests: MeasureRequest[] = [];
  const view = {
    contentDOM,
    state: {
      doc: {
        lineAt: jest.fn((offset: number) => ({ number: offset + 1 })),
      },
    },
    posAtDOM: jest.fn((element: unknown) => {
      const line = options.lineByElement.get(element);
      if (line === undefined) {
        throw new Error("Expected a mapped line element");
      }
      return line;
    }),
    requestMeasure: jest.fn((request: MeasureRequest) => {
      requests.push(request);
    }),
  };
  const settings = {
    verticalLinesAction: "toggle-folding",
    onChange: jest.fn(),
    removeCallback: jest.fn(),
  };
  mockGetEditorFromState.mockReturnValue(options.editor);
  const PluginValueWithView = GuideFoldingPluginValue as unknown as new (
    settings: unknown,
    parser: unknown,
    view: unknown,
  ) => { destroy(): void };
  const pluginValue = new PluginValueWithView(
    settings,
    { parse: jest.fn().mockReturnValue(options.root) },
    view,
  );

  return {
    addEventListener,
    pluginValue,
    requests,
  };
}

test("exposes only the ViewPlugin lifecycle interface", () => {
  expect(guideFoldingInterfaceIsClosed).toBe(true);
});

test("keeps selected-guide state semantic rather than DOM-local", () => {
  const source = readFileSync(join(__dirname, "../GuideFolding.ts"), "utf8");

  expect(source).not.toContain("selectedIndentMarkerElements");
  expect(source).not.toContain("selectedOuterMarkerElements");
});

describe("GuideFoldingPluginValue hover measurement", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("groups only segments resolving to the same outer list", () => {
    const editor = makeEditor({
      text: [
        "- parent A",
        "    - child A",
        "        - leaf A",
        "- parent B",
        "    - child B",
        "        - leaf B",
      ].join("\n"),
      cursor: { line: 2, ch: 8 },
    });
    const root = makeRoot({ editor });
    const childA = makeGuideLine(["    "]);
    const leafA = makeGuideLine(["    ", "    "]);
    const childB = makeGuideLine(["    "]);
    const leafB = makeGuideLine(["    ", "    "]);
    const fixture = makeHoverFixture({
      editor,
      root,
      hoveredGuide: leafA.guides[0],
      candidates: [
        ...childA.guides,
        ...leafA.guides,
        ...childB.guides,
        ...leafB.guides,
      ],
      lineByElement: new Map([
        [childA.line, 1],
        [leafA.line, 2],
        [childB.line, 4],
        [leafB.line, 5],
      ]),
    });

    const measurement = fixture.requests[0]?.read?.();

    expect(measurement?.indentGuides).toEqual([
      childA.guides[0],
      leafA.guides[0],
    ]);
    fixture.pluginValue.destroy();
  });

  test("groups inner and persistent segments without adjacent outer guides", () => {
    const editor = makeEditor({
      text: [
        "- parent",
        "    - child",
        "        - branch alpha",
        "            - leaf alpha",
        "        - branch beta",
        "            - leaf beta",
        "    - outer sibling",
        "        - outer leaf",
      ].join("\n"),
      cursor: { line: 3, ch: 12 },
    });
    const root = makeRoot({ editor });
    const branchAlpha = makeGuideLine(["    ", "    "]);
    const leafAlpha = makeGuideLine(["    ", "    ", "    "]);
    const branchBeta = makeGuideLine(["    ", "    "]);
    const leafBeta = makeGuideLine(["    ", "    ", "    "]);
    branchBeta.guides[1]?.classList.add(
      "bullet-plugin-persistent-indent-guide",
    );
    const fixture = makeHoverFixture({
      editor,
      root,
      hoveredGuide: leafAlpha.guides[1],
      candidates: [
        ...branchAlpha.guides,
        ...leafAlpha.guides,
        ...branchBeta.guides,
        ...leafBeta.guides,
      ],
      lineByElement: new Map([
        [branchAlpha.line, 2],
        [leafAlpha.line, 3],
        [branchBeta.line, 4],
        [leafBeta.line, 5],
      ]),
    });

    const measurement = fixture.requests[0]?.read?.();

    expect(measurement?.indentGuides).toEqual([
      branchAlpha.guides[1],
      leafAlpha.guides[1],
      branchBeta.guides[1],
      leafBeta.guides[1],
    ]);
    if (!measurement) {
      throw new Error("Expected a hover measurement");
    }
    fixture.requests[0]?.write?.(measurement);

    const highlighted = measurement.indentGuides;
    expect(
      highlighted[0]?.classList.contains(
        "bullet-plugin-hovered-indent-guide-start",
      ),
    ).toBe(true);
    expect(
      highlighted[0]?.classList.contains(
        "bullet-plugin-hovered-indent-guide-end",
      ),
    ).toBe(false);
    for (const guide of highlighted.slice(1, -1)) {
      expect(
        guide.classList.contains("bullet-plugin-hovered-indent-guide-start"),
      ).toBe(false);
      expect(
        guide.classList.contains("bullet-plugin-hovered-indent-guide-end"),
      ).toBe(false);
    }
    expect(
      highlighted[highlighted.length - 1]?.classList.contains(
        "bullet-plugin-hovered-indent-guide-start",
      ),
    ).toBe(false);
    expect(
      highlighted[highlighted.length - 1]?.classList.contains(
        "bullet-plugin-hovered-indent-guide-end",
      ),
    ).toBe(true);
    fixture.pluginValue.destroy();
  });

  test("returns no group for an unmatched guide", () => {
    const editor = makeEditor({
      text: "  - parent\n      - child",
      cursor: { line: 1, ch: 6 },
    });
    const root = makeRoot({ editor });
    const child = makeGuideLine(["    "]);
    const fixture = makeHoverFixture({
      editor,
      root,
      hoveredGuide: child.guides[0],
      candidates: child.guides,
      lineByElement: new Map([[child.line, 1]]),
    });

    const measurement = fixture.requests[0]?.read?.();

    expect(measurement?.indentGuides).toEqual([]);
    fixture.pluginValue.destroy();
  });

  test("replaces the previous logical group and clears it on pointer leave", () => {
    const editor = makeEditor({
      text: "- parent A\n    - child A\n- parent B\n    - child B",
      cursor: { line: 1, ch: 4 },
    });
    const root = makeRoot({ editor });
    const selectedLine = makeGuideLine(["    "]);
    const staleLine = makeGuideLine(["    "]);
    const selected = selectedLine.guides[0];
    const stale = staleLine.guides[0];
    stale.classList.add(
      "bullet-plugin-hovered-indent-guide",
      "bullet-plugin-hovered-indent-guide-start",
      "bullet-plugin-hovered-indent-guide-end",
    );
    const fixture = makeHoverFixture({
      editor,
      root,
      hoveredGuide: selected,
      candidates: [selected, stale],
      lineByElement: new Map([
        [selectedLine.line, 1],
        [staleLine.line, 3],
      ]),
    });
    const measurement = fixture.requests[0]?.read?.();
    if (!measurement) {
      throw new Error("Expected a hover measurement");
    }

    fixture.requests[0]?.write?.(measurement);

    expect(stale.classList.contains("bullet-plugin-hovered-indent-guide")).toBe(
      false,
    );
    expect(
      selected.classList.contains("bullet-plugin-hovered-indent-guide"),
    ).toBe(true);
    expect(
      selected.classList.contains("bullet-plugin-hovered-indent-guide-start"),
    ).toBe(true);
    expect(
      selected.classList.contains("bullet-plugin-hovered-indent-guide-end"),
    ).toBe(true);
    expect(
      stale.classList.contains("bullet-plugin-hovered-indent-guide-start"),
    ).toBe(false);
    expect(
      stale.classList.contains("bullet-plugin-hovered-indent-guide-end"),
    ).toBe(false);

    const pointerLeave = fixture.addEventListener.mock.calls.find(
      ([eventName]) => eventName === "pointerleave",
    )?.[1];
    pointerLeave?.({} as Event);
    expect(
      selected.classList.contains("bullet-plugin-hovered-indent-guide"),
    ).toBe(false);
    expect(
      selected.classList.contains("bullet-plugin-hovered-indent-guide-start"),
    ).toBe(false);
    expect(
      selected.classList.contains("bullet-plugin-hovered-indent-guide-end"),
    ).toBe(false);
    fixture.pluginValue.destroy();
  });
});

describe("GuideFoldingPluginValue decorations", () => {
  function positions(decorations: ReturnType<typeof Decoration.set>) {
    const result: number[] = [];
    for (let cursor = decorations.iter(); cursor.value; cursor.next()) {
      result.push(cursor.from);
    }
    return result;
  }

  function makeFixture(
    text: string,
    visibility: { outerVerticalLines: boolean } = {
      outerVerticalLines: true,
    },
  ) {
    const settingsCallbacks: Array<() => void> = [];
    const settings = {
      ...visibility,
      verticalLinesAction: "none",
      onChange: jest.fn((keys: unknown, callback?: () => void) => {
        settingsCallbacks.push(callback ?? (keys as () => void));
      }),
      removeCallback: jest.fn(),
    };
    const contentDOM = {
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      querySelector: jest.fn().mockReturnValue(null),
      querySelectorAll: jest.fn().mockReturnValue([]),
    };
    const view = {
      state: { doc: Text.of(text.split("\n")) },
      contentDOM,
      dispatch: jest.fn(),
      requestMeasure: jest.fn(),
    };
    const parser = new Parser(makeLogger(), makeSettings());
    let editor = makeEditor({ text, cursor: { line: 0, ch: 0 } });
    mockGetEditorFromState.mockImplementation(() => editor);
    const PluginValueWithView = GuideFoldingPluginValue as unknown as new (
      settings: unknown,
      parser: unknown,
      view: unknown,
    ) => {
      decorations: ReturnType<typeof Decoration.set>;
      destroy(): void;
      update(update: unknown): void;
    };
    const pluginValue = new PluginValueWithView(settings, parser, view);

    return {
      pluginValue,
      settings,
      settingsCallback: settingsCallbacks[0],
      view,
      replaceText(nextText: string) {
        editor = makeEditor({ text: nextText, cursor: { line: 0, ch: 0 } });
        view.state.doc = Text.of(nextText.split("\n"));
      },
    };
  }

  function renderOuterSegments(decorations: DecorationSet) {
    const segments: Array<{
      className: string;
      dataset: Record<string, string>;
      setAttribute: jest.Mock;
    }> = [];

    for (let cursor = decorations.iter(); cursor.value; cursor.next()) {
      const element = {
        className: "",
        dataset: {} as Record<string, string>,
        setAttribute: jest.fn(),
      };
      const widget = (
        cursor.value.spec as {
          widget: {
            toDOM(view: unknown): typeof element;
            ignoreEvent(): boolean;
          };
        }
      ).widget;
      const createSpan = jest.fn(() => element);

      expect(
        widget.toDOM({
          dom: { ownerDocument: { win: { createSpan } } },
        }),
      ).toBe(element);
      expect(createSpan).toHaveBeenCalledTimes(1);
      expect(widget.ignoreEvent()).toBe(false);
      segments.push(element);
    }

    return segments;
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("ignores debug changes and synchronizes once for list-line actions", () => {
    const settings = new Settings({
      loadData: jest.fn(async () => ({}) as never),
      saveData: jest.fn(async () => undefined),
    });
    const onChange = jest.spyOn(settings, "onChange");
    const contentDOM = {
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      querySelector: jest.fn().mockReturnValue(null),
      querySelectorAll: jest.fn().mockReturnValue([]),
    };
    const view = {
      state: { doc: Text.of(["- parent"]) },
      contentDOM,
      dispatch: jest.fn(),
      requestMeasure: jest.fn(),
    };
    mockGetEditorFromState.mockReturnValue(
      makeEditor({ text: "- parent", cursor: { line: 0, ch: 0 } }),
    );
    const pluginValue = new GuideFoldingPluginValue(
      settings,
      {
        parseRange: jest.fn().mockReturnValue([]),
        isListItem: (line: string) => Parser.prototype.isListItem(line),
      } as never,
      view as never,
    );
    expect(onChange).toHaveBeenCalledWith(
      ["outerListLines", "listLineAction"],
      expect.any(Function),
    );
    view.requestMeasure.mockClear();
    view.dispatch.mockClear();

    settings.debug = true;

    expect(view.requestMeasure).not.toHaveBeenCalled();
    expect(view.dispatch).not.toHaveBeenCalled();

    settings.verticalLinesAction = "none";

    expect(view.requestMeasure).toHaveBeenCalledTimes(1);
    expect(view.dispatch).not.toHaveBeenCalled();
    pluginValue.destroy();
  });

  test("builds outer decorations while folding interaction is disabled", () => {
    const fixture = makeFixture("- parent\n    - child");

    expect(positions(fixture.pluginValue.decorations)).toEqual([0, 9]);
    fixture.pluginValue.destroy();
  });

  test.each([
    ["empty line", "- a\n    - child\n\n- b\n    - child"],
    ["spaces-only line", "- a\n    - child\n   \n- b\n    - child"],
    ["list-level blank line", "- a\n\t- child\n\t\n- b\n\t- child"],
    ["heading", "- a\n    - child\n# Heading\n- b\n    - child"],
    ["paragraph", "- a\n    - child\ntext\n- b\n    - child"],
  ])("splits outer decoration chunks at a %s", (_name, text) => {
    const fixture = makeFixture(text);

    expect(fixture.pluginValue.decorations.size).toBe(4);
    expect(
      renderOuterSegments(fixture.pluginValue.decorations).map(
        ({ dataset }) => [
          dataset.chunkId,
          dataset.chunkStart,
          dataset.chunkEnd,
        ],
      ),
    ).toEqual([
      ["0:1", "0", "1"],
      ["0:1", "0", "1"],
      ["3:4", "3", "4"],
      ["3:4", "3", "4"],
    ]);
    fixture.pluginValue.destroy();
  });

  test.each(["\t\t  ", "\t\t  \n\t\t  ", "\t\t    \n\t\t  "])(
    "keeps a whitespace-only note-line paragraph gap inside one chunk: %j",
    (gap) => {
      const lines = [
        "- a",
        "\t- child",
        "\t\t- grandchild",
        "\t\t  first paragraph",
        ...gap.split("\n"),
        "\t\t  second paragraph",
        "- sibling",
      ];
      const fixture = makeFixture(lines.join("\n"));

      expect(fixture.pluginValue.decorations.size).toBe(lines.length);
      expect(
        renderOuterSegments(fixture.pluginValue.decorations).map(
          ({ dataset }) => dataset.chunkId,
        ),
      ).toEqual(lines.map(() => `0:${lines.length - 1}`));
      fixture.pluginValue.destroy();
    },
  );

  test("keeps a base-indented paragraph gap after deeper fenced-code content in one chunk", () => {
    const lines = [
      "- a",
      "\t- child",
      "\t  ```plain text",
      "\t    code",
      "\t  ",
      "\t  ```",
      "- sibling",
    ];
    const fixture = makeFixture(lines.join("\n"));

    expect(
      renderOuterSegments(fixture.pluginValue.decorations).map(
        ({ dataset }) => dataset.chunkId,
      ),
    ).toEqual(lines.map(() => "0:6"));
    fixture.pluginValue.destroy();
  });

  test("renders preserved widget metadata and current chunk actionability", () => {
    const fixture = makeFixture(
      "- leaf A\n- leaf B\n\n- parent\n    continuation\n- sibling",
    );

    expect(fixture.pluginValue.decorations.size).toBe(5);
    const segments = renderOuterSegments(fixture.pluginValue.decorations);
    expect(
      segments.map(({ className, dataset }) => ({ className, dataset })),
    ).toEqual([
      {
        className: "bullet-plugin-outer-list-guide",
        dataset: {
          actionable: "false",
          chunkEnd: "1",
          chunkId: "0:1",
          chunkStart: "0",
        },
      },
      {
        className: "bullet-plugin-outer-list-guide",
        dataset: {
          actionable: "false",
          chunkEnd: "1",
          chunkId: "0:1",
          chunkStart: "0",
        },
      },
      ...Array.from({ length: 3 }, () => ({
        className: "bullet-plugin-outer-list-guide",
        dataset: {
          actionable: "true",
          chunkEnd: "5",
          chunkId: "3:5",
          chunkStart: "3",
        },
      })),
    ]);
    for (const segment of segments) {
      expect(segment.setAttribute).toHaveBeenCalledWith("aria-hidden", "true");
    }
    fixture.pluginValue.destroy();
  });

  test("builds no outer decorations when outer visibility is disabled", () => {
    const fixture = makeFixture("- parent\n    - child", {
      outerVerticalLines: false,
    });

    expect(fixture.pluginValue.decorations).toBe(Decoration.none);
    fixture.pluginValue.destroy();
  });

  test("rebuilds outer decorations at new line positions after a document change", () => {
    const fixture = makeFixture("- parent\n    - child");
    fixture.replaceText("# Heading\n- parent\n    - child");

    fixture.pluginValue.update({ docChanged: true });

    expect(positions(fixture.pluginValue.decorations)).toEqual([10, 19]);
    fixture.pluginValue.destroy();
  });

  test("refreshes decorations only when an outer visibility setting changes", () => {
    const fixture = makeFixture("- parent\n    - child");
    if (!fixture.settingsCallback) {
      throw new Error("Expected settings callback to be registered");
    }

    fixture.settings.outerVerticalLines = false;
    fixture.settingsCallback();

    expect(fixture.pluginValue.decorations).toBe(Decoration.none);
    expect(fixture.view.dispatch).toHaveBeenLastCalledWith({});

    fixture.settings.verticalLinesAction = "toggle-folding";
    fixture.settingsCallback();
    expect(fixture.view.dispatch).toHaveBeenCalledTimes(1);

    fixture.settings.outerVerticalLines = true;
    fixture.settingsCallback();
    expect(positions(fixture.pluginValue.decorations)).toEqual([0, 9]);
    expect(fixture.view.dispatch).toHaveBeenCalledTimes(2);
    fixture.pluginValue.destroy();
  });
});

describe("GuideFoldingPluginValue persistent guides", () => {
  test("promotes only unclaimed list indentation spacing spans", () => {
    const promoted = makeGuideElement(["cm-indent-spacing"]);
    const nativeGuide = makeGuideElement(["cm-indent-spacing", "cm-indent"]);
    const outsideListIndent = makeGuideElement(["cm-indent-spacing"], {
      insideListIndent: false,
    });
    const { contentDOM: guideDOM, querySelectorAll } = makeGuideDOM([
      promoted,
      nativeGuide,
      outsideListIndent,
    ]);
    const requests: Array<{
      write?: (measurement: unknown) => void;
    }> = [];
    const contentDOM = {
      ...guideDOM,
      querySelector: jest.fn().mockReturnValue(null),
    };
    const pluginValue = new GuideFoldingPluginValue(
      {
        verticalLinesAction: "toggle-folding",
        onChange: jest.fn(),
        removeCallback: jest.fn(),
      } as never,
      {} as never,
      {
        contentDOM,
        requestMeasure: jest.fn(
          (request: { write?: (measurement: unknown) => void }) =>
            requests.push(request),
        ),
      } as never,
    );

    requests[0]?.write?.(undefined);

    expect(querySelectorAll).toHaveBeenCalledWith(
      ".cm-hmd-list-indent > .cm-indent-spacing:not(.cm-indent)",
    );
    expect(promoted.classList.contains("cm-indent")).toBe(true);
    expect(
      promoted.classList.contains("bullet-plugin-persistent-indent-guide"),
    ).toBe(true);
    expect(nativeGuide.classList.contains("cm-indent")).toBe(true);
    expect(
      nativeGuide.classList.contains("bullet-plugin-persistent-indent-guide"),
    ).toBe(false);
    expect(outsideListIndent.classList.contains("cm-indent")).toBe(false);
    pluginValue.destroy();
  });

  test("removes both guide classes only from plugin-owned spans", () => {
    const promoted = makeGuideElement([
      "cm-indent-spacing",
      "cm-indent",
      "bullet-plugin-persistent-indent-guide",
    ]);
    const nativeGuide = makeGuideElement(["cm-indent-spacing", "cm-indent"]);
    const { contentDOM: guideDOM, querySelectorAll } = makeGuideDOM([
      promoted,
      nativeGuide,
    ]);
    const contentDOM = {
      ...guideDOM,
      querySelector: jest.fn().mockReturnValue(null),
    };
    const pluginValue = new GuideFoldingPluginValue(
      {
        verticalLinesAction: "none",
        onChange: jest.fn(),
        removeCallback: jest.fn(),
      } as never,
      {} as never,
      {
        contentDOM,
        requestMeasure: jest.fn(),
      } as never,
    );

    pluginValue.destroy();

    expect(querySelectorAll).toHaveBeenCalledWith(
      ".bullet-plugin-persistent-indent-guide",
    );
    expect(promoted.classList.contains("cm-indent-spacing")).toBe(true);
    expect(promoted.classList.contains("cm-indent")).toBe(false);
    expect(
      promoted.classList.contains("bullet-plugin-persistent-indent-guide"),
    ).toBe(false);
    expect(nativeGuide.classList.contains("cm-indent")).toBe(true);
  });
});

describe("GuideFolding persistent guide styles", () => {
  test("preserves promoted spacing layout with marker-scoped styles", () => {
    const styles = readFileSync(join(__dirname, "../../../styles.css"), "utf8");
    const declarations = styles.match(
      /\.markdown-source-view\.mod-cm6\s+\.cm-indent-spacing\.bullet-plugin-persistent-indent-guide\s*\{([^}]*)\}/,
    )?.[1];

    expect(declarations).toContain("min-width: 0;");
    expect(declarations).toContain("display: inline;");
  });

  test("stacks the promoted native guide above folded branch indicators", () => {
    const styles = readFileSync(join(__dirname, "../../../styles.css"), "utf8");
    const declarations = styles.match(
      /\.markdown-source-view\.mod-cm6\s+\.cm-indent-spacing\.bullet-plugin-persistent-indent-guide::before\s*\{([^}]*)\}/,
    )?.[1];

    expect(declarations?.trim()).toBe("z-index: 2;");
  });

  test("shows a pointer only for actionable vertical guides", () => {
    const styles = readFileSync(join(__dirname, "../../../styles.css"), "utf8");
    const declarations = styles.match(
      /\.bullet-plugin-vertical-lines-action-toggle-folding\s+\.markdown-source-view\.mod-cm6\s+\.cm-hmd-list-indent\s+\.cm-indent\s*\{([^}]*)\}/,
    )?.[1];

    expect(declarations?.trim()).toBe("cursor: pointer;");
    expect(styles).not.toMatch(
      /(?:^|\n)\.markdown-source-view\.mod-cm6\s+\.cm-hmd-list-indent\s+\.cm-indent\s*\{[^}]*cursor:\s*pointer/,
    );
  });

  test("shows desktop list chevrons only on row hover at the Logseq spacing", () => {
    const styles = readFileSync(join(__dirname, "../../../styles.css"), "utf8");
    const hiddenDeclarations = styles.match(
      /body:not\(\.is-mobile\)\s+\.markdown-source-view\.mod-cm6\.is-live-preview\s+\.cm-line\.HyperMD-list-line:has\(\.cm-fold-indicator\)\s+\.cm-fold-indicator\s+\.collapse-indicator\s*\{([^}]*)\}/,
    )?.[1];
    const hoveredDeclarations = styles.match(
      /body:not\(\.is-mobile\)\s+\.markdown-source-view\.mod-cm6\.is-live-preview\s+\.cm-line\.HyperMD-list-line:has\(\.cm-fold-indicator\):hover\s+\.cm-fold-indicator\s+\.collapse-indicator\s*\{([^}]*)\}/,
    )?.[1];
    const competingParentDeclarations = styles.match(
      /body:not\(\.is-mobile\)\.bullet-plugin-vertical-lines-action-toggle-folding\s+\.markdown-source-view\.mod-cm6\.is-live-preview\s+\.cm-line\.HyperMD-list-line:has\(\.cm-fold-indicator\):hover\s+\.cm-fold-indicator\s*\{([^}]*)\}/,
    )?.[1];
    const competingControlDeclarations = styles.match(
      /body:not\(\.is-mobile\)\.bullet-plugin-vertical-lines-action-toggle-folding\s+\.markdown-source-view\.mod-cm6\.is-live-preview\s+\.cm-line\.HyperMD-list-line:has\(\.cm-fold-indicator\):hover\s+\.cm-fold-indicator\s+\.collapse-indicator\s*\{([^}]*)\}/,
    )?.[1];
    const competingIconDeclarations = styles.match(
      /body:not\(\.is-mobile\)\.bullet-plugin-vertical-lines-action-toggle-folding\s+\.markdown-source-view\.mod-cm6\.is-live-preview\s+\.cm-line\.HyperMD-list-line:has\(\.cm-fold-indicator\):hover\s+\.cm-fold-indicator\s+\.collapse-indicator\s+svg\.svg-icon\s*\{([^}]*)\}/,
    )?.[1];

    expect(hiddenDeclarations).toContain("display: flex;");
    expect(hiddenDeclarations).toContain("box-sizing: border-box;");
    expect(hiddenDeclarations).toContain("align-items: center;");
    expect(hiddenDeclarations).toContain("justify-content: center;");
    expect(hiddenDeclarations).toContain("inset-inline-start: -5px;");
    expect(hiddenDeclarations).toContain("inset-inline-end: auto;");
    expect(hiddenDeclarations).toContain("width: 14px;");
    expect(hiddenDeclarations).toContain("padding-inline: 0;");
    expect(hiddenDeclarations).not.toContain("transform:");
    expect(hiddenDeclarations).not.toContain(
      "inset-inline-start: calc(-1 * var(--list-indent, 18px));",
    );
    expect(hiddenDeclarations).not.toContain(
      "width: var(--list-indent, 18px);",
    );
    expect(hiddenDeclarations).toContain("opacity: 0;");
    expect(hiddenDeclarations).toContain("visibility: hidden;");
    expect(hiddenDeclarations).toContain("pointer-events: none;");
    expect(hoveredDeclarations?.replace(/\s+/g, " ").trim()).toBe(
      "opacity: 1; visibility: visible; pointer-events: auto;",
    );
    expect(competingParentDeclarations?.trim()).toBe("z-index: 3;");
    expect(competingControlDeclarations?.trim()).toBe("pointer-events: none;");
    expect(competingIconDeclarations?.trim()).toBe("pointer-events: auto;");
    expect(styles).not.toMatch(
      /\.bullet-plugin-vertical-lines-action-toggle-folding\s+\.markdown-source-view\.mod-cm6\s+\.HyperMD-list-line\s+\.cm-fold-indicator\s+\.collapse-indicator\s*\{/,
    );
    expect(styles).not.toMatch(
      /body:not\(\.is-mobile\)[^{]*\.HyperMD-header[^{]*\.collapse-indicator\s*\{/,
    );
  });

  test("uses native active guide styling when enhanced hover is disabled", () => {
    const styles = readFileSync(join(__dirname, "../../../styles.css"), "utf8");
    const declarations = styles.match(
      /\.bullet-plugin-vertical-lines-action-toggle-folding\s+\.markdown-source-view\.mod-cm6\s+\.cm-hmd-list-indent\s+\.cm-indent\.bullet-plugin-hovered-indent-guide::before\s*\{([^}]*)\}/,
    )?.[1];
    const normalized = declarations?.replace(/\s+/g, " ").trim();

    expect(normalized).toBe(
      "border-inline-end: var(--indentation-guide-width-active) solid var(--indentation-guide-color-active);",
    );
    expect(normalized).not.toMatch(/\bborder-radius\s*:/);
    expect(normalized).not.toMatch(/\bmargin-inline-start\s*:/);
  });

  test("centers the optional three-pixel style without replacing the native mode indent", () => {
    const styles = readFileSync(join(__dirname, "../../../styles.css"), "utf8");
    const normalColor = styles.match(
      /\.bullet-plugin-enhanced-vertical-line-hover\s+\.markdown-source-view\.mod-cm6\s*\{([^}]*)\}/,
    )?.[1];
    const declarations = styles.match(
      /\.bullet-plugin-vertical-lines-action-toggle-folding\.bullet-plugin-enhanced-vertical-line-hover\s+\.markdown-source-view\.mod-cm6\s+\.cm-hmd-list-indent\s+\.cm-indent\.bullet-plugin-hovered-indent-guide::before\s*\{([^}]*)\}/,
    )?.[1];
    const startDeclarations = styles.match(
      /\.bullet-plugin-vertical-lines-action-toggle-folding\.bullet-plugin-enhanced-vertical-line-hover\s+\.markdown-source-view\.mod-cm6\s+\.cm-hmd-list-indent\s+\.cm-indent\.bullet-plugin-hovered-indent-guide\.bullet-plugin-hovered-indent-guide-start::before\s*\{([^}]*)\}/,
    )?.[1];
    const endDeclarations = styles.match(
      /\.bullet-plugin-vertical-lines-action-toggle-folding\.bullet-plugin-enhanced-vertical-line-hover\s+\.markdown-source-view\.mod-cm6\s+\.cm-hmd-list-indent\s+\.cm-indent\.bullet-plugin-hovered-indent-guide\.bullet-plugin-hovered-indent-guide-end::before\s*\{([^}]*)\}/,
    )?.[1];
    const livePreviewOffset = styles.match(
      /\.bullet-plugin-vertical-lines-action-toggle-folding\.bullet-plugin-enhanced-vertical-line-hover\s+\.markdown-source-view\.mod-cm6\.is-live-preview\s+\.cm-hmd-list-indent\s+\.cm-indent\.bullet-plugin-hovered-indent-guide::before\s*\{([^}]*)\}/,
    )?.[1];
    const sourceModeOffset = styles.match(
      /\.bullet-plugin-vertical-lines-action-toggle-folding\.bullet-plugin-enhanced-vertical-line-hover\s+\.markdown-source-view\.mod-cm6:not\(\.is-live-preview\)\s+\.cm-hmd-list-indent\s+\.cm-indent\.bullet-plugin-hovered-indent-guide::before\s*\{([^}]*)\}/,
    )?.[1];
    const normalized = declarations?.replace(/\s+/g, " ").trim();

    expect(normalColor?.replace(/\s+/g, " ").trim()).toBe(
      "--indentation-guide-color: color-mix( in oklch, var(--text-normal) 26%, transparent );",
    );
    expect(normalized).toBe(
      "inline-size: 3px; border-inline-end: 0; background-color: var(--indentation-guide-color-active);",
    );
    expect(startDeclarations?.replace(/\s+/g, " ").trim()).toBe(
      "border-start-start-radius: 2px; border-start-end-radius: 2px;",
    );
    expect(endDeclarations?.replace(/\s+/g, " ").trim()).toBe(
      "border-end-start-radius: 2px; border-end-end-radius: 2px;",
    );
    expect(livePreviewOffset?.replace(/\s+/g, " ").trim()).toBe(
      "margin-inline-start: var(--indentation-guide-editing-indent);",
    );
    expect(sourceModeOffset?.replace(/\s+/g, " ").trim()).toBe(
      "margin-inline-start: var(--indentation-guide-source-indent);",
    );
    expect(normalized).not.toMatch(/\binset-inline-(?:start|end)\s*:/);
    expect(normalized).not.toMatch(/(?:^|;)\s*(?:left|right)\s*:/);
    expect(normalized).not.toMatch(
      /\b(?:transition|box-shadow|outline|opacity)\s*:/,
    );
    expect(normalized).not.toMatch(/\bborder-radius\s*:/);
    expect(styles).not.toMatch(/\.cm-indent:hover::before/);
  });
});

describe("GuideFolding outer guide styles", () => {
  const styles = readFileSync(join(__dirname, "../../../styles.css"), "utf8");

  test("positions a zero-content segment one list indent outside the native guide", () => {
    const declarations = styles.match(
      /\.markdown-source-view\.mod-cm6\s+\.bullet-plugin-outer-list-guide\s*\{([^}]*)\}/,
    )?.[1];

    expect(declarations).toContain("position: absolute;");
    expect(declarations).toContain("inset-block: 0;");
    expect(declarations).toContain(
      "inset-inline-start: calc(-1 * var(--list-indent));",
    );
    expect(declarations).toContain("width: var(--list-indent);");
    expect(declarations).toContain("pointer-events: auto;");
  });

  test("keeps the fallback at the widget end and clears the desktop chevron", () => {
    const baseDeclarations = styles.match(
      /\.markdown-source-view\.mod-cm6\s+\.bullet-plugin-outer-list-guide::before\s*\{([^}]*)\}/,
    )?.[1];
    const desktopNormalDeclarations = styles.match(
      /body:not\(\.is-mobile\)\s+\.markdown-source-view\.mod-cm6\s+\.bullet-plugin-outer-list-guide::before\s*\{([^}]*)\}/,
    )?.[1];
    const desktopLivePreviewDeclarations = styles.match(
      /body:not\(\.is-mobile\)\s+\.markdown-source-view\.mod-cm6\.is-live-preview\s+\.bullet-plugin-outer-list-guide::before\s*\{([^}]*)\}/,
    )?.[1];

    expect(baseDeclarations).toContain("inset-inline-end: 0;");
    expect(desktopNormalDeclarations).toBeUndefined();
    expect(desktopLivePreviewDeclarations?.replace(/\s+/g, " ").trim()).toBe(
      "inset-inline-start: auto; inset-inline-end: calc(var(--icon-xs) / 2);",
    );
  });

  test("draws normal, native-active, and enhanced segments with theme variables", () => {
    const normal = styles.match(
      /\.markdown-source-view\.mod-cm6\s+\.bullet-plugin-outer-list-guide::before\s*\{([^}]*)\}/,
    )?.[1];
    const nativeHovered = styles.match(
      /\.bullet-plugin-vertical-lines-action-toggle-folding\s+\.markdown-source-view\.mod-cm6\s+\.bullet-plugin-outer-list-guide\[data-actionable="true"\]\.bullet-plugin-hovered-outer-list-guide::before\s*\{([^}]*)\}/,
    )?.[1];
    const enhancedHovered = styles.match(
      /\.bullet-plugin-vertical-lines-action-toggle-folding\.bullet-plugin-enhanced-vertical-line-hover\s+\.markdown-source-view\.mod-cm6\s+\.bullet-plugin-outer-list-guide\[data-actionable="true"\]\.bullet-plugin-hovered-outer-list-guide::before\s*\{([^}]*)\}/,
    )?.[1];
    const enhancedStart = styles.match(
      /\.bullet-plugin-vertical-lines-action-toggle-folding\.bullet-plugin-enhanced-vertical-line-hover\s+\.markdown-source-view\.mod-cm6\s+\.bullet-plugin-outer-list-guide\[data-actionable="true"\]\.bullet-plugin-hovered-outer-list-guide\.bullet-plugin-hovered-outer-list-guide-start::before\s*\{([^}]*)\}/,
    )?.[1];
    const enhancedEnd = styles.match(
      /\.bullet-plugin-vertical-lines-action-toggle-folding\.bullet-plugin-enhanced-vertical-line-hover\s+\.markdown-source-view\.mod-cm6\s+\.bullet-plugin-outer-list-guide\[data-actionable="true"\]\.bullet-plugin-hovered-outer-list-guide\.bullet-plugin-hovered-outer-list-guide-end::before\s*\{([^}]*)\}/,
    )?.[1];
    const desktopEnhancedHovered = styles.match(
      /body:not\(\s*\.is-mobile\s*\)\.bullet-plugin-vertical-lines-action-toggle-folding\.bullet-plugin-enhanced-vertical-line-hover\s+\.markdown-source-view\.mod-cm6\.is-live-preview\s+\.bullet-plugin-outer-list-guide\[data-actionable="true"\]\.bullet-plugin-hovered-outer-list-guide::before\s*\{([^}]*)\}/,
    )?.[1];
    const normalizedNativeHovered = nativeHovered?.replace(/\s+/g, " ").trim();
    const normalizedEnhancedHovered = enhancedHovered
      ?.replace(/\s+/g, " ")
      .trim();

    expect(normal?.replace(/\s+/g, " ")).toContain(
      "border-inline-end: var(--indentation-guide-width) solid var(--indentation-guide-color);",
    );
    expect(normalizedNativeHovered).toBe(
      "border-inline-end: var(--indentation-guide-width-active) solid var(--indentation-guide-color-active);",
    );
    expect(normalizedEnhancedHovered).toBe(
      "inset-inline-end: -1px; inline-size: 3px; border-inline-end: 0; background-color: var(--indentation-guide-color-active);",
    );
    expect(enhancedStart?.replace(/\s+/g, " ").trim()).toBe(
      "border-start-start-radius: 2px; border-start-end-radius: 2px;",
    );
    expect(enhancedEnd?.replace(/\s+/g, " ").trim()).toBe(
      "border-end-start-radius: 2px; border-end-end-radius: 2px;",
    );
    expect(desktopEnhancedHovered?.replace(/\s+/g, " ").trim()).toBe(
      "inset-inline-start: auto; inset-inline-end: calc(var(--icon-xs) / 2 - 1px);",
    );
    expect(normalizedEnhancedHovered).not.toMatch(
      /(?:^|;)\s*(?:left|right)\s*:/,
    );
    expect(normalizedEnhancedHovered).not.toMatch(
      /\b(?:transition|box-shadow|outline|opacity)\s*:/,
    );
  });

  test("keeps the existing outer-widget hit area available without folding", () => {
    const outerGuide = styles.match(
      /\.markdown-source-view\.mod-cm6\s+\.bullet-plugin-outer-list-guide\s*\{([^}]*)\}/,
    )?.[1];
    const actionable = styles.match(
      /\.bullet-plugin-vertical-lines-action-toggle-folding\s+\.markdown-source-view\.mod-cm6\s+\.bullet-plugin-outer-list-guide\[data-actionable="true"\]\s*\{([^}]*)\}/,
    )?.[1];

    expect(outerGuide).toContain("pointer-events: auto;");
    expect(outerGuide).toContain("width: var(--list-indent);");
    expect(outerGuide).not.toMatch(/\b(?:padding|inline-size)\s*:/);
    expect(actionable).not.toContain("pointer-events:");
    expect(actionable).toContain("cursor: pointer;");
    expect(actionable).toContain("z-index: 2;");
    expect(styles).not.toContain("bullet-plugin-outer-list-guide-overlay");
  });

  test("introduces no fixed paint, overlay, or scroll correction", () => {
    const outerRules = Array.from(
      styles.matchAll(
        /[^{}]*\.bullet-plugin-outer-list-guide[^{}]*\{([^}]*)\}/g,
      ),
      (match) => match[1] ?? "",
    ).join("\n");

    expect(outerRules.match(/\bbackground-color\s*:/g) ?? []).toHaveLength(2);
    expect(outerRules).not.toMatch(/\bbackground\s*:/);
    expect(outerRules).not.toMatch(/(?:#[0-9a-f]{3,8}|rgba?\(|hsla?\()/i);
    expect(outerRules).not.toMatch(/\btransform\s*:/);
    expect(styles).not.toContain("bullet-plugin-outer-list-guide-overlay");
  });

  test("shares active paint with selected guides without requiring folding", () => {
    const selectedOuter = styles.match(
      /\.markdown-source-view\.mod-cm6\s+\.bullet-plugin-outer-list-guide\.bullet-plugin-selected-outer-list-guide::before\s*\{([^}]*)\}/,
    )?.[1];
    const enhancedSelectedOuter = styles.match(
      /\.bullet-plugin-enhanced-vertical-line-hover\s+\.markdown-source-view\.mod-cm6\s+\.bullet-plugin-outer-list-guide\.bullet-plugin-selected-outer-list-guide::before\s*\{([^}]*)\}/,
    )?.[1];
    const selectedOuterStart = styles.match(
      /\.bullet-plugin-enhanced-vertical-line-hover\s+\.markdown-source-view\.mod-cm6\s+\.bullet-plugin-outer-list-guide\.bullet-plugin-selected-outer-list-guide\.bullet-plugin-selected-outer-list-guide-start::before\s*\{([^}]*)\}/,
    )?.[1];
    const selectedOuterEnd = styles.match(
      /\.bullet-plugin-enhanced-vertical-line-hover\s+\.markdown-source-view\.mod-cm6\s+\.bullet-plugin-outer-list-guide\.bullet-plugin-selected-outer-list-guide\.bullet-plugin-selected-outer-list-guide-end::before\s*\{([^}]*)\}/,
    )?.[1];
    const desktopEnhancedSelectedOuter = styles.match(
      /body:not\(\.is-mobile\)\.bullet-plugin-enhanced-vertical-line-hover\s+\.markdown-source-view\.mod-cm6\.is-live-preview\s+\.bullet-plugin-outer-list-guide\.bullet-plugin-selected-outer-list-guide::before\s*\{([^}]*)\}/,
    )?.[1];
    const selectedInner = styles.match(
      /\.markdown-source-view\.mod-cm6\s+\.cm-hmd-list-indent\s+\.cm-indent\.bullet-plugin-selected-indent-guide::before\s*\{([^}]*)\}/,
    )?.[1];
    const enhancedSelectedInner = styles.match(
      /\.bullet-plugin-enhanced-vertical-line-hover\s+\.markdown-source-view\.mod-cm6\s+\.cm-hmd-list-indent\s+\.cm-indent\.bullet-plugin-selected-indent-guide::before\s*\{([^}]*)\}/,
    )?.[1];
    const selectedInnerStart = styles.match(
      /\.bullet-plugin-enhanced-vertical-line-hover\s+\.markdown-source-view\.mod-cm6\s+\.cm-hmd-list-indent\s+\.cm-indent\.bullet-plugin-selected-indent-guide\.bullet-plugin-selected-indent-guide-start::before\s*\{([^}]*)\}/,
    )?.[1];
    const selectedInnerEnd = styles.match(
      /\.bullet-plugin-enhanced-vertical-line-hover\s+\.markdown-source-view\.mod-cm6\s+\.cm-hmd-list-indent\s+\.cm-indent\.bullet-plugin-selected-indent-guide\.bullet-plugin-selected-indent-guide-end::before\s*\{([^}]*)\}/,
    )?.[1];
    const selectedLivePreviewOffset = styles.match(
      /\.bullet-plugin-enhanced-vertical-line-hover\s+\.markdown-source-view\.mod-cm6\.is-live-preview\s+\.cm-hmd-list-indent\s+\.cm-indent\.bullet-plugin-selected-indent-guide::before\s*\{([^}]*)\}/,
    )?.[1];
    const selectedSourceModeOffset = styles.match(
      /\.bullet-plugin-enhanced-vertical-line-hover\s+\.markdown-source-view\.mod-cm6:not\(\.is-live-preview\)\s+\.cm-hmd-list-indent\s+\.cm-indent\.bullet-plugin-selected-indent-guide::before\s*\{([^}]*)\}/,
    )?.[1];
    const selectedInnerRules = Array.from(
      styles.matchAll(
        /[^{}]*\.bullet-plugin-selected-indent-guide[^{}]*\{([^}]*)\}/g,
      ),
      (match) => match[0],
    );
    const selectedOuterRules = Array.from(
      styles.matchAll(
        /[^{}]*\.bullet-plugin-selected-outer-list-guide[^{}]*\{([^}]*)\}/g,
      ),
      (match) => match[0],
    );
    const outerGuide = styles.match(
      /\.markdown-source-view\.mod-cm6\s+\.bullet-plugin-outer-list-guide\s*\{([^}]*)\}/,
    )?.[1];

    for (const selectedDeclarations of [selectedOuter, selectedInner]) {
      expect(selectedDeclarations?.replace(/\s+/g, " ").trim()).toContain(
        "border-inline-end: var(--indentation-guide-width-active) solid var(--indentation-guide-color-active);",
      );
    }
    for (const enhancedSelectedDeclarations of [
      enhancedSelectedOuter,
      enhancedSelectedInner,
    ]) {
      expect(enhancedSelectedDeclarations).toContain("inline-size: 3px;");
      expect(enhancedSelectedDeclarations).toContain(
        "background-color: var(--indentation-guide-color-active);",
      );
    }
    expect(selectedOuterStart?.replace(/\s+/g, " ").trim()).toBe(
      "border-start-start-radius: 2px; border-start-end-radius: 2px;",
    );
    expect(selectedOuterEnd?.replace(/\s+/g, " ").trim()).toBe(
      "border-end-start-radius: 2px; border-end-end-radius: 2px;",
    );
    expect(selectedInnerStart?.replace(/\s+/g, " ").trim()).toBe(
      "border-start-start-radius: 2px; border-start-end-radius: 2px;",
    );
    expect(selectedInnerEnd?.replace(/\s+/g, " ").trim()).toBe(
      "border-end-start-radius: 2px; border-end-end-radius: 2px;",
    );
    expect(desktopEnhancedSelectedOuter?.replace(/\s+/g, " ").trim()).toBe(
      "inset-inline-start: auto; inset-inline-end: calc(var(--icon-xs) / 2 - 1px);",
    );
    expect(selectedLivePreviewOffset?.replace(/\s+/g, " ").trim()).toBe(
      "margin-inline-start: var(--indentation-guide-editing-indent);",
    );
    expect(selectedSourceModeOffset?.replace(/\s+/g, " ").trim()).toBe(
      "margin-inline-start: var(--indentation-guide-source-indent);",
    );
    for (const selectedRule of [...selectedOuterRules, ...selectedInnerRules]) {
      expect(selectedRule).not.toContain(
        "bullet-plugin-vertical-lines-action-toggle-folding",
      );
    }
    expect(outerGuide).toContain("width: var(--list-indent);");
    expect(outerGuide).toContain("pointer-events: auto;");
    expect(outerGuide).not.toMatch(/\b(?:padding|inline-size)\s*:/);
    expect(styles).not.toContain("bullet-plugin-outer-list-guide-overlay");
  });
});

describe("GuideFoldingPluginValue guide interactions", () => {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- CodeMirror's mocked effect factory is intentionally stored for test setup and assertions.
  const mockedFoldEffectOf = jest.mocked(foldEffect.of);
  // eslint-disable-next-line @typescript-eslint/unbound-method -- CodeMirror's mocked effect factory is intentionally stored for test setup and assertions.
  const mockedUnfoldEffectOf = jest.mocked(unfoldEffect.of);
  const interactionPluginValues: GuideFoldingPluginValue[] = [];
  type CapturedListener = (event: Event) => void;
  type ListenerCapturingView = {
    contentDOM: {
      addEventListener: jest.Mock;
      removeEventListener: jest.Mock;
      querySelector: jest.Mock;
      querySelectorAll: jest.Mock;
      style: { paddingBottom: string };
    };
    listeners: Map<string, CapturedListener>;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest
      .mocked(foldable)
      .mockImplementation((_state, from, to) => ({ from: from + 1, to }));
    jest.mocked(foldedRanges).mockReturnValue({
      between: (
        from: number,
        to: number,
        callback: (from: number, to: number) => void,
      ) => callback(from + 1, to),
    } as never);
    mockedFoldEffectOf.mockImplementation(
      (range) => `fold-${range.from}` as never,
    );
    mockedUnfoldEffectOf.mockImplementation(
      (range) => `unfold-${range.from}` as never,
    );
    mockGetEditorFromState.mockReturnValue(null);
  });

  afterEach(() => {
    for (const pluginValue of interactionPluginValues.splice(0)) {
      pluginValue.destroy();
    }
  });

  function makeEvent(target: unknown, clientX?: number) {
    let defaultPrevented = false;
    const preventDefault = jest.fn(() => {
      defaultPrevented = true;
    });
    const stopPropagation = jest.fn();
    return {
      event: {
        target,
        clientX,
        get defaultPrevented() {
          return defaultPrevented;
        },
        preventDefault,
        stopPropagation,
      } as unknown as MouseEvent,
      preventDefault,
      stopPropagation,
    };
  }

  function makeListenerCapturingContentDOM(paddingBottom: string) {
    const listeners = new Map<string, CapturedListener>();
    const addEventListener = jest.fn(
      (eventName: string, listener: CapturedListener) => {
        listeners.set(eventName, listener);
      },
    );

    return {
      contentDOM: {
        addEventListener,
        removeEventListener: jest.fn(),
        querySelector: jest.fn().mockReturnValue(null),
        querySelectorAll: jest.fn().mockReturnValue([]),
        style: { paddingBottom },
      },
      listeners,
    };
  }

  function makeView(lineNumber: number) {
    const lines = Array.from({ length: 10 }, (_, index) => ({
      from: index * 10,
      to: index * 10 + 9,
    }));
    const scrollSnapshot = { value: {} };
    const { contentDOM, listeners } = makeListenerCapturingContentDOM("1000px");
    return {
      contentDOM,
      defaultLineHeight: 24,
      documentPadding: { top: 0, bottom: 0 },
      documentTop: 0,
      dom: {
        ownerDocument: { defaultView: { devicePixelRatio: 1 } },
      },
      scaleY: 1,
      scrollDOM: {
        clientHeight: 500,
        scrollTop: 0,
        getBoundingClientRect: jest.fn(() => ({ top: 0 })),
      },
      state: {
        doc: {
          lines: 10,
          line: jest.fn((number: number) => lines[number - 1]),
          lineAt: jest.fn().mockReturnValue({ number: lineNumber + 1 }),
        },
        selection: { main: { head: -1 } },
      },
      lineBlockAt: jest.fn((from: number) => lines[from / 10]),
      lineBlockAtHeight: jest.fn(() => ({ from: 0, top: 0 })),
      posAtDOM: jest.fn().mockReturnValue(10),
      requestMeasure: jest.fn(),
      scrollSnapshot: jest.fn().mockReturnValue(scrollSnapshot),
      dispatch: jest.fn(),
      listeners,
    };
  }

  function makeInteractionHarness(settings: object, parser: object) {
    const dispatch = (
      eventName: "mousedown" | "click",
      event: MouseEvent,
      view: ListenerCapturingView,
    ) => {
      const ownedSettings = {
        outerVerticalLines: false,
        verticalLinesAction: "none",
        onChange: jest.fn(),
        removeCallback: jest.fn(),
      };
      const pluginValue = new GuideFoldingPluginValue(
        ownedSettings as never,
        parser as never,
        view as never,
      );
      interactionPluginValues.push(pluginValue);
      Object.assign(ownedSettings, settings);

      const listener = view.listeners.get(eventName);
      if (!listener) {
        throw new Error(`Expected ${eventName} capture listener`);
      }
      listener(event);

      return event.defaultPrevented;
    };

    return {
      mouseDown: (event: MouseEvent, view: ListenerCapturingView) =>
        dispatch("mousedown", event, view),
      click: (event: MouseEvent, view: ListenerCapturingView) =>
        dispatch("click", event, view),
    };
  }

  function makeOuterGuideTarget(
    attributes: Record<string, string> = {
      "data-actionable": "true",
      "data-chunk-start": "0",
      "data-chunk-end": "2",
    },
  ) {
    return {
      matches: jest.fn(
        (selector: string) => selector === ".bullet-plugin-outer-list-guide",
      ),
      closest: jest.fn(),
      getAttribute: jest.fn((name: string) => attributes[name] ?? null),
    };
  }

  function makeTransactionFixture(
    selectionHead: number,
    options: { devicePixelRatio?: number; targetsFolded?: boolean } = {},
  ) {
    const lines = [
      { from: 0, to: 8 },
      { from: 21, to: 29 },
    ];
    const scrollSnapshot = {
      value: {
        range: EditorSelection.cursor(0),
        yMargin: -12.875,
      },
    };
    const { contentDOM, listeners } =
      makeListenerCapturingContentDOM("1138.5px");
    const view = {
      contentDOM,
      defaultLineHeight: 24,
      documentPadding: { top: 0, bottom: 0 },
      documentTop: 0,
      dom: {
        ownerDocument: {
          defaultView: {
            devicePixelRatio: options.devicePixelRatio ?? 1,
          },
        },
      },
      scaleY: 1,
      scrollDOM: {
        clientHeight: 1163,
        scrollTop: 100,
        getBoundingClientRect: jest.fn(() => ({ top: 50 })),
      },
      state: {
        doc: {
          lines: 2,
          line: jest.fn((number: number) => lines[number - 1]),
        },
        selection: { main: { head: selectionHead } },
      },
      lineBlockAt: jest.fn((from: number) =>
        from === lines[0].from ? lines[0] : lines[1],
      ),
      lineBlockAtHeight: jest.fn(() => ({ from: 0, top: 87.125 })),
      scrollSnapshot: jest.fn().mockReturnValue(scrollSnapshot),
      dispatch: jest.fn(),
      posAtDOM: jest.fn(),
      requestMeasure: jest.fn(),
      listeners,
    };
    const editor = makeFoldEditor();
    editor.lastLine.mockReturnValue(1);
    mockGetEditorFromState.mockReturnValue(editor);
    const folded = options.targetsFolded ?? false;
    const targets = [0, 1].map((line) => ({
      getFirstLineContentStart: jest.fn(() => ({ line, ch: 2 })),
      getLineCount: jest.fn(() => 2),
      isEmpty: jest.fn(() => false),
      isFolded: jest.fn(() => folded),
    }));
    const root = {
      getChildren: jest.fn(() => targets),
      getContentStart: jest.fn(() => ({ line: 0, ch: 0 })),
      getContentEnd: jest.fn(() => ({ line: 1, ch: 0 })),
    };
    const pluginValue = makeInteractionHarness(
      {
        outerVerticalLines: true,
        verticalLinesAction: "toggle-folding",
      },
      { parseRange: jest.fn().mockReturnValue([root]) },
    );
    const interaction = makeEvent(
      makeOuterGuideTarget({
        "data-actionable": "true",
        "data-chunk-start": "0",
        "data-chunk-end": "1",
      }),
    );

    return { editor, interaction, pluginValue, scrollSnapshot, view };
  }

  function setPaddingBottom(
    view: ReturnType<typeof makeTransactionFixture>["view"],
    value: string,
  ) {
    Object.defineProperty(view.contentDOM.style, "paddingBottom", {
      configurable: true,
      value,
      writable: true,
    });
  }

  describe("anchored fold transactions", () => {
    const mockedFoldable = jest.mocked(foldable);
    const mockedFoldedRanges = jest.mocked(foldedRanges);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- CodeMirror's mocked effect factory is intentionally stored for test setup.
    const mockedFoldEffectOf = jest.mocked(foldEffect.of);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- CodeMirror's mocked effect factory is intentionally stored for test setup.
    const mockedUnfoldEffectOf = jest.mocked(unfoldEffect.of);
    const between = jest.fn();

    beforeEach(() => {
      mockedFoldedRanges.mockReturnValue({ between } as never);
    });

    test("folds every target with one scroll snapshot and a safe selection", () => {
      mockedFoldable
        .mockReturnValueOnce({ from: 8, to: 20 })
        .mockReturnValueOnce({ from: 29, to: 40 });
      mockedFoldEffectOf
        .mockReturnValueOnce("fold-8" as never)
        .mockReturnValueOnce("fold-29" as never);
      const { interaction, pluginValue, scrollSnapshot, view } =
        makeTransactionFixture(32);

      expect(pluginValue.click(interaction.event, view)).toBe(true);

      expect(view.scrollSnapshot).toHaveBeenCalledTimes(1);
      expect(view.dispatch).toHaveBeenCalledWith({
        selection: { anchor: 23, head: 23 },
        effects: [scrollSnapshot, "fold-8", "fold-29"],
      });
      expect(scrollSnapshot.value.yMargin).toBe(-13);
      expect(view.dispatch).toHaveBeenCalledTimes(1);
    });

    test("keeps an outside selection while folding every target", () => {
      mockedFoldable
        .mockReturnValueOnce({ from: 8, to: 20 })
        .mockReturnValueOnce({ from: 29, to: 40 });
      mockedFoldEffectOf
        .mockReturnValueOnce("fold-8" as never)
        .mockReturnValueOnce("fold-29" as never);
      const { interaction, pluginValue, scrollSnapshot, view } =
        makeTransactionFixture(5);

      pluginValue.click(interaction.event, view);

      expect(view.dispatch).toHaveBeenCalledWith({
        effects: [scrollSnapshot, "fold-8", "fold-29"],
      });
      expect(view.dispatch).toHaveBeenCalledTimes(1);
    });

    test("unfolds every target with one scroll snapshot", () => {
      between.mockImplementation(
        (
          from: number,
          _to: number,
          callback: (from: number, to: number) => void,
        ) => {
          if (from === 0) callback(8, 20);
          if (from === 21) callback(29, 40);
        },
      );
      mockedUnfoldEffectOf
        .mockReturnValueOnce("unfold-8" as never)
        .mockReturnValueOnce("unfold-29" as never);
      const { interaction, pluginValue, scrollSnapshot, view } =
        makeTransactionFixture(5, { targetsFolded: true });

      expect(pluginValue.click(interaction.event, view)).toBe(true);

      expect(view.scrollSnapshot).toHaveBeenCalledTimes(1);
      expect(view.dispatch).toHaveBeenCalledWith({
        effects: [scrollSnapshot, "unfold-8", "unfold-29"],
      });
      expect(view.dispatch).toHaveBeenCalledTimes(1);
    });

    test("does not snapshot or dispatch when no target has a range", () => {
      mockedFoldable.mockReturnValue(null);
      const { interaction, pluginValue, view } = makeTransactionFixture(5);
      setPaddingBottom(view, "100px");

      expect(pluginValue.click(interaction.event, view)).toBe(true);

      expect(view.scrollSnapshot).not.toHaveBeenCalled();
      expect(view.dispatch).not.toHaveBeenCalled();
      expect(view.contentDOM.style.paddingBottom).toBe("100px");
    });

    test("anchors the snapshot to the visible document below properties", () => {
      mockedFoldable.mockReturnValue({ from: 8, to: 20 });
      mockedFoldEffectOf.mockReturnValue("fold-8" as never);
      const { interaction, pluginValue, scrollSnapshot, view } =
        makeTransactionFixture(5);
      view.documentTop = -537.5625;
      view.scrollDOM.scrollTop = 1400;
      view.scrollDOM.getBoundingClientRect.mockReturnValue({ top: 78.75 });
      view.lineBlockAtHeight.mockReturnValue({
        from: 848,
        top: 614.34375,
      });
      scrollSnapshot.value.range = EditorSelection.cursor(1570);
      scrollSnapshot.value.yMargin = -17.34375;

      pluginValue.click(interaction.event, view);

      expect(view.lineBlockAtHeight).toHaveBeenCalledWith(624.3125);
      expect(scrollSnapshot.value.range.from).toBe(848);
      expect(scrollSnapshot.value.range.to).toBe(848);
      expect(scrollSnapshot.value.yMargin).toBe(-786);
      expect(view.dispatch).toHaveBeenCalledTimes(1);
    });

    test("keeps line-block lookup in screen coordinates when the editor is scaled", () => {
      mockedFoldable.mockReturnValue({ from: 8, to: 20 });
      mockedFoldEffectOf.mockReturnValue("fold-8" as never);
      const { interaction, pluginValue, view } = makeTransactionFixture(5);
      view.documentTop = -537.5625;
      view.scaleY = 2;
      view.scrollDOM.scrollTop = 1400;
      view.scrollDOM.getBoundingClientRect.mockReturnValue({ top: 78.75 });

      pluginValue.click(interaction.event, view);

      expect(view.lineBlockAtHeight).toHaveBeenCalledWith(624.3125);
      expect(view.dispatch).toHaveBeenCalledTimes(1);
    });

    test("falls back to the native snapshot when viewport geometry is invalid", () => {
      mockedFoldable.mockReturnValue({ from: 8, to: 20 });
      mockedFoldEffectOf.mockReturnValue("fold-8" as never);
      const { interaction, pluginValue, scrollSnapshot, view } =
        makeTransactionFixture(5);
      view.scaleY = 0;
      scrollSnapshot.value.range = EditorSelection.cursor(1570);
      scrollSnapshot.value.yMargin = -17.34375;

      pluginValue.click(interaction.event, view);

      expect(view.lineBlockAtHeight).not.toHaveBeenCalled();
      expect(scrollSnapshot.value.range.from).toBe(1570);
      expect(scrollSnapshot.value.yMargin).toBe(-17);
      expect(view.dispatch).toHaveBeenCalledTimes(1);
    });

    test("restores the standard scroll reserve before folding", () => {
      mockedFoldable.mockReturnValue({ from: 8, to: 20 });
      mockedFoldEffectOf.mockReturnValue("fold-8" as never);
      const { interaction, pluginValue, view } = makeTransactionFixture(5);
      setPaddingBottom(view, "100px");

      pluginValue.click(interaction.event, view);

      expect(view.contentDOM.style.paddingBottom).toBe("1138.5px");
      expect(view.dispatch).toHaveBeenCalledTimes(1);
    });

    test("keeps a scroll reserve that already exceeds the standard value", () => {
      mockedFoldable.mockReturnValue({ from: 8, to: 20 });
      mockedFoldEffectOf.mockReturnValue("fold-8" as never);
      const { interaction, pluginValue, view } = makeTransactionFixture(5);
      setPaddingBottom(view, "1200px");

      pluginValue.click(interaction.event, view);

      expect(view.contentDOM.style.paddingBottom).toBe("1200px");
      expect(view.dispatch).toHaveBeenCalledTimes(1);
    });

    test("snaps the scroll margin to the physical-pixel grid", () => {
      mockedFoldable.mockReturnValue({ from: 8, to: 20 });
      mockedFoldEffectOf.mockReturnValue("fold-8" as never);
      const { interaction, pluginValue, scrollSnapshot, view } =
        makeTransactionFixture(5, { devicePixelRatio: 2 });
      view.scaleY = 0;
      scrollSnapshot.value.yMargin = -12.74;

      pluginValue.click(interaction.event, view);

      expect(scrollSnapshot.value.yMargin).toBe(-12.5);
      expect(view.dispatch).toHaveBeenCalledTimes(1);
    });
  });

  test("maps each standard indent guide to its exact real ancestor", () => {
    const root = makeRoot({
      editor: makeEditor({
        text: [
          "- parent",
          "    - child",
          "        - grandchild",
          "            - leaf",
          "                - twig",
        ].join("\n"),
        cursor: { line: 4, ch: 16 },
      }),
    });
    const editor = makeFoldEditor();
    mockGetEditorFromState.mockReturnValue(editor);
    const pluginValue = makeInteractionHarness(
      {
        verticalLinesAction: "toggle-folding",
      },
      { parse: jest.fn().mockReturnValue(root) },
    );
    const { guides } = makeGuideLine(["    ", "    ", "    ", "    "]);

    const views = guides.slice(0, 3).map(() => makeView(4));
    for (const [index, guide] of guides.slice(0, 3).entries()) {
      expect(pluginValue.click(makeEvent(guide).event, views[index])).toBe(
        true,
      );
    }

    expect(foldable).toHaveBeenNthCalledWith(1, expect.anything(), 10, 19);
    expect(foldable).toHaveBeenNthCalledWith(2, expect.anything(), 20, 29);
    expect(foldable).toHaveBeenNthCalledWith(3, expect.anything(), 30, 39);
    expect(views.every((view) => view.dispatch.mock.calls.length === 1)).toBe(
      true,
    );
  });

  test("routes a wrapped mobile indentation lane to its rendered guide", () => {
    const root = makeRoot({
      editor: makeEditor({
        text: "- parent\n    - branch\n        - leaf",
        cursor: { line: 2, ch: 8 },
      }),
    });
    const editor = makeFoldEditor();
    mockGetEditorFromState.mockReturnValue(editor);
    const pluginValue = makeInteractionHarness(
      { verticalLinesAction: "toggle-folding" },
      { parse: jest.fn().mockReturnValue(root) },
    );
    const { line } = makeGuideLine(["    "], {
      guideRects: [{ left: 24, right: 60 }],
    });
    const mouseDown = makeEvent(line, 50);
    const click = makeEvent(line, 50);

    expect(pluginValue.mouseDown(mouseDown.event, makeView(2))).toBe(true);
    expect(foldable).not.toHaveBeenCalled();
    expect(mouseDown.preventDefault).toHaveBeenCalledTimes(1);
    expect(mouseDown.stopPropagation).toHaveBeenCalledTimes(1);

    expect(pluginValue.click(click.event, makeView(2))).toBe(true);
    expect(foldable).toHaveBeenCalledTimes(1);
    expect(click.preventDefault).toHaveBeenCalledTimes(1);
    expect(click.stopPropagation).toHaveBeenCalledTimes(1);
  });

  test.each([
    {
      name: "outside a wrapped guide lane",
      clientX: 60,
      guideOptions: {},
      settings: { verticalLinesAction: "toggle-folding" },
    },
    {
      name: "desktop wrapped indentation",
      clientX: 50,
      guideOptions: { mobile: false },
      settings: { verticalLinesAction: "toggle-folding" },
    },
    {
      name: "Source mode wrapped indentation",
      clientX: 50,
      guideOptions: { livePreview: false },
      settings: { verticalLinesAction: "toggle-folding" },
    },
    {
      name: "wrapped indentation when folding is disabled",
      clientX: 50,
      guideOptions: {},
      settings: { verticalLinesAction: "none" },
    },
  ])(
    "leaves $name to normal editing",
    ({ clientX, guideOptions, settings }) => {
      const pluginValue = makeInteractionHarness(settings, {
        parse: jest.fn(),
      });
      const { line } = makeGuideLine(["    "], {
        guideRects: [{ left: 24, right: 60 }],
        ...guideOptions,
      });

      for (const interact of [pluginValue.mouseDown, pluginValue.click]) {
        const interaction = makeEvent(line, clientX);

        expect(interact(interaction.event, makeView(2))).toBe(false);
        expect(interaction.preventDefault).not.toHaveBeenCalled();
        expect(interaction.stopPropagation).not.toHaveBeenCalled();
      }
      expect(foldable).not.toHaveBeenCalled();
    },
  );

  test("leaves a wrapped guide lane descendant to its native interaction", () => {
    const root = makeRoot({
      editor: makeEditor({
        text: "- parent\n    - branch\n        - leaf",
        cursor: { line: 2, ch: 8 },
      }),
    });
    mockGetEditorFromState.mockReturnValue(makeFoldEditor());
    const pluginValue = makeInteractionHarness(
      { verticalLinesAction: "toggle-folding" },
      { parse: jest.fn().mockReturnValue(root) },
    );
    const { line } = makeGuideLine(["    "], {
      guideRects: [{ left: 24, right: 60 }],
    });
    const descendant = {
      matches: jest.fn(() => false),
      closest: jest.fn((selector: string) =>
        selector === ".cm-line" ? line : null,
      ),
    };
    const interaction = makeEvent(descendant, 50);

    expect(pluginValue.click(interaction.event, makeView(2))).toBe(false);
    expect(interaction.preventDefault).not.toHaveBeenCalled();
    expect(interaction.stopPropagation).not.toHaveBeenCalled();
    expect(foldable).not.toHaveBeenCalled();
  });

  test("uses the painted boundary when native indentation is combined", () => {
    const root = makeRoot({
      editor: makeEditor({
        text: [
          "- parent",
          "  - child",
          "    - grandchild",
          "      - leaf",
          "        - twig",
        ].join("\n"),
        cursor: { line: 4, ch: 8 },
      }),
    });
    const editor = makeFoldEditor();
    mockGetEditorFromState.mockReturnValue(editor);
    const pluginValue = makeInteractionHarness(
      {
        verticalLinesAction: "toggle-folding",
      },
      { parse: jest.fn().mockReturnValue(root) },
    );
    const { guides } = makeGuideLine(["    ", "  ", "  "]);

    const firstView = makeView(4);
    const secondView = makeView(4);
    expect(pluginValue.click(makeEvent(guides[0]).event, firstView)).toBe(true);
    expect(pluginValue.click(makeEvent(guides[1]).event, secondView)).toBe(
      true,
    );

    expect(foldable).toHaveBeenNthCalledWith(1, expect.anything(), 10, 19);
    expect(foldable).toHaveBeenNthCalledWith(2, expect.anything(), 30, 39);
  });

  test("ignores guide boundaries that match only shared leading indentation", () => {
    const root = makeRoot({
      editor: makeEditor({
        text: "  - parent\n      - child\n          - leaf",
        cursor: { line: 2, ch: 10 },
      }),
    });
    const editor = makeFoldEditor();
    mockGetEditorFromState.mockReturnValue(editor);
    const pluginValue = makeInteractionHarness(
      {
        verticalLinesAction: "toggle-folding",
      },
      { parse: jest.fn().mockReturnValue(root) },
    );
    const { guides } = makeGuideLine(["    ", "    "]);

    expect(pluginValue.click(makeEvent(guides[0]).event, makeView(2))).toBe(
      false,
    );
    expect(pluginValue.click(makeEvent(guides[1]).event, makeView(2))).toBe(
      false,
    );
    expect(foldable).not.toHaveBeenCalled();
  });

  test("ignores a guide outside a list-indent container", () => {
    const root = makeRoot({
      editor: makeEditor({
        text: "- parent\n    - child\n        - leaf",
        cursor: { line: 2, ch: 8 },
      }),
    });
    const editor = makeFoldEditor();
    mockGetEditorFromState.mockReturnValue(editor);
    const pluginValue = makeInteractionHarness(
      {
        verticalLinesAction: "toggle-folding",
      },
      { parse: jest.fn().mockReturnValue(root) },
    );
    const { guides, indentContainer } = makeGuideLine(["    ", "    "]);
    indentContainer.matches.mockReturnValue(false);

    expect(pluginValue.click(makeEvent(guides[0]).event, makeView(2))).toBe(
      false,
    );
    expect(foldable).not.toHaveBeenCalled();
  });

  test("folds each direct non-empty child when any branch is open", () => {
    const root = makeRoot({
      editor: makeEditor({
        text: [
          "- parent",
          "  - branch one",
          "    - leaf one",
          "  - leaf sibling",
          "  - branch two",
          "    - leaf two",
        ].join("\n"),
        cursor: { line: 2, ch: 4 },
        getAllFoldedLines: () => [1],
      }),
    });
    const editor = makeFoldEditor();
    mockGetEditorFromState.mockReturnValue(editor);
    const pluginValue = makeInteractionHarness(
      {
        verticalLinesAction: "toggle-folding",
      },
      { parse: jest.fn().mockReturnValue(root) },
    );
    const { guides } = makeGuideLine(["    "]);

    const view = makeView(2);
    expect(pluginValue.click(makeEvent(guides[0]).event, view)).toBe(true);
    expect(foldable).toHaveBeenNthCalledWith(1, expect.anything(), 10, 19);
    expect(foldable).toHaveBeenNthCalledWith(2, expect.anything(), 40, 49);
    expect(view.dispatch).toHaveBeenCalledTimes(1);
  });

  test("unfolds each direct non-empty child when every branch is folded", () => {
    const root = makeRoot({
      editor: makeEditor({
        text: [
          "- parent",
          "  - branch one",
          "    - leaf one",
          "  - leaf sibling",
          "  - branch two",
          "    - leaf two",
        ].join("\n"),
        cursor: { line: 2, ch: 4 },
        getAllFoldedLines: () => [1, 4],
      }),
    });
    const editor = makeFoldEditor();
    mockGetEditorFromState.mockReturnValue(editor);
    const pluginValue = makeInteractionHarness(
      {
        verticalLinesAction: "toggle-folding",
      },
      { parse: jest.fn().mockReturnValue(root) },
    );
    const { guides } = makeGuideLine(["    "]);

    const view = makeView(2);
    expect(pluginValue.click(makeEvent(guides[0]).event, view)).toBe(true);
    expect(mockedUnfoldEffectOf).toHaveBeenNthCalledWith(1, {
      from: 11,
      to: 19,
    });
    expect(mockedUnfoldEffectOf).toHaveBeenNthCalledWith(2, {
      from: 41,
      to: 49,
    });
    expect(view.dispatch).toHaveBeenCalledTimes(1);
  });

  test("does nothing when the target has no non-empty children", () => {
    const root = makeRoot({
      editor: makeEditor({
        text: "- parent\n  - leaf",
        cursor: { line: 1, ch: 2 },
      }),
    });
    const editor = makeFoldEditor();
    mockGetEditorFromState.mockReturnValue(editor);
    const pluginValue = makeInteractionHarness(
      {
        verticalLinesAction: "toggle-folding",
      },
      { parse: jest.fn().mockReturnValue(root) },
    );
    const { guides } = makeGuideLine(["  "]);

    expect(pluginValue.click(makeEvent(guides[0]).event, makeView(1))).toBe(
      true,
    );
    expect(foldable).not.toHaveBeenCalled();
  });

  test("retains selection when no fold range can be updated", () => {
    const root = makeRoot({
      editor: makeEditor({
        text: "- parent\n  - branch\n    - leaf",
        cursor: { line: 2, ch: 4 },
      }),
    });
    const editor = makeFoldEditor();
    jest.mocked(foldable).mockReturnValue(null);
    mockGetEditorFromState.mockReturnValue(editor);
    const pluginValue = makeInteractionHarness(
      {
        verticalLinesAction: "toggle-folding",
      },
      { parse: jest.fn().mockReturnValue(root) },
    );
    const { guides } = makeGuideLine(["    "]);
    const { event, preventDefault } = makeEvent(guides[0]);

    const view = makeView(2);
    expect(pluginValue.click(event, view)).toBe(true);
    expect(foldable).toHaveBeenCalledTimes(1);
    expect(view.dispatch).not.toHaveBeenCalled();
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  test("observes mousedown and click during capture and removes both listeners", () => {
    type CapturedListener = (event: Event) => void;
    const addEventListener = jest.fn<
      void,
      [string, CapturedListener, boolean]
    >();
    const removeEventListener = jest.fn<
      void,
      [string, CapturedListener | undefined, boolean]
    >();
    const settingsCallbacks: Array<() => void> = [];
    const settings = {
      verticalLinesAction: "toggle-folding",
      onChange: jest.fn((keys: unknown, callback?: () => void) => {
        settingsCallbacks.push(callback ?? (keys as () => void));
      }),
      removeCallback: jest.fn(),
    };
    const hoveredGuide = makeGuideElement([
      "cm-indent",
      "bullet-plugin-hovered-indent-guide",
    ]);
    const { contentDOM: guideDOM } = makeGuideDOM([hoveredGuide]);
    const contentDOM = {
      ...guideDOM,
      addEventListener,
      removeEventListener,
      querySelector: jest.fn().mockReturnValue(null),
    };
    const requestMeasure = jest.fn();
    const PluginValueWithView = GuideFoldingPluginValue as unknown as new (
      settings: unknown,
      parser: unknown,
      view: unknown,
    ) => { destroy(): void };
    const pluginValue = new PluginValueWithView(
      settings,
      { parse: jest.fn() },
      { contentDOM, requestMeasure },
    );

    expect(contentDOM.addEventListener).toHaveBeenCalledWith(
      "mousedown",
      expect.any(Function),
      true,
    );
    expect(contentDOM.addEventListener).toHaveBeenCalledWith(
      "click",
      expect.any(Function),
      true,
    );
    expect(contentDOM.addEventListener).toHaveBeenCalledWith(
      "pointermove",
      expect.any(Function),
      true,
    );
    expect(contentDOM.addEventListener).toHaveBeenCalledWith(
      "pointerleave",
      expect.any(Function),
      true,
    );
    expect(settings.onChange).toHaveBeenCalledWith(
      ["outerListLines", "listLineAction"],
      expect.any(Function),
    );
    expect(requestMeasure).toHaveBeenCalledTimes(1);
    const listener = addEventListener.mock.calls[0]?.[1];
    const clickListener = addEventListener.mock.calls.find(
      ([eventName]) => eventName === "click",
    )?.[1];
    const pointerMoveListener = addEventListener.mock.calls.find(
      ([eventName]) => eventName === "pointermove",
    )?.[1];
    const pointerLeaveListener = addEventListener.mock.calls.find(
      ([eventName]) => eventName === "pointerleave",
    )?.[1];
    const settingsCallback = settingsCallbacks[0];

    pluginValue.destroy();

    expect(contentDOM.removeEventListener).toHaveBeenCalledWith(
      "mousedown",
      listener,
      true,
    );
    expect(contentDOM.removeEventListener).toHaveBeenCalledWith(
      "click",
      clickListener,
      true,
    );
    expect(contentDOM.removeEventListener).toHaveBeenCalledWith(
      "pointermove",
      pointerMoveListener,
      true,
    );
    expect(contentDOM.removeEventListener).toHaveBeenCalledWith(
      "pointerleave",
      pointerLeaveListener,
      true,
    );
    expect(
      hoveredGuide.classList.contains("bullet-plugin-hovered-indent-guide"),
    ).toBe(false);
    expect(settings.removeCallback).toHaveBeenCalledWith(settingsCallback);
  });

  test("synchronizes logical hover groups across the view lifecycle", () => {
    type CapturedListener = (event: Event) => void;
    type Measurement = {
      read?: () => unknown;
      write?: (measure: unknown, view: unknown) => void;
    };
    const addEventListener = jest.fn<
      void,
      [string, CapturedListener, boolean]
    >();
    const removeEventListener = jest.fn<
      void,
      [string, CapturedListener | undefined, boolean]
    >();
    const documentListeners = new Map<string, CapturedListener>();
    const ownerDocument = {
      addEventListener: jest.fn(
        (eventName: string, listener: CapturedListener) => {
          documentListeners.set(eventName, listener);
        },
      ),
      removeEventListener: jest.fn(),
    };
    const settingsCallbacks: Array<() => void> = [];
    const settings = {
      verticalLinesAction: "toggle-folding",
      onChange: jest.fn((keys: unknown, callback?: () => void) => {
        settingsCallbacks.push(callback ?? (keys as () => void));
      }),
      removeCallback: jest.fn(),
    };
    const outerEditor = makeEditor({
      text: [
        "- parent A",
        "    - child A",
        "        - leaf A",
        "- parent B",
        "    - child B",
        "        - leaf B",
      ].join("\n"),
      cursor: { line: 2, ch: 8 },
    });
    const outerRoot = makeRoot({ editor: outerEditor });
    const outerChildA = makeGuideLine(["    "]);
    const outerLeafA = makeGuideLine(["    ", "    "]);
    const outerChildB = makeGuideLine(["    "]);
    const outerLeafB = makeGuideLine(["    ", "    "]);
    let hoveredGuide:
      | ReturnType<typeof makeGuideLine>["guides"][number]
      | null = outerLeafA.guides[0];
    let candidates = [
      ...outerChildA.guides,
      ...outerLeafA.guides,
      ...outerChildB.guides,
      ...outerLeafB.guides,
    ];
    let lineByElement = new Map<unknown, number>([
      [outerChildA.line, 1],
      [outerLeafA.line, 2],
      [outerChildB.line, 4],
      [outerLeafB.line, 5],
    ]);
    let currentRoot: ReturnType<typeof makeRoot> | null = outerRoot;
    let currentEditor = outerEditor;
    const querySelector = jest.fn((selector: string) =>
      selector ===
      ".cm-indent:hover, .cm-hmd-list-indent > .cm-indent-spacing:hover"
        ? hoveredGuide
        : null,
    );
    const querySelectorAll = jest.fn((selector: string) => {
      if (
        selector ===
        ".cm-hmd-list-indent > .cm-indent, .cm-hmd-list-indent > .cm-indent-spacing"
      ) {
        return candidates;
      }
      if (selector === ".bullet-plugin-hovered-indent-guide") {
        return candidates.filter((guide) =>
          guide.classList.contains("bullet-plugin-hovered-indent-guide"),
        );
      }
      if (selector === ".bullet-plugin-selected-indent-guide") {
        return candidates.filter((guide) =>
          guide.classList.contains("bullet-plugin-selected-indent-guide"),
        );
      }
      if (selector === ".bullet-plugin-selected-indent-guide-start") {
        return candidates.filter((guide) =>
          guide.classList.contains("bullet-plugin-selected-indent-guide-start"),
        );
      }
      if (selector === ".bullet-plugin-selected-indent-guide-end") {
        return candidates.filter((guide) =>
          guide.classList.contains("bullet-plugin-selected-indent-guide-end"),
        );
      }
      return [];
    });
    const contentDOM = {
      addEventListener,
      removeEventListener,
      ownerDocument,
      contains: jest.fn((target: unknown) =>
        candidates.includes(target as never),
      ),
      querySelector,
      querySelectorAll,
    };
    const requests: Measurement[] = [];
    const view = {
      contentDOM,
      state: {
        doc: {
          lineAt: jest.fn((offset: number) => ({ number: offset + 1 })),
        },
      },
      posAtDOM: jest.fn((element: unknown) => {
        const line = lineByElement.get(element);
        if (line === undefined) {
          throw new Error("Expected a mapped line element");
        }
        return line;
      }),
      requestMeasure: jest.fn((request: Measurement) => {
        requests.push(request);
      }),
    };
    const parser = { parse: jest.fn(() => currentRoot) };
    mockGetEditorFromState.mockImplementation(() => currentEditor);
    const PluginValueWithView = GuideFoldingPluginValue as unknown as new (
      settings: unknown,
      parser: unknown,
      view: unknown,
    ) => { destroy(): void; update(update: unknown): void };
    const pluginValue = new PluginValueWithView(settings, parser, view);
    const executeLatestMeasurement = () => {
      const request = requests[requests.length - 1];
      const measurement = request?.read?.();
      request?.write?.(measurement, view);
    };

    executeLatestMeasurement();
    expect(
      outerChildA.guides[0]?.classList.contains(
        "bullet-plugin-hovered-indent-guide",
      ),
    ).toBe(true);
    expect(
      outerLeafA.guides[0]?.classList.contains(
        "bullet-plugin-hovered-indent-guide",
      ),
    ).toBe(true);
    expect(
      outerChildB.guides[0]?.classList.contains(
        "bullet-plugin-hovered-indent-guide",
      ),
    ).toBe(false);

    const clickListener = addEventListener.mock.calls.find(
      ([eventName]) => eventName === "click",
    )?.[1];
    settings.verticalLinesAction = "none";
    clickListener?.(makeEvent(outerLeafA.guides[0]).event);
    hoveredGuide = null;
    parser.parse.mockClear();
    executeLatestMeasurement();
    expect(parser.parse).toHaveBeenCalledTimes(1);
    hoveredGuide = outerLeafA.guides[0];
    const selectedSegments = [outerChildA.guides[0], outerLeafA.guides[0]];
    const unrelatedSegments = [outerChildB.guides[0], outerLeafB.guides[0]];
    expect(
      selectedSegments.every((guide) =>
        guide.classList.contains("bullet-plugin-selected-indent-guide"),
      ),
    ).toBe(true);
    expect(
      unrelatedSegments.some((guide) =>
        guide.classList.contains("bullet-plugin-selected-indent-guide"),
      ),
    ).toBe(false);

    clickListener?.(makeEvent(outerLeafB.guides[0]).event);
    executeLatestMeasurement();
    expect(
      selectedSegments.some((guide) =>
        guide.classList.contains("bullet-plugin-selected-indent-guide"),
      ),
    ).toBe(false);
    expect(
      unrelatedSegments.every((guide) =>
        guide.classList.contains("bullet-plugin-selected-indent-guide"),
      ),
    ).toBe(true);

    clickListener?.(makeEvent(outerLeafA.guides[0]).event);
    executeLatestMeasurement();
    settings.verticalLinesAction = "toggle-folding";

    const innerEditor = makeEditor({
      text: [
        "- parent",
        "    - child",
        "        - branch alpha",
        "            - leaf alpha",
        "        - branch beta",
        "            - leaf beta",
        "    - outer sibling",
        "        - outer leaf",
      ].join("\n"),
      cursor: { line: 3, ch: 12 },
    });
    currentEditor = innerEditor;
    const innerRoot = makeRoot({ editor: innerEditor });
    currentRoot = innerRoot;
    const branchAlpha = makeGuideLine(["    ", "    "]);
    const leafAlpha = makeGuideLine(["    ", "    ", "    "]);
    const branchBeta = makeGuideLine(["    ", "    "]);
    const leafBeta = makeGuideLine(["    ", "    ", "    "]);
    branchBeta.guides[1]?.classList.add(
      "bullet-plugin-persistent-indent-guide",
    );
    candidates = [
      ...branchAlpha.guides,
      ...leafAlpha.guides,
      ...branchBeta.guides,
      ...leafBeta.guides,
    ];
    hoveredGuide = leafAlpha.guides[1];
    lineByElement = new Map<unknown, number>([
      [branchAlpha.line, 2],
      [leafAlpha.line, 3],
      [branchBeta.line, 4],
      [leafBeta.line, 5],
    ]);

    pluginValue.update({});
    executeLatestMeasurement();
    const innerSegments = [
      branchAlpha.guides[1],
      leafAlpha.guides[1],
      branchBeta.guides[1],
      leafBeta.guides[1],
    ];
    for (const guide of innerSegments) {
      expect(
        guide?.classList.contains("bullet-plugin-hovered-indent-guide"),
      ).toBe(true);
    }

    // This is a different semantic guide, so the outer selection does not leak.
    expect(
      innerSegments.every((guide) =>
        guide?.classList.contains("bullet-plugin-selected-indent-guide"),
      ),
    ).toBe(false);

    settings.verticalLinesAction = "none";
    clickListener?.(makeEvent(leafAlpha.guides[1]).event);
    executeLatestMeasurement();
    expect(
      innerSegments.every((guide) =>
        guide?.classList.contains("bullet-plugin-selected-indent-guide"),
      ),
    ).toBe(true);

    const replacedBranchAlpha = makeGuideLine(["    ", "    "]);
    const replacedLeafAlpha = makeGuideLine(["    ", "    ", "    "]);
    const replacedBranchBeta = makeGuideLine(["    ", "    "]);
    const replacedLeafBeta = makeGuideLine(["    ", "    ", "    "]);
    const replacementSegments = [
      replacedBranchAlpha.guides[1],
      replacedLeafAlpha.guides[1],
      replacedBranchBeta.guides[1],
      replacedLeafBeta.guides[1],
    ];
    candidates = [
      ...replacedBranchAlpha.guides,
      ...replacedLeafAlpha.guides,
      ...replacedBranchBeta.guides,
      ...replacedLeafBeta.guides,
    ];
    lineByElement = new Map<unknown, number>([
      [replacedBranchAlpha.line, 2],
      [replacedLeafAlpha.line, 3],
      [replacedBranchBeta.line, 4],
      [replacedLeafBeta.line, 5],
    ]);
    pluginValue.update({ docChanged: false });
    executeLatestMeasurement();
    expect(
      replacementSegments.every((guide) =>
        guide?.classList.contains("bullet-plugin-selected-indent-guide"),
      ),
    ).toBe(true);
    expect(
      replacementSegments[0]?.classList.contains(
        "bullet-plugin-selected-indent-guide-start",
      ),
    ).toBe(true);
    expect(
      replacementSegments[replacementSegments.length - 1]?.classList.contains(
        "bullet-plugin-selected-indent-guide-end",
      ),
    ).toBe(true);

    const renderedReplacementCandidates = candidates;
    candidates = [];
    pluginValue.update({ docChanged: false });
    executeLatestMeasurement();
    candidates = renderedReplacementCandidates;
    pluginValue.update({ docChanged: false });
    executeLatestMeasurement();
    expect(
      replacementSegments.every((guide) =>
        guide?.classList.contains("bullet-plugin-selected-indent-guide"),
      ),
    ).toBe(true);

    currentRoot = null;
    pluginValue.update({ docChanged: false });
    const staleRequest = requests[requests.length - 1];
    const staleMeasurement = staleRequest?.read?.();
    currentRoot = innerRoot;
    clickListener?.(makeEvent(replacedLeafAlpha.guides[0]).event);
    staleRequest?.write?.(staleMeasurement, view);
    executeLatestMeasurement();
    const replacementParentSegments = [
      replacedBranchAlpha.guides[0],
      replacedLeafAlpha.guides[0],
      replacedBranchBeta.guides[0],
      replacedLeafBeta.guides[0],
    ];
    expect(
      replacementParentSegments.every((guide) =>
        guide?.classList.contains("bullet-plugin-selected-indent-guide"),
      ),
    ).toBe(true);

    clickListener?.(makeEvent(replacedLeafAlpha.guides[1]).event);
    executeLatestMeasurement();
    currentRoot = null;
    pluginValue.update({ docChanged: false });
    executeLatestMeasurement();
    currentRoot = innerRoot;
    pluginValue.update({ docChanged: false });
    executeLatestMeasurement();
    expect(
      replacementSegments.some((guide) =>
        guide?.classList.contains("bullet-plugin-selected-indent-guide"),
      ),
    ).toBe(false);

    clickListener?.(makeEvent(replacedLeafAlpha.guides[1]).event);
    executeLatestMeasurement();
    const settingsCallback = settingsCallbacks[0];
    if (!settingsCallback) {
      throw new Error("Expected settings callback to be registered");
    }
    settings.verticalLinesAction = "none";
    settingsCallback();
    executeLatestMeasurement();
    for (const guide of innerSegments) {
      expect(
        guide?.classList.contains("bullet-plugin-hovered-indent-guide"),
      ).toBe(false);
    }

    settings.verticalLinesAction = "toggle-folding";
    hoveredGuide = replacedLeafAlpha.guides[1];
    settingsCallback();
    executeLatestMeasurement();
    expect(
      replacedLeafAlpha.guides[1]?.classList.contains(
        "bullet-plugin-hovered-indent-guide",
      ),
    ).toBe(true);
    const pointerMove = addEventListener.mock.calls.find(
      ([eventName]) => eventName === "pointermove",
    )?.[1];
    const pointerLeave = addEventListener.mock.calls.find(
      ([eventName]) => eventName === "pointerleave",
    )?.[1];
    pointerMove?.({ target: replacedLeafAlpha.guides[1] } as unknown as Event);
    hoveredGuide = null;
    pointerLeave?.({} as Event);
    executeLatestMeasurement();
    for (const guide of innerSegments) {
      expect(
        guide?.classList.contains("bullet-plugin-hovered-indent-guide"),
      ).toBe(false);
    }

    // Leaving the view only clears hover feedback; a selection is retained.
    settings.verticalLinesAction = "none";
    clickListener?.(makeEvent(replacedLeafAlpha.guides[1]).event);
    executeLatestMeasurement();
    pointerLeave?.({} as Event);
    expect(
      replacementSegments.every((guide) =>
        guide?.classList.contains("bullet-plugin-selected-indent-guide"),
      ),
    ).toBe(true);

    const otherViewGuide = makeGuideLine(["    "]).guides[0];
    const otherContentDOM = {
      contains: jest.fn((target: unknown) => target === otherViewGuide),
    };
    expect(otherContentDOM.contains(otherViewGuide)).toBe(true);
    documentListeners.get("click")?.(makeEvent(otherViewGuide).event);
    executeLatestMeasurement();
    expect(
      replacementSegments.some((guide) =>
        guide?.classList.contains("bullet-plugin-selected-indent-guide"),
      ),
    ).toBe(false);

    clickListener?.(makeEvent(replacedLeafAlpha.guides[1]).event);
    executeLatestMeasurement();
    pluginValue.update({ docChanged: true });
    executeLatestMeasurement();
    expect(
      replacementSegments.some((guide) =>
        guide?.classList.contains("bullet-plugin-selected-indent-guide"),
      ),
    ).toBe(false);

    clickListener?.(makeEvent(replacedLeafAlpha.guides[1]).event);
    executeLatestMeasurement();

    hoveredGuide = replacedLeafAlpha.guides[1];
    pluginValue.update({});
    executeLatestMeasurement();
    pluginValue.destroy();
    for (const guide of replacementSegments) {
      expect(
        guide?.classList.contains("bullet-plugin-hovered-indent-guide"),
      ).toBe(false);
      expect(
        guide?.classList.contains("bullet-plugin-selected-indent-guide"),
      ).toBe(false);
    }
    expect(removeEventListener).toHaveBeenCalledWith(
      "pointermove",
      pointerMove,
      true,
    );
    expect(removeEventListener).toHaveBeenCalledWith(
      "pointerleave",
      pointerLeave,
      true,
    );
    expect(ownerDocument.addEventListener).toHaveBeenCalledWith(
      "click",
      expect.any(Function),
      true,
    );
    expect(ownerDocument.removeEventListener).toHaveBeenCalledWith(
      "click",
      expect.any(Function),
      true,
    );
  });

  test("measures and synchronizes whole outer chunks across DOM replacement and cleanup", () => {
    type CapturedListener = (event: Event) => void;
    type HoverMeasurement = {
      indentGuides: Element[];
      outerGuides: Element[];
    };
    type Measurement = {
      read?: () => HoverMeasurement;
      write?: (measure: HoverMeasurement, view: unknown) => void;
    };
    const addEventListener = jest.fn<
      void,
      [string, CapturedListener, boolean]
    >();
    const settingsCallbacks: Array<() => void> = [];
    const settings = {
      outerVerticalLines: true,
      verticalLinesAction: "toggle-folding",
      onChange: jest.fn((keys: unknown, callback?: () => void) => {
        settingsCallbacks.push(callback ?? (keys as () => void));
      }),
      removeCallback: jest.fn(),
    };
    const makeOuterSegment = (chunkId: string, actionable = true) => {
      const [startLine, endLine] = chunkId.split(":");
      const dataset = {
        chunkId,
        actionable: String(actionable),
        chunkStart: startLine ?? "",
        chunkEnd: endLine ?? "",
      };
      return {
        dataset,
        classList: makeClassList(),
        matches: jest.fn(
          (selector: string) => selector === ".bullet-plugin-outer-list-guide",
        ),
        closest: jest.fn(),
        getAttribute: jest.fn((name: string) => {
          if (name === "data-actionable") return dataset.actionable;
          if (name === "data-chunk-start") return dataset.chunkStart;
          if (name === "data-chunk-end") return dataset.chunkEnd;
          return null;
        }),
      };
    };
    let outerGuides = [
      makeOuterSegment("0:2"),
      makeOuterSegment("0:2"),
      makeOuterSegment("4:5"),
    ];
    let hoveredOuter: (typeof outerGuides)[number] | null = outerGuides[0];
    const querySelector = jest.fn((selector: string) => {
      if (
        selector ===
        '.bullet-plugin-outer-list-guide[data-actionable="true"]:hover'
      ) {
        return hoveredOuter;
      }
      return null;
    });
    const querySelectorAll = jest.fn((selector: string) => {
      if (selector === ".bullet-plugin-outer-list-guide") return outerGuides;
      if (selector === ".bullet-plugin-hovered-outer-list-guide") {
        return outerGuides.filter((guide) =>
          guide.classList.contains("bullet-plugin-hovered-outer-list-guide"),
        );
      }
      if (selector === ".bullet-plugin-hovered-outer-list-guide-start") {
        return outerGuides.filter((guide) =>
          guide.classList.contains(
            "bullet-plugin-hovered-outer-list-guide-start",
          ),
        );
      }
      if (selector === ".bullet-plugin-hovered-outer-list-guide-end") {
        return outerGuides.filter((guide) =>
          guide.classList.contains(
            "bullet-plugin-hovered-outer-list-guide-end",
          ),
        );
      }
      if (selector === ".bullet-plugin-selected-outer-list-guide") {
        return outerGuides.filter((guide) =>
          guide.classList.contains("bullet-plugin-selected-outer-list-guide"),
        );
      }
      if (selector === ".bullet-plugin-selected-outer-list-guide-start") {
        return outerGuides.filter((guide) =>
          guide.classList.contains(
            "bullet-plugin-selected-outer-list-guide-start",
          ),
        );
      }
      if (selector === ".bullet-plugin-selected-outer-list-guide-end") {
        return outerGuides.filter((guide) =>
          guide.classList.contains(
            "bullet-plugin-selected-outer-list-guide-end",
          ),
        );
      }
      return [];
    });
    const contentDOM = {
      addEventListener,
      removeEventListener: jest.fn(),
      querySelector,
      querySelectorAll,
    };
    const requests: Measurement[] = [];
    const sourceEditor = makeEditor({
      text: "- parent\n    - child\n- leaf",
      cursor: { line: 0, ch: 0 },
    });
    mockGetEditorFromState.mockReturnValue(sourceEditor);
    const view = {
      contentDOM,
      state: { doc: Text.of(["- parent", "    - child", "- leaf"]) },
      dispatch: jest.fn(),
      requestMeasure: jest.fn((request: Measurement) => requests.push(request)),
    };
    const PluginValueWithView = GuideFoldingPluginValue as unknown as new (
      settings: unknown,
      parser: unknown,
      view: unknown,
    ) => {
      decorations: DecorationSet;
      destroy(): void;
      update(update: unknown): void;
    };
    const semanticParser = new Parser(makeLogger(), makeSettings());
    const parser = {
      isListItem: (line: string) => semanticParser.isListItem(line),
      parseRange: jest.fn(
        (editor: Reader, startLine: number, endLine: number) =>
          semanticParser.parseRange(editor, startLine, endLine),
      ),
    };
    const pluginValue = new PluginValueWithView(settings, parser, view);
    const executeLatestMeasurement = () => {
      const request = requests[requests.length - 1];
      const measurement = request?.read?.();
      if (!measurement) throw new Error("Expected hover measurement");
      expect(measurement.indentGuides).toEqual([]);
      request?.write?.(measurement, view);
      return measurement;
    };

    const firstMeasurement = requests[0]?.read?.();
    expect(firstMeasurement).toMatchObject({
      indentGuides: [],
      outerGuides: outerGuides.slice(0, 2),
    });
    expect(
      outerGuides.some((guide) =>
        guide.classList.contains("bullet-plugin-hovered-outer-list-guide"),
      ),
    ).toBe(false);
    requests[0]?.write?.(firstMeasurement!, view);
    expect(
      outerGuides
        .slice(0, 2)
        .every((guide) =>
          guide.classList.contains("bullet-plugin-hovered-outer-list-guide"),
        ),
    ).toBe(true);
    expect(
      outerGuides[0]?.classList.contains(
        "bullet-plugin-hovered-outer-list-guide-start",
      ),
    ).toBe(true);
    expect(
      outerGuides[0]?.classList.contains(
        "bullet-plugin-hovered-outer-list-guide-end",
      ),
    ).toBe(false);
    expect(
      outerGuides[1]?.classList.contains(
        "bullet-plugin-hovered-outer-list-guide-start",
      ),
    ).toBe(false);
    expect(
      outerGuides[1]?.classList.contains(
        "bullet-plugin-hovered-outer-list-guide-end",
      ),
    ).toBe(true);

    const oldGuides = outerGuides;
    const decorationSet = pluginValue.decorations;
    outerGuides = [makeOuterSegment("0:2"), makeOuterSegment("0:2")];
    hoveredOuter = outerGuides[1]!;
    pluginValue.update({ docChanged: false });
    expect(pluginValue.decorations).toBe(decorationSet);
    expect(executeLatestMeasurement().outerGuides).toEqual(outerGuides);
    expect(
      outerGuides.every((guide) =>
        guide.classList.contains("bullet-plugin-hovered-outer-list-guide"),
      ),
    ).toBe(true);

    const pointerMove = addEventListener.mock.calls.find(
      ([eventName]) => eventName === "pointermove",
    )?.[1];
    const pointerLeave = addEventListener.mock.calls.find(
      ([eventName]) => eventName === "pointerleave",
    )?.[1];
    pointerMove?.({ target: outerGuides[0] } as unknown as Event);
    expect(requests).toHaveLength(3);
    pointerMove?.({
      target: makeOuterSegment("6:6", false),
    } as unknown as Event);
    expect(requests).toHaveLength(3);
    expect(
      outerGuides.some((guide) =>
        guide.classList.contains("bullet-plugin-hovered-outer-list-guide"),
      ),
    ).toBe(false);
    expect(
      outerGuides.some(
        (guide) =>
          guide.classList.contains(
            "bullet-plugin-hovered-outer-list-guide-start",
          ) ||
          guide.classList.contains(
            "bullet-plugin-hovered-outer-list-guide-end",
          ),
      ),
    ).toBe(false);
    pointerLeave?.({} as Event);
    expect(
      outerGuides.some((guide) =>
        guide.classList.contains("bullet-plugin-hovered-outer-list-guide"),
      ),
    ).toBe(false);

    hoveredOuter = outerGuides[0]!;
    pluginValue.update({ docChanged: false });
    executeLatestMeasurement();
    const settingsCallback = settingsCallbacks[0];
    settings.verticalLinesAction = "none";
    settingsCallback();
    expect(
      outerGuides.some((guide) =>
        guide.classList.contains("bullet-plugin-hovered-outer-list-guide"),
      ),
    ).toBe(false);

    settings.verticalLinesAction = "toggle-folding";
    settingsCallback();
    executeLatestMeasurement();
    settings.outerVerticalLines = false;
    settingsCallback();
    expect(
      outerGuides.some((guide) =>
        guide.classList.contains("bullet-plugin-hovered-outer-list-guide"),
      ),
    ).toBe(false);

    settings.outerVerticalLines = true;
    settingsCallback();
    executeLatestMeasurement();

    settings.verticalLinesAction = "toggle-folding";
    outerGuides[0].dataset.actionable = "false";
    view.dispatch.mockClear();
    const clickListener = addEventListener.mock.calls.find(
      ([eventName]) => eventName === "click",
    )?.[1];
    clickListener?.(makeEvent(outerGuides[0]).event);
    executeLatestMeasurement();
    expect(
      outerGuides
        .slice(0, 2)
        .every((guide) =>
          guide.classList.contains("bullet-plugin-selected-outer-list-guide"),
        ),
    ).toBe(true);
    expect(outerGuides[0].getAttribute).toHaveBeenCalledWith("data-actionable");
    expect(view.dispatch).not.toHaveBeenCalled();

    clickListener?.(makeEvent(makeOuterSegment("1:1")).event);
    executeLatestMeasurement();
    expect(
      outerGuides
        .slice(0, 2)
        .every((guide) =>
          guide.classList.contains("bullet-plugin-selected-outer-list-guide"),
        ),
    ).toBe(true);

    settings.outerVerticalLines = false;
    outerGuides = [];
    settingsCallback();
    executeLatestMeasurement();
    settings.outerVerticalLines = true;
    outerGuides = [makeOuterSegment("0:2"), makeOuterSegment("0:2")];
    hoveredOuter = outerGuides[0]!;
    settingsCallback();
    executeLatestMeasurement();
    expect(
      outerGuides.every((guide) =>
        guide.classList.contains("bullet-plugin-selected-outer-list-guide"),
      ),
    ).toBe(true);

    pluginValue.update({ docChanged: true });
    executeLatestMeasurement();
    expect(
      outerGuides.some((guide) =>
        guide.classList.contains("bullet-plugin-selected-outer-list-guide"),
      ),
    ).toBe(false);

    parser.parseRange.mockReturnValueOnce([]);
    view.dispatch.mockClear();
    clickListener?.(makeEvent(outerGuides[0]).event);
    executeLatestMeasurement();
    expect(
      outerGuides.every((guide) =>
        guide.classList.contains("bullet-plugin-selected-outer-list-guide"),
      ),
    ).toBe(true);
    expect(view.dispatch).not.toHaveBeenCalled();

    pluginValue.destroy();
    expect(
      outerGuides.some((guide) =>
        guide.classList.contains("bullet-plugin-hovered-outer-list-guide"),
      ),
    ).toBe(false);
    expect(
      outerGuides.some((guide) =>
        guide.classList.contains("bullet-plugin-selected-outer-list-guide"),
      ),
    ).toBe(false);
    // Detached replacements are outside contentDOM, so scoped cleanup cannot reach them.
    expect(
      oldGuides
        .slice(0, 2)
        .every((guide) =>
          guide.classList.contains("bullet-plugin-hovered-outer-list-guide"),
        ),
    ).toBe(true);
  });

  test("promotes and highlights a hovered spacing guide in one measurement", () => {
    type Measurement = {
      read?: () => unknown;
      write?: (measure: unknown, view: unknown) => void;
    };
    const editor = makeEditor({
      text: ["- parent", "    - child"].join("\n"),
      cursor: { line: 1, ch: 4 },
    });
    const root = makeRoot({ editor });
    const { guides, line } = makeGuideLine(["    "]);
    const hoveredSpacing = guides[0];
    if (!hoveredSpacing) {
      throw new Error("Expected a spacing guide");
    }
    hoveredSpacing.classList.add("cm-indent-spacing");

    const querySelector = jest.fn((selector: string) =>
      selector ===
      ".cm-indent:hover, .cm-hmd-list-indent > .cm-indent-spacing:hover"
        ? hoveredSpacing
        : null,
    );
    const querySelectorAll = jest.fn((selector: string) => {
      if (
        selector === ".cm-hmd-list-indent > .cm-indent-spacing:not(.cm-indent)"
      ) {
        return hoveredSpacing.classList.contains("cm-indent")
          ? []
          : [hoveredSpacing];
      }
      if (
        selector ===
        ".cm-hmd-list-indent > .cm-indent, .cm-hmd-list-indent > .cm-indent-spacing"
      ) {
        return [hoveredSpacing];
      }
      if (selector === ".bullet-plugin-hovered-indent-guide") {
        return hoveredSpacing.classList.contains(
          "bullet-plugin-hovered-indent-guide",
        )
          ? [hoveredSpacing]
          : [];
      }
      return [];
    });
    const requests: Measurement[] = [];
    const contentDOM = {
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      querySelector,
      querySelectorAll,
    };
    const view = {
      contentDOM,
      state: {
        doc: {
          lineAt: jest.fn((offset: number) => ({ number: offset + 1 })),
        },
      },
      posAtDOM: jest.fn((element: unknown) => {
        if (element !== line) {
          throw new Error("Expected the hovered guide line");
        }
        return 1;
      }),
      requestMeasure: jest.fn((request: Measurement) => {
        requests.push(request);
      }),
    };
    const settings = {
      verticalLinesAction: "toggle-folding",
      onChange: jest.fn(),
      removeCallback: jest.fn(),
    };
    mockGetEditorFromState.mockReturnValue(editor);
    const PluginValueWithView = GuideFoldingPluginValue as unknown as new (
      settings: unknown,
      parser: unknown,
      view: unknown,
    ) => unknown;

    new PluginValueWithView(settings, { parse: jest.fn(() => root) }, view);

    const request = requests[0];
    const measurement = request?.read?.();
    request?.write?.(measurement, view);

    expect(querySelector).toHaveBeenCalledWith(
      ".cm-indent:hover, .cm-hmd-list-indent > .cm-indent-spacing:hover",
    );
    expect(hoveredSpacing.classList.contains("cm-indent")).toBe(true);
    expect(
      hoveredSpacing.classList.contains(
        "bullet-plugin-persistent-indent-guide",
      ),
    ).toBe(true);
    expect(
      hoveredSpacing.classList.contains("bullet-plugin-hovered-indent-guide"),
    ).toBe(true);
  });

  test("schedules synchronization after construction, updates, and settings changes", () => {
    const guide = makeGuideElement(["cm-indent-spacing"]);
    const { contentDOM } = makeGuideDOM([guide]);
    const settingsCallbacks: Array<() => void> = [];
    const settings = {
      verticalLinesAction: "toggle-folding",
      onChange: jest.fn((keys: unknown, callback?: () => void) => {
        settingsCallbacks.push(callback ?? (keys as () => void));
      }),
      removeCallback: jest.fn(),
    };
    const requests: Array<{
      key?: unknown;
      write?: (measure: unknown, view: unknown) => void;
    }> = [];
    const view = {
      contentDOM,
      dispatch: jest.fn(),
      requestMeasure: jest.fn(
        (request: {
          key?: unknown;
          write?: (measure: unknown, view: unknown) => void;
        }) => {
          requests.push(request);
        },
      ),
    };
    const PluginValueWithView = GuideFoldingPluginValue as unknown as new (
      settings: unknown,
      parser: unknown,
      view: unknown,
    ) => { update(update: unknown): void };
    const pluginValue = new PluginValueWithView(
      settings,
      { parse: jest.fn() },
      view,
    );

    expect(requests).toHaveLength(1);
    requests[0]?.write?.(undefined, view);
    expect(guide.classList.contains("cm-indent")).toBe(true);

    pluginValue.update({});
    expect(requests).toHaveLength(2);

    const settingsCallback = settingsCallbacks[0];
    if (!settingsCallback) {
      throw new Error("Expected settings callback to be registered");
    }
    settingsCallback();
    expect(requests).toHaveLength(3);
    expect(requests[1]?.key).toBe(requests[0]?.key);
    expect(requests[2]?.key).toBe(requests[0]?.key);
  });

  test("cleans up synchronously and ignores queued writes after destroy", () => {
    const promoted = makeGuideElement(["cm-indent-spacing"]);
    const elements = [promoted];
    const { contentDOM } = makeGuideDOM(elements);
    const settingsCallbacks: Array<() => void> = [];
    const settings = {
      verticalLinesAction: "toggle-folding",
      onChange: jest.fn((keys: unknown, callback?: () => void) => {
        settingsCallbacks.push(callback ?? (keys as () => void));
      }),
      removeCallback: jest.fn(),
    };
    const requests: Array<{
      write?: (measure: unknown, view: unknown) => void;
    }> = [];
    const view = {
      contentDOM,
      requestMeasure: jest.fn(
        (request: { write?: (measure: unknown, view: unknown) => void }) => {
          requests.push(request);
        },
      ),
    };
    const PluginValueWithView = GuideFoldingPluginValue as unknown as new (
      settings: unknown,
      parser: unknown,
      view: unknown,
    ) => { destroy(): void; update(update: unknown): void };
    const pluginValue = new PluginValueWithView(
      settings,
      { parse: jest.fn() },
      view,
    );

    requests[0]?.write?.(undefined, view);
    expect(promoted.classList.contains("cm-indent")).toBe(true);
    pluginValue.update({});
    const queuedWrite = requests[1]?.write;

    pluginValue.destroy();

    expect(promoted.classList.contains("cm-indent")).toBe(false);
    expect(
      promoted.classList.contains("bullet-plugin-persistent-indent-guide"),
    ).toBe(false);
    expect(settings.removeCallback).toHaveBeenCalledWith(settingsCallbacks[0]);

    const laterSpacing = makeGuideElement(["cm-indent-spacing"]);
    elements.push(laterSpacing);
    queuedWrite?.(undefined, view);
    expect(laterSpacing.classList.contains("cm-indent")).toBe(false);
  });

  test("toggles only the root parsed from an actionable outer widget range", () => {
    const sourceEditor = makeEditor({
      text: "- parent\n    - child\n- leaf",
      cursor: { line: 0, ch: 0 },
    });
    const root = makeRoot({ editor: sourceEditor });
    const editor = makeFoldEditor();
    mockGetEditorFromState.mockReturnValue(editor);
    const parser = {
      parse: jest.fn(),
      parseRange: jest.fn().mockReturnValue([root]),
    };
    const pluginValue = makeInteractionHarness(
      {
        outerVerticalLines: true,
        verticalLinesAction: "toggle-folding",
      },
      parser,
    );
    const target = makeOuterGuideTarget();
    const { event, preventDefault } = makeEvent(target);
    const view = makeView(1);

    expect(pluginValue.click(event, view)).toBe(true);
    expect(parser.parseRange).toHaveBeenCalledTimes(1);
    expect(parser.parse).not.toHaveBeenCalled();
    expect(view.posAtDOM).not.toHaveBeenCalled();
    expect(foldable).toHaveBeenCalledWith(expect.anything(), 0, 9);
    expect(view.dispatch).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  test("unfolds every foldable top-level item when the current chunk is closed", () => {
    const sourceEditor = makeEditor({
      text: "- parent A\n    - child A\n- leaf\n- parent B\n    - child B",
      cursor: { line: 0, ch: 0 },
      getAllFoldedLines: () => [0, 3],
    });
    const root = makeRoot({ editor: sourceEditor });
    const editor = makeFoldEditor();
    mockGetEditorFromState.mockReturnValue(editor);
    const pluginValue = makeInteractionHarness(
      {
        outerVerticalLines: true,
        verticalLinesAction: "toggle-folding",
      },
      { parseRange: jest.fn().mockReturnValue([root]) },
    );
    const { event, preventDefault } = makeEvent(
      makeOuterGuideTarget({
        "data-actionable": "true",
        "data-chunk-start": "0",
        "data-chunk-end": "4",
      }),
    );

    const view = makeView(1);
    expect(pluginValue.click(event, view)).toBe(true);
    expect(mockedUnfoldEffectOf).toHaveBeenNthCalledWith(1, {
      from: 1,
      to: 9,
    });
    expect(mockedUnfoldEffectOf).toHaveBeenNthCalledWith(2, {
      from: 31,
      to: 39,
    });
    expect(view.dispatch).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  test("mousedown suppresses selection without toggling before click", () => {
    const sourceEditor = makeEditor({
      text: "- parent\n    - child\n- leaf",
      cursor: { line: 0, ch: 0 },
    });
    const root = makeRoot({ editor: sourceEditor });
    const editor = makeFoldEditor();
    mockGetEditorFromState.mockReturnValue(editor);
    const parser = {
      parse: jest.fn(),
      parseRange: jest.fn().mockReturnValue([root]),
    };
    const pluginValue = makeInteractionHarness(
      {
        outerVerticalLines: true,
        verticalLinesAction: "toggle-folding",
      },
      parser,
    );
    const { event, preventDefault } = makeEvent(makeOuterGuideTarget());

    const view = makeView(1);
    expect(pluginValue.mouseDown(event, view)).toBe(true);
    expect(parser.parseRange).not.toHaveBeenCalled();
    expect(view.dispatch).not.toHaveBeenCalled();
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  test("mousedown suppresses selection on a native guide without toggling", () => {
    const root = makeRoot({
      editor: makeEditor({
        text: "- parent\n    - child\n        - leaf",
        cursor: { line: 2, ch: 8 },
      }),
    });
    const editor = makeFoldEditor();
    mockGetEditorFromState.mockReturnValue(editor);
    const parser = { parse: jest.fn().mockReturnValue(root) };
    const pluginValue = makeInteractionHarness(
      {
        verticalLinesAction: "toggle-folding",
      },
      parser,
    );
    const { guides } = makeGuideLine(["    ", "    "]);
    const { event, preventDefault } = makeEvent(guides[0]);

    const view = makeView(2);
    expect(pluginValue.mouseDown(event, view)).toBe(true);
    expect(parser.parse).toHaveBeenCalledWith(editor, { line: 2, ch: 0 });
    expect(view.dispatch).not.toHaveBeenCalled();
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  test.each([
    [
      "non-actionable widget",
      { outerVerticalLines: true },
      {
        "data-actionable": "false",
        "data-chunk-start": "0",
        "data-chunk-end": "2",
      },
    ],
    [
      "malformed range",
      { outerVerticalLines: true },
      {
        "data-actionable": "true",
        "data-chunk-start": "not-a-line",
        "data-chunk-end": "2",
      },
    ],
    [
      "missing range",
      { outerVerticalLines: true },
      { "data-actionable": "true" },
    ],
    [
      "blank range",
      { outerVerticalLines: true },
      {
        "data-actionable": "true",
        "data-chunk-start": " ",
        "data-chunk-end": "2",
      },
    ],
    [
      "out-of-bounds range",
      { outerVerticalLines: true },
      {
        "data-actionable": "true",
        "data-chunk-start": "0",
        "data-chunk-end": "99",
      },
    ],
    [
      "disabled action",
      {
        outerVerticalLines: true,
        verticalLinesAction: "none",
      },
      undefined,
    ],
    ["outer visibility off", { outerVerticalLines: false }, undefined],
  ])("handles a %s outer widget", (_name, visibility, attributes) => {
    const parser = { parse: jest.fn(), parseRange: jest.fn() };
    mockGetEditorFromState.mockReturnValue(makeFoldEditor());
    const pluginValue = makeInteractionHarness(
      {
        verticalLinesAction: "toggle-folding",
        ...visibility,
      },
      parser,
    );
    const { event, preventDefault } = makeEvent(
      makeOuterGuideTarget(attributes),
    );

    const selectable =
      _name === "non-actionable widget" || _name === "disabled action";
    expect(pluginValue.click(event, makeView(1))).toBe(selectable);
    expect(parser.parseRange).not.toHaveBeenCalled();
    expect(preventDefault).toHaveBeenCalledTimes(selectable ? 1 : 0);
  });

  test("retains an actionable outer selection when the chunk has no fold targets", () => {
    const sourceEditor = makeEditor({
      text: "- leaf A\n- leaf B",
      cursor: { line: 0, ch: 0 },
    });
    const editor = makeFoldEditor();
    mockGetEditorFromState.mockReturnValue(editor);
    const parser = {
      parseRange: jest
        .fn()
        .mockReturnValue([makeRoot({ editor: sourceEditor })]),
    };
    const pluginValue = makeInteractionHarness(
      {
        outerVerticalLines: true,
        verticalLinesAction: "toggle-folding",
      },
      parser,
    );
    const { event, preventDefault } = makeEvent(
      makeOuterGuideTarget({
        "data-actionable": "true",
        "data-chunk-start": "0",
        "data-chunk-end": "1",
      }),
    );

    const view = makeView(1);
    expect(pluginValue.click(event, view)).toBe(true);
    expect(parser.parseRange).toHaveBeenCalledWith(editor, 0, 1);
    expect(view.dispatch).not.toHaveBeenCalled();
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  test("retains an outer selection when no planned fold range can be updated", () => {
    const sourceEditor = makeEditor({
      text: "- parent\n    - child",
      cursor: { line: 0, ch: 0 },
    });
    const editor = makeFoldEditor();
    jest.mocked(foldable).mockReturnValue(null);
    mockGetEditorFromState.mockReturnValue(editor);
    const pluginValue = makeInteractionHarness(
      {
        outerVerticalLines: true,
        verticalLinesAction: "toggle-folding",
      },
      {
        parseRange: jest
          .fn()
          .mockReturnValue([makeRoot({ editor: sourceEditor })]),
      },
    );
    const { event, preventDefault } = makeEvent(
      makeOuterGuideTarget({
        "data-actionable": "true",
        "data-chunk-start": "0",
        "data-chunk-end": "1",
      }),
    );

    const view = makeView(1);
    expect(pluginValue.click(event, view)).toBe(true);
    expect(foldable).toHaveBeenCalledTimes(1);
    expect(view.dispatch).not.toHaveBeenCalled();
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  test("capture listeners suppress mousedown selection and toggle on click", () => {
    type CapturedListener = (event: Event) => void;
    const addEventListener = jest.fn<
      void,
      [string, CapturedListener, boolean]
    >();
    const sourceEditor = makeEditor({
      text: "- parent\n    - child",
      cursor: { line: 0, ch: 0 },
    });
    const editor = makeFoldEditor();
    mockGetEditorFromState.mockReturnValue(null);
    const settings = {
      outerVerticalLines: true,
      verticalLinesAction: "toggle-folding",
      onChange: jest.fn(),
      removeCallback: jest.fn(),
    };
    const contentDOM = {
      addEventListener,
      removeEventListener: jest.fn(),
      querySelector: jest.fn().mockReturnValue(null),
      querySelectorAll: jest.fn().mockReturnValue([]),
      style: { paddingBottom: "1000px" },
    };
    const PluginValueWithView = GuideFoldingPluginValue as unknown as new (
      settings: unknown,
      parser: unknown,
      view: unknown,
    ) => unknown;
    const root = makeRoot({ editor: sourceEditor });
    const parseRange = jest.fn().mockReturnValue([root]);
    const view = Object.assign(makeView(0), {
      contentDOM,
      requestMeasure: jest.fn(),
    });
    new PluginValueWithView(settings, { parseRange }, view);
    mockGetEditorFromState.mockReturnValue(editor);
    const mouseDownListener = addEventListener.mock.calls.find(
      ([eventName]) => eventName === "mousedown",
    )?.[1];
    const clickListener = addEventListener.mock.calls.find(
      ([eventName]) => eventName === "click",
    )?.[1];
    const mouseDownStopPropagation = jest.fn();
    const mouseDownPreventDefault = jest.fn();
    const clickStopPropagation = jest.fn();
    const clickPreventDefault = jest.fn();
    const target = makeOuterGuideTarget({
      "data-actionable": "true",
      "data-chunk-start": "0",
      "data-chunk-end": "1",
    });

    mouseDownListener?.({
      target,
      preventDefault: mouseDownPreventDefault,
      stopPropagation: mouseDownStopPropagation,
    } as unknown as Event);
    expect(view.dispatch).not.toHaveBeenCalled();

    clickListener?.({
      target,
      preventDefault: clickPreventDefault,
      stopPropagation: clickStopPropagation,
    } as unknown as Event);
    for (const start of ["0x1", "1e0", "+1", "1.0"]) {
      clickListener?.({
        target: makeOuterGuideTarget({
          "data-actionable": "true",
          "data-chunk-start": start,
          "data-chunk-end": "1",
        }),
        preventDefault: clickPreventDefault,
        stopPropagation: clickStopPropagation,
      } as unknown as Event);
    }
    clickListener?.({
      target: makeOuterGuideTarget({
        "data-actionable": "true",
        "data-chunk-start": "1",
        "data-chunk-end": "1",
      }),
      preventDefault: clickPreventDefault,
      stopPropagation: clickStopPropagation,
    } as unknown as Event);

    expect(parseRange).toHaveBeenCalledTimes(2);
    expect(parseRange).toHaveBeenNthCalledWith(1, editor, 0, 1);
    expect(parseRange).toHaveBeenNthCalledWith(2, editor, 1, 1);
    expect(view.dispatch).toHaveBeenCalledTimes(1);
    expect(mouseDownPreventDefault).toHaveBeenCalledTimes(1);
    expect(mouseDownStopPropagation).toHaveBeenCalledTimes(1);
    expect(clickPreventDefault).toHaveBeenCalledTimes(2);
    expect(clickStopPropagation).toHaveBeenCalledTimes(2);
  });

  test("consumes an outer selection when optional folding parses multiple roots", () => {
    const sourceEditor = makeEditor({
      text: "- parent\n    - child",
      cursor: { line: 0, ch: 0 },
    });
    const root = makeRoot({ editor: sourceEditor });
    const editor = makeFoldEditor();
    mockGetEditorFromState.mockReturnValue(editor);
    const parser = { parseRange: jest.fn().mockReturnValue([root, root]) };
    const pluginValue = makeInteractionHarness(
      {
        outerVerticalLines: true,
        verticalLinesAction: "toggle-folding",
      },
      parser,
    );
    const { event, preventDefault } = makeEvent(
      makeOuterGuideTarget({
        "data-actionable": "true",
        "data-chunk-start": "0",
        "data-chunk-end": "1",
      }),
    );

    const view = makeView(1);
    expect(pluginValue.click(event, view)).toBe(true);
    expect(view.dispatch).not.toHaveBeenCalled();
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  test("folds the outermost ancestor represented by a native indentation guide", () => {
    const root = makeRoot({
      editor: makeEditor({
        text: [
          "- parent",
          "  - branch one",
          "    - leaf one",
          "  - leaf sibling",
          "  - branch two",
          "    - leaf two",
        ].join("\n"),
        cursor: { line: 2, ch: 4 },
      }),
    });
    const editor = makeFoldEditor();
    mockGetEditorFromState.mockReturnValue(editor);
    const parser = { parse: jest.fn().mockReturnValue(root) };
    const pluginValue = makeInteractionHarness(
      {
        verticalLinesAction: "toggle-folding",
      },
      parser,
    );
    const { guides, line } = makeGuideLine(["    "]);
    const { event, preventDefault } = makeEvent(guides[0]);
    const view = makeView(2);

    expect(pluginValue.click(event, view)).toBe(true);
    expect(view.posAtDOM).toHaveBeenCalledWith(line);
    expect(parser.parse).toHaveBeenCalledWith(editor, { line: 2, ch: 0 });
    expect(foldable).toHaveBeenNthCalledWith(1, expect.anything(), 10, 19);
    expect(foldable).toHaveBeenNthCalledWith(2, expect.anything(), 40, 49);
    expect(view.dispatch).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  test("folds only the child branch represented by an inner guide", () => {
    const root = makeRoot({
      editor: makeEditor({
        text: [
          "- parent",
          "    - child",
          "        - branch alpha",
          "            - leaf alpha",
          "        - branch beta",
          "            - leaf beta",
          "    - outer sibling",
          "        - outer leaf",
        ].join("\n"),
        cursor: { line: 3, ch: 12 },
      }),
    });
    const editor = makeFoldEditor();
    mockGetEditorFromState.mockReturnValue(editor);
    const parser = { parse: jest.fn().mockReturnValue(root) };
    const pluginValue = makeInteractionHarness(
      {
        verticalLinesAction: "toggle-folding",
      },
      parser,
    );
    const { guides, line } = makeGuideLine(["    ", "    ", "    "]);
    const { event, preventDefault } = makeEvent(guides[1]);
    const view = makeView(3);

    expect(pluginValue.click(event, view)).toBe(true);
    expect(view.posAtDOM).toHaveBeenCalledWith(line);
    expect(parser.parse).toHaveBeenCalledWith(editor, { line: 3, ch: 0 });
    expect(foldable).toHaveBeenNthCalledWith(1, expect.anything(), 20, 29);
    expect(foldable).toHaveBeenNthCalledWith(2, expect.anything(), 40, 49);
    expect(view.dispatch).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  test("ignores guides when the folding action is disabled", () => {
    const settings = { verticalLinesAction: "none" };
    const pluginValue = makeInteractionHarness(settings, { parse: jest.fn() });
    const { guides } = makeGuideLine();
    const { event, preventDefault } = makeEvent(guides[0]);

    expect(pluginValue.click(event, makeView(1))).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  test("ignores targets that are not native indentation guides", () => {
    const target = {
      matches: jest.fn().mockReturnValue(false),
      closest: jest.fn(),
    };
    const { event, preventDefault } = makeEvent(target);
    const pluginValue = makeInteractionHarness(
      {
        verticalLinesAction: "toggle-folding",
      },
      { parse: jest.fn() },
    );

    expect(pluginValue.click(event, makeView(1))).toBe(false);
    expect(target.closest).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  test("ignores a guide while editor state is unavailable", () => {
    const pluginValue = makeInteractionHarness(
      {
        verticalLinesAction: "toggle-folding",
      },
      { parse: jest.fn() },
    );
    const { guides } = makeGuideLine();
    const { event, preventDefault } = makeEvent(guides[0]);

    expect(pluginValue.click(event, makeView(1))).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  test("ignores a guide when the containing list cannot be parsed", () => {
    const editor = makeFoldEditor();
    mockGetEditorFromState.mockReturnValue(editor);
    const pluginValue = makeInteractionHarness(
      {
        verticalLinesAction: "toggle-folding",
      },
      { parse: jest.fn().mockReturnValue(null) },
    );
    const { guides } = makeGuideLine();
    const { event, preventDefault } = makeEvent(guides[0]);

    expect(pluginValue.click(event, makeView(1))).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  test("ignores a guide that has no corresponding list ancestor", () => {
    const root = makeRoot({
      editor: makeEditor({
        text: "  - root item\n    - child",
        cursor: { line: 0, ch: 2 },
      }),
    });
    const editor = makeFoldEditor();
    mockGetEditorFromState.mockReturnValue(editor);
    const pluginValue = makeInteractionHarness(
      {
        verticalLinesAction: "toggle-folding",
      },
      { parse: jest.fn().mockReturnValue(root) },
    );
    const { guides } = makeGuideLine();
    const { event, preventDefault } = makeEvent(guides[0]);

    expect(pluginValue.click(event, makeView(0))).toBe(false);
    expect(foldable).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });
});
