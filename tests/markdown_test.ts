import assert from "node:assert/strict";
import {
  isSafeLinkDestination,
  MARKDOWN_JAVASCRIPT,
  parseInline,
  parseMarkdown,
} from "../src/markdown.ts";
import { CSS, HTML, JAVASCRIPT } from "../src/ui.ts";

const representative = `# Rich response

Paragraph with **strong text**, *emphasis*, [documentation](https://example.com), and \`inline code\`.

- [x] Completed task
- Plain item

> Quoted context

---

| Name | Value |
| :--- | ---: |
| alpha | 1 |

\`\`\`ts
const answer = 42;
\`\`\``;

Deno.test("supported Markdown produces typed presentation nodes", () => {
  const blocks = parseMarkdown(representative);

  assert.deepEqual(
    blocks.map((block) => block.type),
    [
      "heading",
      "paragraph",
      "list",
      "blockquote",
      "thematic_break",
      "table",
      "code_block",
    ],
  );

  const paragraph = blocks[1];
  assert.equal(paragraph.type, "paragraph");
  assert.deepEqual(
    paragraph.children.map((node) => node.type),
    [
      "text",
      "strong",
      "text",
      "emphasis",
      "text",
      "link",
      "text",
      "code",
      "text",
    ],
  );

  const list = blocks[2];
  assert.equal(list.type, "list");
  assert.equal(list.items[0].checked, true);
  assert.equal(list.items[1].checked, null);

  const table = blocks[5];
  assert.equal(table.type, "table");
  assert.deepEqual(table.alignments, ["left", "right"]);
  assert.equal(table.rows.length, 1);

  const code = blocks[6];
  assert.equal(code.type, "code_block");
  assert.equal(code.language, "ts");
  assert.equal(code.complete, true);
  assert.equal(code.value, "const answer = 42;\n");
});

Deno.test("ordered lists and tilde fences retain their presentation metadata", () => {
  const blocks = parseMarkdown(
    "3. third\n4. fourth\n\n~~~rust\nfn main() {}\n~~~",
  );
  const list = blocks[0];
  assert.equal(list.type, "list");
  assert.equal(list.ordered, true);
  assert.equal(list.start, 3);
  assert.equal(list.items.length, 2);

  const code = blocks[1];
  assert.equal(code.type, "code_block");
  assert.equal(code.language, "rust");
  assert.equal(code.value, "fn main() {}\n");
  assert.equal(code.complete, true);
});

Deno.test("every streamed prefix stays parseable and final chunks equal complete source", () => {
  const chunks = [
    "# Rich res",
    "ponse\n\nParagraph with **stro",
    "ng text**, *emphasis*, [doc",
    "umentation](https://example.com), and `inline",
    " code`.\n\n| Name | Val",
    "ue |\n| :--- | ---: |\n| alpha |",
    " 1 |\n\n```t",
    "s\nconst answer = ",
    "42;\n```",
  ];
  let source = "";
  for (const chunk of chunks) {
    source += chunk;
    assert.doesNotThrow(() => parseMarkdown(source));
  }

  assert.equal(
    source,
    representative.replace(
      "- [x] Completed task\n- Plain item\n\n> Quoted context\n\n---\n\n",
      "",
    ),
  );
  assert.deepEqual(
    parseMarkdown(source),
    parseMarkdown(
      chunks.join(""),
    ),
  );
});

Deno.test("incomplete and malformed constructs remain literal or readable", () => {
  const incomplete = parseMarkdown(
    "Text with **unfinished emphasis and [unfinished link](https://example.com\n\n```js\nalert(1)",
  );

  assert.equal(incomplete[0].type, "paragraph");
  assert.deepEqual(
    incomplete[0].type === "paragraph" ? incomplete[0].children : [],
    [{
      type: "text",
      value:
        "Text with **unfinished emphasis and [unfinished link](https://example.com",
    }],
  );
  const code = incomplete[1];
  assert.equal(code.type, "code_block");
  assert.equal(code.complete, false);
  assert.equal(code.language, "js");
  assert.equal(code.value, "alert(1)");
});

