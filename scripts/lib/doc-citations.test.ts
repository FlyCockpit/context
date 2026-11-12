import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkDocCitations } from "../check-doc-citations.ts";

test("relative links in every retained docs page are checked, including newly added pages", () => {
  const root = mkdtempSync(join(tmpdir(), "cockpit-context-citations-"));
  try {
    mkdirSync(join(root, "docs"));
    writeFileSync(
      join(root, "docs", "new-operator-page.md"),
      "# Operator\n\n[Missing](./missing.md)\n",
    );
    const options = { root, codeDirs: ["docs"], rootDocs: [], docLinkRootDocs: [] };
    const broken = checkDocCitations(options);
    assert.equal(broken.docLinkCount, 1);
    assert.equal(broken.errors.length, 1);
    assert.match(broken.errors[0] ?? "", /missing\.md/);
    writeFileSync(join(root, "docs", "missing.md"), "# Restored\n");
    assert.deepEqual(checkDocCitations(options).errors, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
