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
    /vantageRenderMarkdown\(activeAssistant\.body, activeAssistant\.source\)/,
  );
  assert.match(
    CSS,
    /\.message \{ min-width: 0; max-width: 100%;/,
  );
  assert.match(
    CSS,
    /\.code-block pre \{[\s\S]*overflow-x: auto;/,
  );
});
