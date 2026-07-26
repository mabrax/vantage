// deno-lint-ignore-file no-explicit-any

export type InlineNode =
  | { readonly type: "text"; readonly value: string }
  | { readonly type: "code"; readonly value: string }
  | {
    readonly type: "emphasis" | "strong";
    readonly children: readonly InlineNode[];
  }
  | {
    readonly type: "link";
    readonly children: readonly InlineNode[];
    readonly destination: string;
    readonly safe: boolean;
  }
  | {
    readonly type: "image";
    readonly description: readonly InlineNode[];
  }
  | { readonly type: "break" };

export type BlockNode =
  | {
    readonly type: "heading";
    readonly level: number;
    readonly children: readonly InlineNode[];
  }
  | { readonly type: "paragraph"; readonly children: readonly InlineNode[] }
  | { readonly type: "thematic_break" }
  | { readonly type: "blockquote"; readonly children: readonly BlockNode[] }
  | {
    readonly type: "list";
    readonly ordered: boolean;
    readonly start: number;
    readonly items: readonly {
      readonly checked: boolean | null;
      readonly children: readonly InlineNode[];
    }[];
  }
  | {
    readonly type: "table";
    readonly alignments: readonly ("left" | "center" | "right" | null)[];
    readonly header: readonly (readonly InlineNode[])[];
    readonly rows: readonly (readonly (readonly InlineNode[])[])[];
  }
  | {
    readonly type: "code_block";
    readonly language: string;
    readonly value: string;
    readonly complete: boolean;
  };

interface SourceLine {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

function sourceLines(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  const expression = /.*?(?:\r\n|\n|\r|$)/g;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(source)) !== null) {
    const raw = match[0];
    if (raw.length === 0) break;
    const newlineLength = raw.endsWith("\r\n")
      ? 2
      : raw.endsWith("\n") || raw.endsWith("\r")
      ? 1
      : 0;
    lines.push({
      text: raw.slice(0, raw.length - newlineLength),
      start: match.index,
      end: match.index + raw.length,
    });
  }
  if (lines.length === 0) lines.push({ text: "", start: 0, end: 0 });
  return lines;
}

function appendText(nodes: InlineNode[], value: string): void {
  if (value.length === 0) return;
  const previous = nodes.at(-1);
  if (previous?.type === "text") {
    nodes[nodes.length - 1] = {
      type: "text",
      value: previous.value + value,
    };
  } else {
    nodes.push({ type: "text", value });
  }
}

export function isSafeLinkDestination(destination: string): boolean {
  const value = destination.trim();
  if (value === "") return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return false;
  }
  if (
    value.startsWith("#") || value.startsWith("/") || value.startsWith("./") ||
    value.startsWith("../")
  ) {
    return true;
  }
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(value);
  return scheme === null ||
    scheme[1].toLowerCase() === "https" ||
    scheme[1].toLowerCase() === "http" ||
    scheme[1].toLowerCase() === "mailto";
}

function findClosingMarker(
  source: string,
  marker: string,
  start: number,
): number {
  let cursor = start;
  while (cursor < source.length) {
    const found = source.indexOf(marker, cursor);
    if (found < 0) return -1;
    let slashes = 0;
    for (let index = found - 1; index >= 0 && source[index] === "\\"; index--) {
      slashes++;
    }
    if (slashes % 2 === 0) return found;
    cursor = found + marker.length;
  }
  return -1;
}

