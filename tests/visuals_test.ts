import assert from "node:assert/strict";
import {
  MERMAID_SOURCE_LIMIT,
  parseMermaid,
  sanitizeSvg,
  SVG_SOURCE_LIMIT,
} from "../src/visuals.ts";
import { MARKDOWN_JAVASCRIPT, parseMarkdown } from "../src/markdown.ts";
import { CSS, HTML } from "../src/ui.ts";

Deno.test("closed Mermaid fences become visual intents while incomplete fences stay source", () => {
  const source = "flowchart LR\nA[Read] -->|safe| B(Render)";
  assert.deepEqual(parseMarkdown(`\`\`\`mermaid\n${source}\n\`\`\``), [{
    type: "visual_block",
    format: "mermaid",
    value: `${source}\n`,
  }]);
  assert.deepEqual(parseMarkdown(`\`\`\`mermaid\n${source}`), [{
    type: "code_block",
    language: "mermaid",
    value: source,
    complete: false,
  }]);
});

Deno.test("bounded offline Mermaid flowcharts retain labels and accessibility text", () => {
  const result = parseMermaid(
    "flowchart TD\nA[Prompt] -->|ordered delta| B(Render)\nB --> C{Safe?}",
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value.nodes.map((node) => node.label), [
    "Prompt",
    "Render",
    "Safe?",
  ]);
  assert.equal(result.value.edges[0].label, "ordered delta");
  assert.match(result.value.alternative, /Nodes: A, Prompt/);
  assert.match(result.value.alternative, /Connections: A to B, ordered delta/);
});

Deno.test("malformed, unsupported, and oversized Mermaid are rejected without throwing", () => {
  for (
    const source of [
      "sequenceDiagram\nAlice->>Bob: hello",
      "flowchart LR\nclick A https://attacker.invalid",
      "flowchart LR\nA[unfinished",
      `flowchart LR\nA[ok]\n${"x".repeat(MERMAID_SOURCE_LIMIT)}`,
    ]
  ) {
    const result = parseMermaid(source);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /Mermaid|Invalid|Unsupported/);
  }
});

Deno.test("safe SVG subset preserves geometry and derives a text alternative", () => {
  const source =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60">' +
    "<title>Build status</title><desc>Green completion badge</desc>" +
    '<rect x="1" y="1" width="118" height="58" rx="8" fill="#dff7e8" stroke="green"/>' +
    '<text x="60" y="34" text-anchor="middle" fill="black">Complete</text></svg>';
  const result = sanitizeSvg(source);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.root.name, "svg");
  assert.equal(result.value.root.attributes.viewBox, "0 0 120 60");
  assert.equal(Object.hasOwn(result.value.root.attributes, "xmlns"), false);
  assert.equal(result.value.alternative, "Build status Green completion badge");
});

Deno.test("SVG rejects active, external, CSS, embedded, malformed, and oversized content", () => {
  const attacks = [
    '<svg viewBox="0 0 10 10"><script>alert(1)</script></svg>',
    '<svg viewBox="0 0 10 10"><rect onload="alert(1)"/></svg>',
    '<svg viewBox="0 0 10 10"><foreignObject><p>x</p></foreignObject></svg>',
    '<svg viewBox="0 0 10 10"><a href="https://attacker.invalid"><text>x</text></a></svg>',
    '<svg viewBox="0 0 10 10"><image href="https://attacker.invalid/x"/></svg>',
    '<svg viewBox="0 0 10 10"><rect style="fill:url(https://attacker.invalid/x)"/></svg>',
    '<svg viewBox="0 0 10 10"><rect fill="url(https://attacker.invalid/x)"/></svg>',
    '<svg viewBox="0 0 10 10"><use href="#local"/></svg>',
    '<svg viewBox="0 0 10 10"><rect width="10"></svg>',
    '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg viewBox="0 0 10 10"/>',
    `<svg viewBox="0 0 10 10"><desc>${
      "x".repeat(SVG_SOURCE_LIMIT)
    }</desc></svg>`,
  ];
  for (const attack of attacks) {
    const result = sanitizeSvg(attack);
    assert.equal(result.ok, false, attack);
  }
});

Deno.test("SVG allowlist never carries provider URL, event, style, or executable attributes", () => {
  const source =
    '<svg viewBox="0 0 20 20"><g transform="translate(1 2)" opacity="0.8">' +
    '<path d="M0 0 L10 10 Z" fill="none" stroke="#123456"/></g></svg>';
  const result = sanitizeSvg(source);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const serialized = JSON.stringify(result.value);
  assert.equal(
    /https?:|data:|javascript:|file:|url\(/i.test(serialized),
    false,
  );
  assert.equal(/"on[a-z]+":|"style":|"href":/i.test(serialized), false);
  assert.equal(MARKDOWN_JAVASCRIPT.includes("DOMParser"), false);
  assert.equal(MARKDOWN_JAVASCRIPT.includes("innerHTML"), false);
  assert.equal(MARKDOWN_JAVASCRIPT.includes("insertAdjacentHTML"), false);
});

Deno.test("visual controls expose exact source, accessible images, and contained overflow", () => {
  assert.match(MARKDOWN_JAVASCRIPT, /copyButton\(node\.value, "Mermaid"\)/);
  assert.match(MARKDOWN_JAVASCRIPT, /copyButton\(node\.value, "SVG"\)/);
  assert.match(MARKDOWN_JAVASCRIPT, /code\.textContent = value/);
  assert.match(MARKDOWN_JAVASCRIPT, /setAttribute\("role", "img"\)/);
  assert.match(
    MARKDOWN_JAVASCRIPT,
    /setAttribute\("aria-label", diagram\.alternative\)/,
  );
  assert.match(HTML, /img-src 'none'/);
  assert.match(HTML, /connect-src 'none'/);
  assert.match(
    CSS,
    /\.visual-block \{[\s\S]*max-width: 100%;[\s\S]*overflow: hidden;/,
  );
  assert.match(
    CSS,
    /\.visual-viewport \{[\s\S]*max-width: 100%;[\s\S]*overflow: auto;/,
  );
  assert.match(
    CSS,
    /\.diagram-svg \{[\s\S]*width: 100%;[\s\S]*max-width: 100%;/,
  );
});
