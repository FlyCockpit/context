/** Fixtures for the pure judge in scripts/check-layout.ts: node --test scripts/check-layout.test.ts */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { judgeLayout, type Probe } from "./check-layout.ts";

const good: Probe = {
  vw: 1280,
  docScroll: 0,
  header: true,
  main: { bottom: 800, scrollable: false, scrollbar: 0 },
  footer: { bottom: 800, lastInMain: true },
  rules: [
    { name: "header <hr>", left: 0, right: 1280, inMain: false },
    { name: "footer border-t", left: 0, right: 1280, inMain: true },
  ],
  toast: null,
};

const toast = {
  dark: true,
  fill: "22,27,29",
  popover: "22,27,29",
  title: 16.7,
  badge: 8.5,
  button: 16.7,
};

describe("judgeLayout", () => {
  it("passes a short page whose footer ends at the scroller's bottom", () => {
    assert.deepEqual(judgeLayout("landing", good, { footer: true }), []);
    assert.deepEqual(
      judgeLayout(
        "landing",
        { ...good, footer: { bottom: 801, lastInMain: true } },
        { footer: true },
      ),
      [],
    );
  });

  it("reports the landing footer gap, a missing footer and a footer that is not last", () => {
    assert.match(
      judgeLayout(
        "landing",
        { ...good, footer: { bottom: 353, lastInMain: true } },
        { footer: true },
      ).join("\n"),
      /footer ends at 353px, the scroller at 800px \(short page\)/,
    );
    assert.match(
      judgeLayout(
        "404",
        { ...good, footer: null, header: false, main: null },
        { footer: true },
      ).join("\n"),
      /no <main[\s\S]*no shell header[\s\S]*no public footer/,
    );
    assert.match(
      judgeLayout(
        "landing",
        { ...good, footer: { bottom: 800, lastInMain: false } },
        { footer: true },
      ).join("\n"),
      /not the last box/,
    );
  });

  it("reports a document scroll, a reserved gutter and rules stopped short by it", () => {
    const bad = judgeLayout(
      "admin",
      {
        ...good,
        docScroll: 12,
        main: { bottom: 800, scrollable: false, scrollbar: 15 },
        rules: [{ name: "sub-nav border-b", left: 0, right: 1265, inMain: true }],
      },
      { footer: false },
    );
    assert.equal(bad.length, 3, bad.join("\n"));
    assert.match(bad.join("\n"), /document scrolls by 12px/);
    assert.match(bad.join("\n"), /reserves a 15px scrollbar gutter on a page that does not scroll/);
    assert.match(bad.join("\n"), /sub-nav border-b spans 0…1265px, not 0…1280px/);
  });

  it("lets a rule inside a scrolling scroller meet the visible scrollbar, never one outside it", () => {
    const scrolling = { bottom: 800, scrollable: true, scrollbar: 15 };
    assert.deepEqual(
      judgeLayout(
        "admin long",
        {
          ...good,
          main: scrolling,
          rules: [
            { name: "header <hr>", left: 0, right: 1280, inMain: false },
            { name: "sub-nav border-b", left: 0, right: 1265, inMain: true },
          ],
        },
        { footer: false },
      ),
      [],
    );
    assert.equal(
      judgeLayout(
        "admin long",
        {
          ...good,
          main: scrolling,
          rules: [{ name: "header <hr>", left: 0, right: 1265, inMain: false }],
        },
        { footer: false },
      ).length,
      1,
    );
  });

  it("lets a band inside AppFrame's content column start after the sidebar, not before it", () => {
    const band = { name: "banner border-b", right: 1280, inMain: true, start: 240 };
    assert.deepEqual(
      judgeLayout("ongoing", { ...good, rules: [{ ...band, left: 240 }] }, { footer: false }),
      [],
    );
    assert.match(
      judgeLayout("ongoing", { ...good, rules: [{ ...band, left: 256 }] }, { footer: false }).join(
        "",
      ),
      /banner border-b spans 256…1280px, not 240…1280px/,
    );
    assert.equal(
      judgeLayout(
        "ongoing",
        { ...good, rules: [{ ...band, left: 240, right: 1265 }] },
        { footer: false },
      ).length,
      1,
    );
  });

  it("checks the toast fill against the theme's popover, its contrast and the stored theme", () => {
    assert.deepEqual(
      judgeLayout("toast dark", { ...good, toast }, { footer: false, toast: "dark" }),
      [],
    );
    const inverted = judgeLayout(
      "toast dark",
      { ...good, toast: { ...toast, fill: "242,242,242", title: 3.4, badge: 3.4, button: 3.4 } },
      { footer: false, toast: "dark" },
    );
    assert.equal(inverted.length, 4, inverted.join("\n"));
    assert.match(inverted[0] ?? "", /filled 242,242,242, not the dark theme's popover 22,27,29/);
    assert.match(
      judgeLayout("toast light", good, { footer: false, toast: "light" }).join(""),
      /no toast appeared/,
    );
    assert.match(
      judgeLayout("toast light", { ...good, toast }, { footer: false, toast: "light" }).join(""),
      /stored light theme lost to the OS/,
    );
  });
});
