// Run with the current test build deployed to the repository's running vault.
// Requires obsidian-cli; run separately from full tests or other UI checks.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const path = require("node:path");

const vaultPath = path.resolve(__dirname, "../vault");
const notePath = `bullet-resize-verification-${randomUUID()}.md`;
const withFrontmatter = process.argv.includes("--frontmatter");

function cdp(method, params) {
  return JSON.parse(
    execFileSync(
      "obsidian-cli",
      [
        "vault=vault",
        "dev:cdp",
        `method=${method}`,
        `params=${JSON.stringify(params)}`,
      ],
      { encoding: "utf8" },
    ),
  );
}

function evaluate(fn, ...args) {
  const expression = `(async () => {
    if (app.vault.adapter.getBasePath() !== ${JSON.stringify(vaultPath)} ||
        app.vault.config.useTab !== true || app.vault.config.tabSize !== 4 ||
        document.body.classList.contains('is-mobile')) throw Error('Test vault guard');
    return (${fn.toString()})(...${JSON.stringify(args)});
  })()`;
  const result = cdp("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw Error(
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text,
    );
  }
  return result.result.value;
}

function sample() {
  return evaluate(async () => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const view = app.workspace.activeLeaf.view.editor.cm;
    const top = view.scrollDOM.getBoundingClientRect().top;
    const line = [...view.contentDOM.querySelectorAll(".cm-line")].find(
      (element) => element.getBoundingClientRect().bottom > top + 3,
    );
    const parent = [...view.contentDOM.querySelectorAll(".cm-line")].find(
      (element) => element.textContent.includes("Last parent"),
    );
    const metadata = app.workspace.activeLeaf.view.containerEl.querySelector(
      ".metadata-container",
    );
    return {
      width: innerWidth,
      line: line ? view.state.doc.lineAt(view.posAtDOM(line)).number : null,
      y: line ? line.getBoundingClientRect().top - top : null,
      scrollTop: view.scrollDOM.scrollTop,
      inlinePadding: view.contentDOM.style.paddingBottom,
      effectivePadding: getComputedStyle(view.contentDOM).paddingBottom,
      parentFolded: !!parent?.querySelector(".cm-fold-indicator.is-collapsed"),
      metadataHeight: metadata?.getBoundingClientRect().height ?? 0,
      visibleProperties: metadata
        ? [...metadata.querySelectorAll(".metadata-property")].filter(
            (element) => element.getBoundingClientRect().height > 0,
          ).length
        : 0,
    };
  });
}

const initial = evaluate(() => {
  if (!app.plugins.plugins.bullet)
    throw Error("Enable Bullet before verification");
  if (innerWidth !== outerWidth)
    throw Error("Clear viewport emulation before verification");
  return {
    file: app.workspace.getActiveFile()?.path,
    height: innerHeight,
    dpr: devicePixelRatio,
  };
});

function resize(width) {
  evaluate(() => window.focus());
  cdp("Emulation.setDeviceMetricsOverride", {
    width,
    height: initial.height,
    deviceScaleFactor: initial.dpr,
    mobile: false,
  });
  const result = sample();
  assert.equal(
    result.width,
    width,
    "The requested viewport width must be applied",
  );
  return result;
}

try {
  evaluate(
    async (filePath, frontmatter) => {
      const text =
        (frontmatter
          ? "---\nstatus: verification\npriority: 3\nowner: Bullet\nenabled: true\ntags:\n  - scroll\n  - regression\ncreated: 2026-09-01\ncategory: editor\nplatform: desktop\n---\n"
          : "") +
        Array.from({ length: 60 }, (_, i) => `- Before ${i}`).join("\n") +
        "\n- Last parent\n" +
        Array.from({ length: 10 }, (_, i) => `\t- Child ${i}`).join("\n");
      const file = await app.vault.create(filePath, text);
      await app.workspace.getLeaf(false).openFile(file);
      if (frontmatter) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const metadata =
          app.workspace.activeLeaf.view.containerEl.querySelector(
            ".metadata-container",
          );
        if (!metadata)
          throw Error("Properties must be displayed before verification");
        if (metadata.classList.contains("is-collapsed"))
          metadata.querySelector(".metadata-properties-heading").click();
      }
    },
    notePath,
    withFrontmatter,
  );
  resize(700);
  resize(900);
  evaluate(async () => {
    const view = app.workspace.activeLeaf.view.editor.cm;
    // Use the same position with or without the protected end reserve.
    view.scrollDOM.scrollTop =
      view.scrollDOM.scrollHeight -
      view.scrollDOM.clientHeight -
      Number.parseFloat(getComputedStyle(view.contentDOM).paddingBottom) -
      20;
    await new Promise((resolve) => setTimeout(resolve, 500));
    const control = [
      ...view.contentDOM.querySelectorAll(
        ".HyperMD-list-line .collapse-indicator",
      ),
    ].find((element) =>
      element.closest(".cm-line").textContent.includes("Last parent"),
    );
    if (!control) throw Error("Last parent fold control is missing");
    const bounds = control.getBoundingClientRect();
    const scrollBounds = view.scrollDOM.getBoundingClientRect();
    if (bounds.top < scrollBounds.top || bounds.bottom > scrollBounds.bottom) {
      throw Error(
        JSON.stringify({
          message: "Fold control must be visible before the pointer sequence",
          controlTop: bounds.top,
          controlBottom: bounds.bottom,
          scrollTop: scrollBounds.top,
          scrollBottom: scrollBounds.bottom,
          scrollHeight: view.scrollDOM.scrollHeight,
          padding: getComputedStyle(view.contentDOM).paddingBottom,
        }),
      );
    }
    for (const type of ["pointerdown", "pointerup", "click"]) {
      control.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          pointerType: "mouse",
          clientX: bounds.x + bounds.width / 2,
          clientY: bounds.y + bounds.height / 2,
        }),
      );
    }
  });
  const before = sample();
  assert.equal(
    before.parentFolded,
    true,
    "The native pointer sequence must fold the parent",
  );
  assert.ok(
    Number.parseFloat(before.effectivePadding) > 100,
    "The fold must have an end reserve larger than Obsidian's reset",
  );
  if (withFrontmatter)
    assert.ok(
      before.visibleProperties >= 8,
      "Frontmatter property rows must be expanded and rendered",
    );
  const narrow = resize(700);
  const after = resize(900);
  console.log(JSON.stringify({ before, narrow, after }, null, 2));
  assert.notEqual(
    before.line,
    null,
    "The baseline must contain a visible line",
  );
  for (const measured of [narrow, after]) {
    assert.equal(measured.parentFolded, true, "Resizing must retain the fold");
    if (withFrontmatter)
      assert.ok(
        measured.visibleProperties >= 8,
        "Frontmatter property rows must remain expanded",
      );
    assert.equal(
      measured.line,
      before.line,
      "Resizing must retain the visible document line",
    );
    assert.ok(
      Math.abs(measured.y - before.y) <= 1 / initial.dpr,
      "Resizing must retain the line's screen position within one physical pixel",
    );
  }
} finally {
  cdp("Emulation.clearDeviceMetricsOverride", {});
  evaluate(
    async (filePath, previousPath) => {
      const previous =
        previousPath && app.vault.getAbstractFileByPath(previousPath);
      if (previous) await app.workspace.getLeaf(false).openFile(previous);
      else app.workspace.activeLeaf.detach();
      const fixture = app.vault.getAbstractFileByPath(filePath);
      if (fixture) await app.vault.delete(fixture);
    },
    notePath,
    initial.file ?? null,
  );
}