Deno.test("deep blockquotes stop at a deterministic readable nesting budget", () => {
  const source = ">".repeat(10_000) + " x";
  let blocks = parseMarkdown(source);
  let depth = 0;
  while (blocks[0]?.type === "blockquote") {
    depth++;
    blocks = [...blocks[0].children];
  }

  assert.equal(depth, 32);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "paragraph");
  const fallbackText = blocks[0].type === "paragraph"
    ? blocks[0].children.map((node) => node.type === "text" ? node.value : "")
      .join("")
    : "";
  assert.equal(fallbackText.endsWith(" x"), true);
  assert.equal(fallbackText.startsWith(">".repeat(9_968)), true);
});

Deno.test("HTML, event attributes, images, and unsafe links never become active nodes", () => {
  const source =
    '<script src="https://attacker.invalid/x.js">alert(1)</script> ' +
    '<img src="https://attacker.invalid/pixel" onerror="alert(2)"> ' +
    "[unsafe](javascript:alert(3)) " +
    "![remote](https://attacker.invalid/image.png)";
  const blocks = parseMarkdown(source);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "paragraph");
  const children = blocks[0].type === "paragraph" ? blocks[0].children : [];

  assert.equal(children.some((node) => node.type === "image"), true);
  const unsafe = children.find((node) => node.type === "link");
  assert.deepEqual(unsafe, {
    type: "link",
    children: [{ type: "text", value: "unsafe" }],
    destination: "javascript:alert(3)",
    safe: false,
  });
  assert.equal(
    children.filter((node) => node.type === "text").map((node) =>
      node.type === "text" ? node.value : ""
    ).join("").includes("<script"),
    true,
  );

  assert.equal(MARKDOWN_JAVASCRIPT.includes("innerHTML"), false);
  assert.equal(MARKDOWN_JAVASCRIPT.includes(".href"), false);
  assert.equal(MARKDOWN_JAVASCRIPT.includes(".src"), false);
});

Deno.test("link policy recognizes displayable destinations without making them navigable", () => {
  assert.equal(isSafeLinkDestination("https://example.com/path"), true);
  assert.equal(isSafeLinkDestination("mailto:person@example.com"), true);
  assert.equal(isSafeLinkDestination("./docs/readme.md"), true);
  assert.equal(isSafeLinkDestination("javascript:alert(1)"), false);
  assert.equal(isSafeLinkDestination("data:text/html,<script>"), false);
  assert.equal(isSafeLinkDestination("file:///etc/passwd"), false);
  assert.equal(isSafeLinkDestination("\u0000https://example.com"), false);
});

Deno.test("fenced code retains its exact source for the copy action", () => {
  const source = "```python\r\nprint('one')\r\nprint('two')\r\n```";
  const blocks = parseMarkdown(source);
  assert.equal(blocks.length, 1);
  const code = blocks[0];
  assert.equal(code.type, "code_block");
  assert.equal(code.value, "print('one')\r\nprint('two')\r\n");
  assert.match(
    MARKDOWN_JAVASCRIPT,
    /writeText\(value\)/,
  );
  assert.match(
    MARKDOWN_JAVASCRIPT,
    /copyText\(node\.value\)/,
  );
});

Deno.test("browser renderer bundle is valid JavaScript", () => {
  assert.doesNotThrow(() => new Function(MARKDOWN_JAVASCRIPT));
  assert.deepEqual(parseInline("a \\*literal\\* value"), [{
    type: "text",
    value: "a *literal* value",
  }]);
});

Deno.test("renderer failures replace only the affected body with raw text", () => {
  const runtime = globalThis as unknown as {
    document?: unknown;
    vantageRenderMarkdown?: (
      root: FakeElement,
      source: string,
    ) => boolean;
  };
  const previousDocument = runtime.document;
  const previousRenderer = runtime.vantageRenderMarkdown;
  const root = new FakeElement();
  const source = ">".repeat(10_000) + " raw";

  try {
    runtime.document = {
      createDocumentFragment() {
        throw new Error("synthetic DOM failure");
      },
    };
    new Function(MARKDOWN_JAVASCRIPT)();

    assert.equal(runtime.vantageRenderMarkdown?.(root, source), false);
    assert.equal(root.textContent, source);
    assert.equal(root.classList.contains("render-fallback"), true);
  } finally {
    runtime.document = previousDocument;
    runtime.vantageRenderMarkdown = previousRenderer;
  }
});