function parseLinkAt(
  source: string,
  start: number,
): {
  readonly end: number;
  readonly label: string;
  readonly destination: string;
} | null {
  const labelEnd = findClosingMarker(source, "]", start + 1);
  if (labelEnd < 0 || source[labelEnd + 1] !== "(") return null;
  let cursor = labelEnd + 2;
  let depth = 0;
  let escaped = false;
  while (cursor < source.length) {
    const character = source[cursor];
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "(") {
      depth++;
    } else if (character === ")") {
      if (depth === 0) {
        const rawDestination = source.slice(labelEnd + 2, cursor).trim();
        const destination = rawDestination.startsWith("<") &&
            rawDestination.endsWith(">")
          ? rawDestination.slice(1, -1)
          : rawDestination.split(/\s+["'(]/, 1)[0];
        return {
          end: cursor + 1,
          label: source.slice(start + 1, labelEnd),
          destination,
        };
      }
      depth--;
    }
    cursor++;
  }
  return null;
}

export function parseInline(source: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const character = source[cursor];
    if (
      character === "\\" && cursor + 1 < source.length &&
      /[\\`*_[\]{}()#+\-.!|>~]/.test(source[cursor + 1])
    ) {
      appendText(nodes, source[cursor + 1]);
      cursor += 2;
      continue;
    }
    if (character === "\n" || character === "\r") {
      if (character === "\r" && source[cursor + 1] === "\n") cursor++;
      nodes.push({ type: "break" });
      cursor++;
      continue;
    }
    if (character === "`") {
      let run = 1;
      while (source[cursor + run] === "`") run++;
      const marker = "`".repeat(run);
      const close = source.indexOf(marker, cursor + run);
      if (close >= 0) {
        let value = source.slice(cursor + run, close).replace(/\r\n?|\n/g, " ");
        if (
          value.startsWith(" ") && value.endsWith(" ") &&
          value.trim().length > 0
        ) {
          value = value.slice(1, -1);
        }
        nodes.push({ type: "code", value });
        cursor = close + run;
        continue;
      }
    }
    const strongMarker = source.startsWith("**", cursor)
      ? "**"
      : source.startsWith("__", cursor)
      ? "__"
      : null;
    if (strongMarker) {
      const close = findClosingMarker(
        source,
        strongMarker,
        cursor + strongMarker.length,
      );
      if (close > cursor + strongMarker.length) {
        nodes.push({
          type: "strong",
          children: parseInline(
            source.slice(cursor + strongMarker.length, close),
          ),
        });
        cursor = close + strongMarker.length;
        continue;
      }
    }
    if (character === "*" || character === "_") {
      const close = findClosingMarker(source, character, cursor + 1);
      if (close > cursor + 1) {
        nodes.push({
          type: "emphasis",
          children: parseInline(source.slice(cursor + 1, close)),
        });
        cursor = close + 1;
        continue;
      }
    }
    if (source.startsWith("![", cursor)) {
      const link = parseLinkAt(source, cursor + 1);
      if (link) {
        nodes.push({
          type: "image",
          description: parseInline(link.label),
        });
        cursor = link.end;
        continue;
      }
    }
    if (character === "[") {
      const link = parseLinkAt(source, cursor);
      if (link) {
        nodes.push({
          type: "link",
          children: parseInline(link.label),
          destination: link.destination,
          safe: isSafeLinkDestination(link.destination),
        });
        cursor = link.end;
        continue;
      }
    }
    appendText(nodes, character);
    cursor++;
  }
  return nodes;
}

function isThematicBreak(line: string): boolean {
  const compact = line.trim().replaceAll(" ", "").replaceAll("\t", "");
  return /^(\*{3,}|-{3,}|_{3,})$/.test(compact);
}

function fenceStart(line: string): RegExpExecArray | null {
  return /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
}

function listItem(line: string): RegExpExecArray | null {
  return /^ {0,3}([-+*]|\d+[.)])\s+(.*)$/.exec(line);
}

