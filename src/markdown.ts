// deno-lint-ignore-file no-explicit-any

import {
  decodeXmlText,
  findXmlTagEnd,
  MERMAID_SOURCE_LIMIT,
  mermaidNodeToken,
  mermaidPlainLabel,
  parseMermaid,
  parseMermaidFlowchart,
  parseMermaidSequence,
  parseXmlAttributes,
  safeSvgAlternative,
  safeSvgColor,
  safeSvgNumber,
  safeSvgNumberList,
  safeSvgTransform,
  sanitizeSvg,
  sanitizeSvgAttributes,
  SVG_SOURCE_LIMIT,
} from "./visuals.ts";

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
  }
  | {
    readonly type: "visual_block";
    readonly format: "mermaid" | "svg";
    readonly value: string;
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

export function parseMarkdown(
  source: string,
  blockquoteDepth = 0,
): BlockNode[] {
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
      const value = source.slice(contentStart, contentEnd);
      const visualFormat = language.toLowerCase();
      blocks.push(
        closeIndex >= 0 &&
          (visualFormat === "mermaid" || visualFormat === "svg")
          ? {
            type: "visual_block",
            format: visualFormat,
            value,
          }
          : {
            type: "code_block",
            language,
            value,
            complete: closeIndex >= 0,
          },
      );
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
      if (blockquoteDepth >= 32) {
        while (index < lines.length && /^ {0,3}>/.test(lines[index].text)) {
          quoted.push(lines[index].text);
          index++;
        }
        blocks.push({
          type: "paragraph",
          children: parseInline(quoted.join("\n")),
        });
        continue;
      }
      while (index < lines.length && /^ {0,3}>/.test(lines[index].text)) {
        quoted.push(lines[index].text.replace(/^ {0,3}>\s?/, ""));
        index++;
      }
      blocks.push({
        type: "blockquote",
        children: parseMarkdown(quoted.join("\n"), blockquoteDepth + 1),
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
  const svgNamespace = "http://www.w3.org/2000/svg";
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

  const copyButton = (value: string, label: string, text = "Copy source") => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "copy-code";
    button.textContent = text;
    button.setAttribute("aria-label", `Copy ${label} source`);
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await copyText(value);
        button.textContent = "Copied";
      } catch {
        button.textContent = "Copy failed";
      } finally {
        browser.setTimeout(() => {
          button.textContent = text;
          button.disabled = false;
        }, 1600);
      }
    });
    return button;
  };

  const appendExactSource = (
    parent: any,
    value: string,
    label: string,
    open: boolean,
  ) => {
    const details = document.createElement("details");
    details.className = "visual-source";
    details.open = open;
    const summary = document.createElement("summary");
    summary.textContent = "Source";
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.dataset.language = label.toLowerCase();
    code.textContent = value;
    pre.append(code);
    details.append(summary, pre);
    parent.append(details);
  };

  const visualFallback = (parent: any, node: any, error: string) => {
    const figure = document.createElement("figure");
    figure.className = "code-block visual-fallback";
    const caption = document.createElement("figcaption");
    const language = document.createElement("span");
    language.className = "code-language";
    language.textContent = node.format === "mermaid" ? "Mermaid" : "SVG";
    caption.append(language, copyButton(node.value, language.textContent));
    const message = document.createElement("p");
    message.className = "visual-error";
    message.setAttribute("role", "status");
    message.textContent = error;
    figure.append(caption, message);
    appendExactSource(figure, node.value, language.textContent, true);
    parent.append(figure);
  };

  const svgElement = (name: string) =>
    document.createElementNS(svgNamespace, name);

  const mermaidVisual = (parent: any, node: any): string | null => {
    const result = parseMermaid(node.value);
    if (!result.ok) return result.error;
    const diagram = result.value;
    const figure = document.createElement("figure");
    figure.className = "visual-block mermaid-block";
    const caption = document.createElement("figcaption");
    const label = document.createElement("span");
    label.className = "visual-label";
    label.textContent = "Mermaid diagram";
    caption.append(label, copyButton(node.value, "Mermaid"));

    const viewport = document.createElement("div");
    viewport.className = "visual-viewport";
    const svg = svgElement("svg");
    svg.classList.add("diagram-svg");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", diagram.alternative);

    const appendTextLines = (
      text: any,
      value: string,
      x: number,
      centerY: number,
    ) => {
      const lines = value.split("\n").slice(0, 3);
      lines.forEach((line: string, index: number) => {
        const tspan = svgElement("tspan");
        tspan.setAttribute("x", String(x));
        tspan.setAttribute(
          "y",
          String(centerY + (index - (lines.length - 1) / 2) * 15 + 5),
        );
        tspan.textContent = line.length > 32 ? line.slice(0, 31) + "…" : line;
        text.append(tspan);
      });
    };

    if (diagram.kind === "sequence") {
      const laneWidth = 210;
      const padding = 34;
      const headerHeight = 54;
      const stepHeight = 54;
      const width = padding * 2 +
        Math.max(1, diagram.participants.length - 1) * laneWidth + 180;
      const height = padding * 2 + headerHeight +
        diagram.steps.length * stepHeight;
      svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
      const lanes = new Map();
      diagram.participants.forEach((participant: any, index: number) => {
        const x = padding + 90 + index * laneWidth;
        lanes.set(participant.id, x);
        const header = svgElement("rect");
        header.classList.add("diagram-node");
        header.setAttribute("x", String(x - 80));
        header.setAttribute("y", String(padding));
        header.setAttribute("width", "160");
        header.setAttribute("height", String(headerHeight));
        header.setAttribute("rx", participant.actor ? "24" : "5");
        svg.append(header);
        const name = svgElement("text");
        name.classList.add("diagram-node-label");
        name.setAttribute("x", String(x));
        name.setAttribute("y", String(padding + headerHeight / 2 + 5));
        name.setAttribute("text-anchor", "middle");
        name.textContent = participant.label.length > 24
          ? participant.label.slice(0, 23) + "…"
          : participant.label;
        svg.append(name);
        const lifeline = svgElement("line");
        lifeline.classList.add("diagram-lifeline");
        lifeline.setAttribute("x1", String(x));
        lifeline.setAttribute("y1", String(padding + headerHeight));
        lifeline.setAttribute("x2", String(x));
        lifeline.setAttribute("y2", String(height - padding));
        svg.append(lifeline);
      });

      const blocks: { y: number; block: string; label: string }[] = [];
      diagram.steps.forEach((step: any, index: number) => {
        const y = padding + headerHeight + (index + 0.65) * stepHeight;
        if (step.kind === "block_start") {
          blocks.push({ y: y - stepHeight * 0.45, ...step });
          return;
        }
        if (step.kind === "block_end") {
          const block = blocks.pop();
          if (!block) return;
          const box = svgElement("rect");
          box.classList.add("diagram-sequence-block");
          box.setAttribute("x", String(padding / 2));
          box.setAttribute("y", String(block.y));
          box.setAttribute("width", String(width - padding));
          box.setAttribute("height", String(y - block.y + stepHeight * 0.25));
          svg.insertBefore(box, svg.firstChild);
          const blockLabel = svgElement("text");
          blockLabel.classList.add("diagram-edge-label");
          blockLabel.setAttribute("x", String(padding));
          blockLabel.setAttribute("y", String(block.y + 15));
          blockLabel.textContent = `${block.block}: ${block.label}`;
          svg.append(blockLabel);
          return;
        }
        const x1 = lanes.get(step.from);
        const x2 = lanes.get(step.to);
        const direction = x2 >= x1 ? 1 : -1;
        const message = svgElement("line");
        message.classList.add(
          step.dashed ? "diagram-message-dashed" : "diagram-edge",
        );
        message.setAttribute("x1", String(x1));
        message.setAttribute("y1", String(y));
        message.setAttribute("x2", String(x2 - direction * 10));
        message.setAttribute("y2", String(y));
        svg.append(message);
        const arrow = svgElement("polygon");
        arrow.classList.add("diagram-arrow");
        arrow.setAttribute(
          "points",
          `${x2},${y} ${x2 - direction * 11},${y - 6} ${x2 - direction * 11},${
            y + 6
          }`,
        );
        svg.append(arrow);
        const messageLabel = svgElement("text");
        messageLabel.classList.add("diagram-edge-label");
        messageLabel.setAttribute("x", String((x1 + x2) / 2));
        messageLabel.setAttribute("y", String(y - 8));
        messageLabel.setAttribute("text-anchor", "middle");
        messageLabel.textContent = step.label.length > 42
          ? step.label.slice(0, 41) + "…"
          : step.label;
        svg.append(messageLabel);
      });
      viewport.append(svg);
      figure.append(caption, viewport);
      appendExactSource(figure, node.value, "Mermaid", false);
      parent.append(figure);
      return null;
    }

    const count = diagram.nodes.length;
    const columns = Math.min(
      diagram.direction === "LR" || diagram.direction === "RL" ? 4 : 3,
      Math.max(1, Math.ceil(Math.sqrt(count))),
    );
    const rows = Math.ceil(count / columns);
    const nodeWidth = 180;
    const nodeHeight = 64;
    const gapX = 70;
    const gapY = 70;
    const padding = 28;
    const width = padding * 2 + columns * nodeWidth +
      Math.max(0, columns - 1) * gapX;
    const height = padding * 2 + rows * nodeHeight +
      Math.max(0, rows - 1) * gapY;
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    const positions = new Map();
    diagram.nodes.forEach((item: any, index: number) => {
      const logicalColumn = index % columns;
      const logicalRow = Math.floor(index / columns);
      const column = diagram.direction === "RL"
        ? columns - logicalColumn - 1
        : logicalColumn;
      const row = diagram.direction === "BT"
        ? rows - logicalRow - 1
        : logicalRow;
      positions.set(item.id, {
        x: padding + column * (nodeWidth + gapX),
        y: padding + row * (nodeHeight + gapY),
      });
    });

    for (const group of diagram.groups) {
      const members = group.nodes.map((id: string) => positions.get(id)).filter(
        Boolean,
      );
      if (members.length === 0) continue;
      const minX = Math.min(...members.map((position: any) => position.x)) - 16;
      const minY = Math.min(...members.map((position: any) => position.y)) - 25;
      const maxX = Math.max(...members.map((position: any) => position.x)) +
        nodeWidth + 16;
      const maxY = Math.max(...members.map((position: any) => position.y)) +
        nodeHeight + 16;
      const groupBox = svgElement("rect");
      groupBox.classList.add("diagram-group");
      groupBox.setAttribute("x", String(minX));
      groupBox.setAttribute("y", String(minY));
      groupBox.setAttribute("width", String(maxX - minX));
      groupBox.setAttribute("height", String(maxY - minY));
      groupBox.setAttribute("rx", "8");
      svg.append(groupBox);
      const groupLabel = svgElement("text");
      groupLabel.classList.add("diagram-group-label");
      groupLabel.setAttribute("x", String(minX + 10));
      groupLabel.setAttribute("y", String(minY + 17));
      groupLabel.textContent = group.label;
      svg.append(groupLabel);
    }

    for (const edge of diagram.edges) {
      const from = positions.get(edge.from);
      const to = positions.get(edge.to);
      const startX = from.x + nodeWidth / 2;
      const startY = from.y + nodeHeight / 2;
      const endX = to.x + nodeWidth / 2;
      const endY = to.y + nodeHeight / 2;
      const dx = endX - startX;
      const dy = endY - startY;
      const length = Math.max(1, Math.hypot(dx, dy));
      const inset = Math.min(nodeWidth, nodeHeight) / 2 + 3;
      const x1 = startX + dx / length * inset;
      const y1 = startY + dy / length * inset;
      const x2 = endX - dx / length * inset;
      const y2 = endY - dy / length * inset;
      const line = svgElement("line");
      line.classList.add("diagram-edge");
      line.setAttribute("x1", String(x1));
      line.setAttribute("y1", String(y1));
      line.setAttribute("x2", String(x2));
      line.setAttribute("y2", String(y2));
      svg.append(line);
      const appendArrow = (
        tipX: number,
        tipY: number,
        ux: number,
        uy: number,
      ) => {
        const size = 9;
        const baseX = tipX - ux * size;
        const baseY = tipY - uy * size;
        const arrow = svgElement("polygon");
        arrow.classList.add("diagram-arrow");
        arrow.setAttribute(
          "points",
          `${tipX},${tipY} ${baseX - uy * size * 0.55},${
            baseY + ux * size * 0.55
          } ${baseX + uy * size * 0.55},${baseY - ux * size * 0.55}`,
        );
        svg.append(arrow);
      };
      if (edge.arrow === "forward" || edge.arrow === "both") {
        appendArrow(x2, y2, dx / length, dy / length);
      }
      if (edge.arrow === "both") {
        appendArrow(x1, y1, -dx / length, -dy / length);
      }
      if (edge.label) {
        const edgeLabel = svgElement("text");
        edgeLabel.classList.add("diagram-edge-label");
        edgeLabel.setAttribute("x", String((x1 + x2) / 2));
        edgeLabel.setAttribute("y", String((y1 + y2) / 2 - 7));
        edgeLabel.setAttribute("text-anchor", "middle");
        edgeLabel.textContent = edge.label.length > 32
          ? edge.label.slice(0, 31) + "…"
          : edge.label;
        svg.append(edgeLabel);
      }
    }

    for (const item of diagram.nodes) {
      const position = positions.get(item.id);
      let shape;
      if (item.shape === "diamond") {
        shape = svgElement("polygon");
        shape.setAttribute(
          "points",
          `${position.x + nodeWidth / 2},${position.y} ${
            position.x + nodeWidth
          },${position.y + nodeHeight / 2} ${position.x + nodeWidth / 2},${
            position.y + nodeHeight
          } ${position.x},${position.y + nodeHeight / 2}`,
        );
      } else {
        shape = svgElement("rect");
        shape.setAttribute("x", String(position.x));
        shape.setAttribute("y", String(position.y));
        shape.setAttribute("width", String(nodeWidth));
        shape.setAttribute("height", String(nodeHeight));
        if (item.shape === "rounded" || item.shape === "cylinder") {
          shape.setAttribute("rx", String(nodeHeight / 2));
        }
      }
      shape.classList.add("diagram-node");
      svg.append(shape);
      const text = svgElement("text");
      text.classList.add("diagram-node-label");
      text.setAttribute("x", String(position.x + nodeWidth / 2));
      text.setAttribute("y", String(position.y + nodeHeight / 2 + 5));
      text.setAttribute("text-anchor", "middle");
      appendTextLines(
        text,
        item.label,
        position.x + nodeWidth / 2,
        position.y + nodeHeight / 2,
      );
      svg.append(text);
    }
    viewport.append(svg);
    figure.append(caption, viewport);
    appendExactSource(figure, node.value, "Mermaid", false);
    parent.append(figure);
    return null;
  };

  const sanitizedSvgVisual = (parent: any, node: any): string | null => {
    const result = sanitizeSvg(node.value);
    if (!result.ok) return result.error;
    const figure = document.createElement("figure");
    figure.className = "visual-block svg-block";
    const caption = document.createElement("figcaption");
    const label = document.createElement("span");
    label.className = "visual-label";
    label.textContent = "SVG visual";
    caption.append(label, copyButton(node.value, "SVG"));
    const viewport = document.createElement("div");
    viewport.className = "visual-viewport";
    const build = (safeNode: any): any => {
      const element = svgElement(safeNode.name);
      for (const [name, value] of Object.entries(safeNode.attributes)) {
        element.setAttribute(name, value);
      }
      for (const child of safeNode.children) {
        element.append(
          typeof child === "string"
            ? document.createTextNode(child)
            : build(child),
        );
      }
      return element;
    };
    const svg = build(result.value.root);
    svg.classList.add("diagram-svg");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", result.value.alternative);
    viewport.append(svg);
    figure.append(caption, viewport);
    appendExactSource(figure, node.value, "SVG", false);
    parent.append(figure);
    return null;
  };

  const codeBlock = (parent: any, node: any) => {
    const figure = document.createElement("figure");
    figure.className = node.complete ? "code-block" : "code-block streaming";
    const caption = document.createElement("figcaption");
    const language = document.createElement("span");
    language.className = "code-language";
    language.textContent = node.language || "Code";
    const button = copyButton(node.value, node.language || "code", "Copy");
    caption.append(language, button);
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    if (node.language) code.dataset.language = node.language;
    code.textContent = node.value;
    pre.append(code);
    figure.append(caption, pre);
    parent.append(figure);
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
    } else if (node.type === "visual_block") {
      const error = node.format === "mermaid"
        ? mermaidVisual(parent, node)
        : sanitizedSvgVisual(parent, node);
      if (error) visualFallback(parent, node, error);
    } else {
      codeBlock(parent, node);
    }
  };

  browser.vantageRenderMarkdown = (
    root: any,
    source: string,
  ): boolean => {
    try {
      const fragment = document.createDocumentFragment();
      for (const node of parseMarkdown(source)) block(fragment, node);
      root.classList.remove("render-fallback");
      root.replaceChildren(fragment);
      return true;
    } catch {
      root.classList.add("render-fallback");
      root.textContent = source;
      return false;
    }
  };
}

export const MARKDOWN_JAVASCRIPT =
  `const MERMAID_SOURCE_LIMIT = ${MERMAID_SOURCE_LIMIT};\n` +
  `const SVG_SOURCE_LIMIT = ${SVG_SOURCE_LIMIT};\n` +
  [
    mermaidNodeToken,
    mermaidPlainLabel,
    parseMermaidSequence,
    parseMermaidFlowchart,
    parseMermaid,
    decodeXmlText,
    findXmlTagEnd,
    parseXmlAttributes,
    safeSvgNumber,
    safeSvgNumberList,
    safeSvgColor,
    safeSvgTransform,
    sanitizeSvgAttributes,
    safeSvgAlternative,
    sanitizeSvg,
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