Deno.test("unexpected rendering errors preserve raw deltas and cannot suppress terminal truth", () => {
  const runtime = globalThis as unknown as {
    document?: unknown;
    vantageReceiveEvent?: (event: Record<string, unknown>) => void;
    vantageRenderMarkdown?: () => boolean;
  };
  const previousDocument = runtime.document;
  const previousReceive = runtime.vantageReceiveEvent;
  const previousRenderer = runtime.vantageRenderMarkdown;
  const document = new FakeDocument();

  try {
    runtime.document = document;
    new Function(JAVASCRIPT)();
    runtime.vantageRenderMarkdown = () => {
      throw new Error("synthetic renderer failure");
    };

    runtime.vantageReceiveEvent?.({
      type: "turn_pending",
      prompt: "literal **user** prompt",
    });
    const raw = ">".repeat(10_000) + " assistant";
    runtime.vantageReceiveEvent?.({ type: "assistant_delta", delta: raw });
    runtime.vantageReceiveEvent?.({
      type: "turn_terminal",
      status: "completed",
      canContinue: true,
    });

    const transcript = document.querySelector("#transcript");
    assert.equal(transcript.children.length, 2);
    assert.equal(
      transcript.children[0].children[1].textContent,
      "literal **user** prompt",
    );
    const assistant = transcript.children[1];
    assert.equal(assistant.children[1].textContent, raw);
    assert.equal(
      assistant.children[1].classList.contains("render-fallback"),
      true,
    );
    assert.equal(assistant.children[2].hidden, false);
    assert.equal(assistant.children[2].className, "message-terminal completed");
    assert.equal(assistant.children[2].textContent, "Completed");
  } finally {
    runtime.document = previousDocument;
    runtime.vantageReceiveEvent = previousReceive;
    runtime.vantageRenderMarkdown = previousRenderer;
  }
});

Deno.test("packaged transcript keeps literal prompts, raw assistant source, CSP, and width containment", () => {
  assert.match(
    HTML,
    /default-src 'none'; script-src 'self'; style-src 'self'; img-src 'none'; connect-src 'none'/,
  );
  assert.match(
    JAVASCRIPT,
    /body\.textContent = text/,
  );
  assert.match(
    JAVASCRIPT,
    /activeAssistant\.source \+= event\.delta/,
  );
  assert.match(
    JAVASCRIPT,
    /renderAssistant\(activeAssistant\)/,
  );
  assert.match(
    JAVASCRIPT,
    /try \{\s+renderAssistant\(activeAssistant\);\s+\} finally \{/,
  );
  assert.match(
    CSS,
    /\.message \{ min-width: 0; max-width: 100%;/,
  );
  assert.match(
    CSS,
    /\.code-block pre \{[\s\S]*overflow-x: auto;/,
  );
  assert.match(
    CSS,
    /\.message\.assistant \.message-body\.render-fallback \{ white-space: pre-wrap; \}/,
  );
});

class FakeClassList {
  readonly values = new Set<string>();

  add(...values: string[]): void {
    for (const value of values) this.values.add(value);
  }

  remove(...values: string[]): void {
    for (const value of values) this.values.delete(value);
  }

  contains(value: string): boolean {
    return this.values.has(value);
  }
}

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly classList = new FakeClassList();
  readonly dataset: Record<string, string> = {};
  className = "";
  textContent = "";
  hidden = false;
  disabled = false;
  value = "";
  readOnly = false;
  type = "";
  title = "";
  start = 1;

  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }

  replaceChildren(...children: FakeElement[]): void {
    this.children.splice(0, this.children.length, ...children);
  }

  addEventListener(): void {}
  focus(): void {}
  scrollIntoView(): void {}
  select(): void {}
  remove(): void {}
  setAttribute(): void {}
}

class FakeDocument {
  readonly body = new FakeElement();
  readonly elements = new Map<string, FakeElement>();

  querySelector(selector: string): FakeElement {
    let element = this.elements.get(selector);
    if (!element) {
      element = new FakeElement();
      this.elements.set(selector, element);
    }
    return element;
  }

  createElement(): FakeElement {
    return new FakeElement();
  }

  createTextNode(value: string): FakeElement {
    const node = new FakeElement();
    node.textContent = value;
    return node;
  }

  createDocumentFragment(): FakeElement {
    return new FakeElement();
  }

  execCommand(): boolean {
    return true;
  }
}
