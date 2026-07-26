import assert from "node:assert/strict";

const MAIN_SOURCE = await Deno.readTextFile(
  new URL("../src/main.ts", import.meta.url),
);

Deno.test("desktop close always closes the window after exact owned-session cleanup", () => {
  assert.match(
    MAIN_SOURCE,
    /try \{\s+if \(registry\) \{\s+await registry\.close\(\);\s+\} else \{\s+await controller\.close\(\);\s+\}\s+\} finally \{\s+window\.close\(\);\s+\}/,
  );
});
