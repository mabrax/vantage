import assert from "node:assert/strict";
import {
  isSafeLinkDestination,
  MARKDOWN_JAVASCRIPT,
  parseMarkdown,
} from "../src/markdown.ts";
import { parseMermaid, sanitizeSvg } from "../src/visuals.ts";
import { HTML } from "../src/ui.ts";
import {
  EXACT_COPY_FIXTURES,
  MARKDOWN_ATTACK_FIXTURE,
  MERMAID_ATTACK_FIXTURES,
  SVG_ATTACK_FIXTURES,
  UNSAFE_LINK_DESTINATIONS,
} from "./fixtures/rich_response_exit_gate.ts";

Deno.test("exit-gate attack fixtures stay inert or are rejected", () => {
  const markdown = parseMarkdown(MARKDOWN_ATTACK_FIXTURE);
  const serialized = JSON.stringify(markdown);

  assert.match(serialized, /<script/);
  assert.match(serialized, /"type":"image"/);
  for (const destination of UNSAFE_LINK_DESTINATIONS) {
    assert.equal(isSafeLinkDestination(destination), false, destination);
  }
  for (const source of MERMAID_ATTACK_FIXTURES) {
    assert.equal(parseMermaid(source).ok, false, source);
  }
  for (const source of SVG_ATTACK_FIXTURES) {
    assert.equal(sanitizeSvg(source).ok, false, source);
  }

  assert.match(
    HTML,
    /default-src 'none'; script-src 'self'; style-src 'self'; img-src 'none'; connect-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'/,
  );
  for (
    const sink of [
      "innerHTML",
      "outerHTML",
      "insertAdjacentHTML",
      "DOMParser",
      ".href",
      ".src",
      'createElement("img")',
      'createElement("iframe")',
      'createElement("object")',
    ]
  ) {
    assert.equal(MARKDOWN_JAVASCRIPT.includes(sink), false, sink);
  }
});

Deno.test("exit-gate copy fixtures preserve exact bytes and final newlines", async () => {
  const encoder = new TextEncoder();
  for (const fixture of EXACT_COPY_FIXTURES) {
    const [block] = parseMarkdown(fixture.markdown);
    assert.ok(block);
    assert.equal(
      block.type === "code_block" || block.type === "visual_block"
        ? block.value
        : null,
      fixture.value,
      fixture.name,
    );
    const bytes = encoder.encode(fixture.value);
    assert.equal(bytes.byteLength, fixture.bytes, fixture.name);
    assert.equal(await sha256(bytes), fixture.sha256, fixture.name);
    assert.equal(fixture.value.endsWith("\r\n"), true, fixture.name);
  }
});

async function sha256(value: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