function splitTableRow(line: string): string[] {
  let value = line.trim();
  if (value.startsWith("|")) value = value.slice(1);
  if (value.endsWith("|") && !value.endsWith("\\|")) value = value.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  let escaped = false;
  let codeRun = 0;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (escaped) {
      cell += character;
      escaped = false;
    } else if (character === "\\") {
      cell += character;
      escaped = true;
    } else if (character === "`") {
      codeRun = codeRun === 0 ? 1 : 0;
      cell += character;
    } else if (character === "|" && codeRun === 0) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function tableAlignments(
  line: string,
): ("left" | "center" | "right" | null)[] | null {
  const cells = splitTableRow(line);
  if (cells.length === 0) return null;
  const alignments: ("left" | "center" | "right" | null)[] = [];
  for (const cell of cells) {
    if (!/^:?-{3,}:?$/.test(cell.replaceAll(" ", ""))) return null;
    const compact = cell.replaceAll(" ", "");
    alignments.push(
      compact.startsWith(":") && compact.endsWith(":")
        ? "center"
        : compact.endsWith(":")
        ? "right"
        : compact.startsWith(":")
        ? "left"
        : null,
    );
  }
  return alignments;
}

function beginsBlock(lines: SourceLine[], index: number): boolean {
  const line = lines[index]?.text ?? "";
  if (line.trim() === "") return true;
  if (fenceStart(line) || /^ {0,3}#{1,6}(?:\s+|$)/.test(line)) return true;
  if (isThematicBreak(line) || /^ {0,3}>/.test(line) || listItem(line)) {
    return true;
  }
  return index + 1 < lines.length &&
    line.includes("|") &&
    tableAlignments(lines[index + 1].text) !== null;
}

export function parseMarkdown(source: string): BlockNode[] {
  const lines = sourceLines(source);
  const blocks: BlockNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index].text;
    if (line.trim() === "") {
      index++;
      continue;
    }

    const fence = fenceStart(line);
    if (fence) {
      const marker = fence[1];
      const language = fence[2].trim().split(/\s+/, 1)[0] ?? "";
      let closeIndex = -1;
      for (let candidate = index + 1; candidate < lines.length; candidate++) {
        const close = new RegExp(
          `^ {0,3}${marker[0]}{${marker.length},}\\s*$`,
        );
        if (close.test(lines[candidate].text)) {
          closeIndex = candidate;
          break;
        }
      }
      const contentStart = lines[index].end;
      const contentEnd = closeIndex >= 0
        ? lines[closeIndex].start
        : source.length;
      blocks.push({
        type: "code_block",
        language,
        value: source.slice(contentStart, contentEnd),
        complete: closeIndex >= 0,
      });
      index = closeIndex >= 0 ? closeIndex + 1 : lines.length;
      continue;
    }

    const heading = /^ {0,3}(#{1,6})(?:\s+|$)(.*)$/.exec(line);
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading[1].length,
        children: parseInline(heading[2].replace(/\s+#+\s*$/, "")),
      });
      index++;
      continue;
    }

    if (isThematicBreak(line)) {
      blocks.push({ type: "thematic_break" });
      index++;
      continue;
    }

    if (/^ {0,3}>/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^ {0,3}>/.test(lines[index].text)) {
        quoted.push(lines[index].text.replace(/^ {0,3}>\s?/, ""));
        index++;
      }
      blocks.push({
        type: "blockquote",
        children: parseMarkdown(quoted.join("\n")),
      });
      continue;
    }

    const item = listItem(line);
    if (item) {
      const ordered = /^\d/.test(item[1]);
      const start = ordered ? Number.parseInt(item[1], 10) : 1;
      const items: {
        checked: boolean | null;
        children: readonly InlineNode[];
      }[] = [];
      while (index < lines.length) {
        const candidate = listItem(lines[index].text);
        if (!candidate || /^\d/.test(candidate[1]) !== ordered) break;
        let value = candidate[2];
        let checked: boolean | null = null;
        const task = /^\[([ xX])\]\s+(.*)$/.exec(value);
        if (task) {
          checked = task[1].toLowerCase() === "x";
          value = task[2];
        }
        items.push({ checked, children: parseInline(value) });
        index++;
      }
      blocks.push({ type: "list", ordered, start, items });
      continue;
    }

    if (
      line.includes("|") && index + 1 < lines.length &&
      tableAlignments(lines[index + 1].text) !== null
    ) {
      const alignments = tableAlignments(lines[index + 1].text)!;
      const header = splitTableRow(line).map(parseInline);
      const rows: (readonly InlineNode[])[][] = [];
      index += 2;
      while (
        index < lines.length && lines[index].text.includes("|") &&
        lines[index].text.trim() !== ""
      ) {
        rows.push(splitTableRow(lines[index].text).map(parseInline));
        index++;
      }
      blocks.push({ type: "table", alignments, header, rows });
      continue;
    }

    const paragraph: string[] = [];
    while (
      index < lines.length && lines[index].text.trim() !== "" &&
      (paragraph.length === 0 || !beginsBlock(lines, index))
    ) {
      paragraph.push(lines[index].text);
      index++;
    }
    if (paragraph.length === 0) {
      paragraph.push(line);
      index++;
    }
    blocks.push({
      type: "paragraph",
      children: parseInline(paragraph.join("\n")),
    });
  }
  return blocks;
}

