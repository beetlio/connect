import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const docs = new URL("../docs/", import.meta.url);

test("documentation site has valid local links and a Pages workflow", async () => {
  const html = await readFile(new URL("index.html", docs), "utf8");
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<meta name="viewport"/);
  assert.match(html, /href="\.\/styles\.css"/);

  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]!));
  for (const [, target] of html.matchAll(/href="#([^"]+)"/g)) {
    assert.ok(ids.has(target!), `Missing anchor target #${target}`);
  }
  for (const [, path] of html.matchAll(/(?:href|src)="\.\/([^"]+)"/g)) {
    await access(new URL(path!, docs));
  }

  const workflow = await readFile(
    new URL("../.github/workflows/pages.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /actions\/configure-pages@v5/);
  assert.match(workflow, /actions\/upload-pages-artifact@v4/);
  assert.match(workflow, /actions\/deploy-pages@v4/);
  assert.match(workflow, /path: docs/);
});
