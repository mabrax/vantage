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
  if (!result.ok || result.value.kind !== "flowchart") return;
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
      "classDiagram\nAnimal <|-- Duck",
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

Deno.test("Mermaid flowcharts accept safe subgraphs, rich labels, and bidirectional edges", () => {
  const result = parseMermaid(`flowchart LR
U["Developer"]
subgraph V["Vantage desktop"]
  UI["WebView UI<br/>transcript + controls"]
  HOST["main.ts<br/>privileged Deno host"]
  UI -->|"bindings:<br/>repository, prompt, stop"| HOST
end
REPO[("Canonical Git repository")]
HOST <--> REPO`);
  assert.equal(result.ok, true);
  if (!result.ok || result.value.kind !== "flowchart") return;
  assert.equal(result.value.groups[0].label, "Vantage desktop");
  assert.deepEqual(result.value.groups[0].nodes, ["UI", "HOST"]);
  assert.equal(
    result.value.nodes[1].label,
    "WebView UI\ntranscript + controls",
  );
  assert.equal(
    result.value.edges[0].label,
    "bindings:\nrepository, prompt, stop",
  );
  assert.equal(result.value.edges[1].arrow, "both");
  assert.equal(result.value.nodes.at(-1)?.shape, "cylinder");
});

Deno.test("Mermaid sequence diagrams retain participants, messages, and blocks", () => {
  const result = parseMermaid(`sequenceDiagram
actor User
participant UI as WebView UI
participant Host as Deno host
User->>UI: Submit prompt
UI->>Host: submitPrompt(text)
loop Ordered assistant output
  Host-->>UI: assistant_delta
end`);
  assert.equal(result.ok, true);
  if (!result.ok || result.value.kind !== "sequence") return;
  assert.deepEqual(
    result.value.participants.map((participant) => participant.label),
    ["User", "WebView UI", "Deno host"],
  );
  assert.equal(result.value.steps[2].kind, "block_start");
  assert.match(result.value.alternative, /UI to Host, submitPrompt/);
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

Deno.test("Mermaid dotted edges parse with dashed flag", () => {
  const result = parseMermaid(`flowchart LR
REG["Registry"]
REPO[("Repository")]
REG -.->|"canonicalize and validate"| REPO`);
  assert.equal(result.ok, true);
  if (!result.ok || result.value.kind !== "flowchart") return;
  assert.equal(result.value.edges.length, 1);
  assert.equal(result.value.edges[0].dashed, true);
  assert.equal(result.value.edges[0].arrow, "forward");
  assert.equal(result.value.edges[0].label, "canonicalize and validate");
});

Deno.test("Mermaid solid edges have dashed false", () => {
  const result = parseMermaid(`flowchart LR
A["A"]
B["B"]
A --> B`);
  assert.equal(result.ok, true);
  if (!result.ok || result.value.kind !== "flowchart") return;
  assert.equal(result.value.edges[0].dashed, false);
  assert.equal(result.value.edges[0].arrow, "forward");
});

Deno.test("Mermaid bidirectional dotted edge yields both with dashed true", () => {
  const result = parseMermaid(`flowchart LR
A["A"]
B["B"]
A <-.-> B`);
  assert.equal(result.ok, true);
  if (!result.ok || result.value.kind !== "flowchart") return;
  assert.equal(result.value.edges[0].dashed, true);
  assert.equal(result.value.edges[0].arrow, "both");
});

Deno.test("Mermaid rejects arrows that only resemble the dotted forms", () => {
  for (const line of ["A -x-> B", "A -1-> B", "A <-Z-> B", "A -.-.-> B"]) {
    const result = parseMermaid(`flowchart LR\n${line}`);
    assert.equal(result.ok, false);
  }
});