function markdownRuntime(): void {
  const browser = globalThis as any;
  const document = browser.document;
  const inline = (parent: any, nodes: readonly InlineNode[]) => {
    for (const node of nodes) {
      if (node.type === "text") {
        parent.append(document.createTextNode(node.value));
      } else if (node.type === "break") {
        parent.append(document.createElement("br"));
      } else if (node.type === "code") {
        const code = document.createElement("code");
        code.className = "inline-code";
        code.textContent = node.value;
        parent.append(code);
      } else if (node.type === "emphasis" || node.type === "strong") {
        const element = document.createElement(
          node.type === "strong" ? "strong" : "em",
        );
        inline(element, node.children);
        parent.append(element);
      } else if (node.type === "link") {
        const link = document.createElement("span");
        link.className = node.safe
          ? "markdown-link"
          : "markdown-link unsafe-link";
        link.title = node.safe
          ? `Link destination (navigation unavailable): ${node.destination}`
          : "Blocked unsafe link destination";
        inline(link, node.children);
        parent.append(link);
      } else if (node.type === "image") {
        const omitted = document.createElement("span");
        omitted.className = "omitted-image";
        omitted.append(document.createTextNode("Image omitted: "));
        inline(omitted, node.description);
        parent.append(omitted);
      }
    }
  };

  const copyText = async (value: string): Promise<void> => {
    if (browser.navigator?.clipboard?.writeText) {
      await browser.navigator.clipboard.writeText(value);
      return;
    }
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.readOnly = true;
    textarea.className = "copy-fallback";
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) throw new Error("Clipboard access is unavailable.");
  };

  const block = (parent: any, node: BlockNode) => {
    if (node.type === "heading") {
      const heading = document.createElement(`h${node.level}`);
      inline(heading, node.children);
      parent.append(heading);
    } else if (node.type === "paragraph") {
      const paragraph = document.createElement("p");
      inline(paragraph, node.children);
      parent.append(paragraph);
    } else if (node.type === "thematic_break") {
      parent.append(document.createElement("hr"));
    } else if (node.type === "blockquote") {
      const quote = document.createElement("blockquote");
      for (const child of node.children) block(quote, child);
      parent.append(quote);
    } else if (node.type === "list") {
      const list = document.createElement(node.ordered ? "ol" : "ul");
      if (node.ordered && node.start !== 1) list.start = node.start;
      for (const item of node.items) {
        const listItem = document.createElement("li");
        if (item.checked !== null) {
          listItem.classList.add("task-list-item");
          const marker = document.createElement("span");
          marker.className = item.checked ? "task checked" : "task";
          marker.setAttribute(
            "aria-label",
            item.checked ? "Completed task" : "Incomplete task",
          );
          marker.textContent = item.checked ? "✓" : "";
          listItem.append(marker);
        }
        inline(listItem, item.children);
        list.append(listItem);
      }
      parent.append(list);
    } else if (node.type === "table") {
      const scroller = document.createElement("div");
      scroller.className = "table-scroll";
      const table = document.createElement("table");
      const head = document.createElement("thead");
      const headRow = document.createElement("tr");
      node.header.forEach((cell, cellIndex) => {
        const heading = document.createElement("th");
        const alignment = node.alignments[cellIndex];
        if (alignment) heading.className = `align-${alignment}`;
        inline(heading, cell);
        headRow.append(heading);
      });
      head.append(headRow);
      table.append(head);
      if (node.rows.length > 0) {
        const body = document.createElement("tbody");
        for (const row of node.rows) {
          const tableRow = document.createElement("tr");
          const width = Math.max(node.header.length, row.length);
          for (let cellIndex = 0; cellIndex < width; cellIndex++) {
            const cell = document.createElement("td");
            const alignment = node.alignments[cellIndex];
            if (alignment) cell.className = `align-${alignment}`;
            inline(cell, row[cellIndex] ?? []);
            tableRow.append(cell);
          }
          body.append(tableRow);
        }
        table.append(body);
      }
      scroller.append(table);
      parent.append(scroller);
    } else {
      const figure = document.createElement("figure");
      figure.className = node.complete ? "code-block" : "code-block streaming";
      const caption = document.createElement("figcaption");
      const language = document.createElement("span");
      language.className = "code-language";
      language.textContent = node.language || "Code";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "copy-code";
      button.textContent = "Copy";
      button.setAttribute(
        "aria-label",
        `Copy ${node.language || "code"} snippet`,
      );
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          await copyText(node.value);
          button.textContent = "Copied";
        } catch {
          button.textContent = "Copy failed";
        } finally {
          browser.setTimeout(() => {
            button.textContent = "Copy";
            button.disabled = false;
          }, 1600);
        }
      });
      caption.append(language, button);
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      if (node.language) code.dataset.language = node.language;
      code.textContent = node.value;
      pre.append(code);
      figure.append(caption, pre);
      parent.append(figure);
    }
  };

  browser.vantageRenderMarkdown = (
    root: any,
    source: string,
  ): void => {
    const fragment = document.createDocumentFragment();
    for (const node of parseMarkdown(source)) block(fragment, node);
    root.replaceChildren(fragment);
  };
}

export const MARKDOWN_JAVASCRIPT = [
  sourceLines,
  appendText,
  isSafeLinkDestination,
  findClosingMarker,
  parseLinkAt,
  parseInline,
  isThematicBreak,
  fenceStart,
  listItem,
  splitTableRow,
  tableAlignments,
  beginsBlock,
  parseMarkdown,
  markdownRuntime,
].map((definition) => definition.toString()).join("\n") +
  "\nmarkdownRuntime();\n";
