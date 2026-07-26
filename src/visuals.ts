export const MERMAID_SOURCE_LIMIT = 32_768;
export const SVG_SOURCE_LIMIT = 65_536;

export interface MermaidNode {
  readonly id: string;
  readonly label: string;
  readonly shape: "rectangle" | "rounded" | "diamond" | "cylinder";
}

export interface MermaidEdge {
  readonly from: string;
  readonly to: string;
  readonly label: string;
  readonly arrow: "none" | "forward" | "both";
}

export interface MermaidGroup {
  readonly id: string;
  readonly label: string;
  readonly nodes: readonly string[];
}

export interface MermaidFlowchart {
  readonly kind: "flowchart";
  readonly direction: "TD" | "BT" | "LR" | "RL";
  readonly nodes: readonly MermaidNode[];
  readonly edges: readonly MermaidEdge[];
  readonly groups: readonly MermaidGroup[];
  readonly alternative: string;
}

export interface MermaidParticipant {
  readonly id: string;
  readonly label: string;
  readonly actor: boolean;
}

export type MermaidSequenceStep =
  | {
    readonly kind: "message";
    readonly from: string;
    readonly to: string;
    readonly label: string;
    readonly dashed: boolean;
  }
  | {
    readonly kind: "block_start";
    readonly block: string;
    readonly label: string;
  }
  | { readonly kind: "block_end" };

export interface MermaidSequence {
  readonly kind: "sequence";
  readonly participants: readonly MermaidParticipant[];
  readonly steps: readonly MermaidSequenceStep[];
  readonly alternative: string;
}

export type MermaidDiagram = MermaidFlowchart | MermaidSequence;

export interface SafeSvgNode {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly (SafeSvgNode | string)[];
}

export interface SafeSvg {
  readonly root: SafeSvgNode;
  readonly alternative: string;
}

export type VisualResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

export function mermaidNodeToken(
  value: string,
): {
  readonly id: string;
  readonly label: string;
  readonly shape: MermaidNode["shape"];
} | null {
  const match =
    /^([A-Za-z][A-Za-z0-9_-]{0,31})(?:\s*(\[\([^\]\r\n]{1,120}\)\]|\[[^\]\r\n]{1,120}\]|\([^)\r\n]{1,120}\)|\{[^}\r\n]{1,120}\}))?$/
      .exec(value.trim());
  if (!match) return null;
  const descriptor = match[2];
  if (!descriptor) {
    return { id: match[1], label: match[1], shape: "rectangle" };
  }
  const cylinder = descriptor.startsWith("[(");
  let label = cylinder
    ? descriptor.slice(2, -2).trim()
    : descriptor.slice(1, -1).trim();
  if (
    label.length >= 2 &&
    ((label.startsWith('"') && label.endsWith('"')) ||
      (label.startsWith("'") && label.endsWith("'")))
  ) {
    label = label.slice(1, -1);
  }
  if (label === "") return null;
  return {
    id: match[1],
    label: label.replace(/<br\s*\/?>/gi, "\n"),
    shape: cylinder
      ? "cylinder"
      : descriptor.startsWith("{")
      ? "diamond"
      : descriptor.startsWith("(")
      ? "rounded"
      : "rectangle",
  };
}

export function mermaidPlainLabel(value: string): string | null {
  let label = value.trim();
  if (
    label.length >= 2 &&
    ((label.startsWith('"') && label.endsWith('"')) ||
      (label.startsWith("'") && label.endsWith("'")))
  ) {
    label = label.slice(1, -1);
  }
  label = label.replace(/<br\s*\/?>/gi, "\n").trim();
  return label !== "" && label.length <= 160 ? label : null;
}

export function parseMermaidSequence(
  lines: readonly string[],
  headerIndex: number,
): VisualResult<MermaidSequence> {
  const participants = new Map<string, MermaidParticipant>();
  const steps: MermaidSequenceStep[] = [];
  let blockDepth = 0;
  const remember = (id: string, label = id, actor = false): boolean => {
    const existing = participants.get(id);
    if (!existing) {
      participants.set(id, { id, label, actor });
      return true;
    }
    if (existing.label === id && label !== id) {
      participants.set(id, { id, label, actor });
      return true;
    }
    return existing.label === label || label === id;
  };

  for (let lineIndex = headerIndex + 1; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex].trim();
    if (line === "" || line.startsWith("%%")) continue;
    const declaration =
      /^(actor|participant)\s+([A-Za-z][A-Za-z0-9_-]{0,31})(?:\s+as\s+(.+))?$/i
        .exec(line);
    if (declaration) {
      const label = mermaidPlainLabel(declaration[3] ?? declaration[2]);
      if (
        !label ||
        !remember(
          declaration[2],
          label,
          declaration[1].toLowerCase() === "actor",
        )
      ) {
        return {
          ok: false,
          error: `Invalid Mermaid statement on line ${lineIndex + 1}.`,
        };
      }
      continue;
    }
    const message =
      /^([A-Za-z][A-Za-z0-9_-]{0,31}?)\s*(-->>|->>|-->|->)\s*([A-Za-z][A-Za-z0-9_-]{0,31})\s*:\s*(.+)$/
        .exec(line);
    if (message) {
      const label = mermaidPlainLabel(message[4]);
      if (
        !label || !remember(message[1]) || !remember(message[3]) ||
        label.length > 160
      ) {
        return {
          ok: false,
          error: `Invalid Mermaid statement on line ${lineIndex + 1}.`,
        };
      }
      steps.push({
        kind: "message",
        from: message[1],
        to: message[3],
        label,
        dashed: message[2].startsWith("--"),
      });
    } else {
      const block = /^(loop|opt|alt|par|critical|break|rect)\s+(.+)$/i.exec(
        line,
      );
      if (block) {
        const label = mermaidPlainLabel(block[2]);
        if (!label || blockDepth >= 8) {
          return {
            ok: false,
            error: `Invalid Mermaid statement on line ${lineIndex + 1}.`,
          };
        }
        steps.push({
          kind: "block_start",
          block: block[1].toLowerCase(),
          label,
        });
        blockDepth++;
      } else if (/^end$/i.test(line) && blockDepth > 0) {
        steps.push({ kind: "block_end" });
        blockDepth--;
      } else {
        return {
          ok: false,
          error: `Invalid Mermaid statement on line ${lineIndex + 1}.`,
        };
      }
    }
    if (participants.size > 24 || steps.length > 160) {
      return {
        ok: false,
        error: "Mermaid sequence exceeds the 24-participant or 160-step limit.",
      };
    }
  }
  if (participants.size === 0 || steps.length === 0 || blockDepth !== 0) {
    return { ok: false, error: "Mermaid sequence diagram is incomplete." };
  }
  const participantValues = [...participants.values()];
  const messages = steps.filter((step) => step.kind === "message");
  return {
    ok: true,
    value: {
      kind: "sequence",
      participants: participantValues,
      steps,
      alternative: `Sequence diagram. Participants: ${
        participantValues.map((participant) => participant.label).join("; ")
      }. Messages: ${
        messages.map((step) =>
          step.kind === "message"
            ? `${step.from} to ${step.to}, ${step.label}`
            : ""
        ).filter(Boolean).join("; ")
      }.`,
    },
  };
}

export function parseMermaidFlowchart(
  lines: readonly string[],
  headerIndex: number,
  direction: MermaidFlowchart["direction"],
): VisualResult<MermaidFlowchart> {
  const nodes = new Map<string, MermaidNode>();
  const edges: MermaidEdge[] = [];
  const groups: { id: string; label: string; nodes: string[] }[] = [];
  const groupStack: { id: string; label: string; nodes: string[] }[] = [];

  const remember = (candidate: MermaidNode): boolean => {
    const existing = nodes.get(candidate.id);
    if (!existing) {
      nodes.set(candidate.id, candidate);
      const group = groupStack.at(-1);
      if (group && !group.nodes.includes(candidate.id)) {
        group.nodes.push(candidate.id);
      }
      return true;
    }
    if (candidate.label === candidate.id && candidate.shape === "rectangle") {
      return true;
    }
    if (existing.label === existing.id && existing.shape === "rectangle") {
      nodes.set(candidate.id, candidate);
      return true;
    }
    return existing.label === candidate.label &&
      existing.shape === candidate.shape;
  };

  for (let lineIndex = headerIndex + 1; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex].trim();
    if (line === "" || line.startsWith("%%")) continue;
    const subgraph =
      /^subgraph\s+([A-Za-z][A-Za-z0-9_-]{0,31})(?:\s*(?:\[(.+)\]|\s+(.+)))?$/i
        .exec(line);
    if (subgraph) {
      const label = mermaidPlainLabel(
        subgraph[2] ?? subgraph[3] ?? subgraph[1],
      );
      if (!label || groupStack.length >= 4) {
        return {
          ok: false,
          error: `Invalid Mermaid statement on line ${lineIndex + 1}.`,
        };
      }
      const group = { id: subgraph[1], label, nodes: [] };
      groups.push(group);
      groupStack.push(group);
      continue;
    }
    if (/^end$/i.test(line) && groupStack.length > 0) {
      groupStack.pop();
      continue;
    }
    const edge = /^(.*?)\s*(<-->|-->|---)\s*(?:\|([^|\r\n]{1,160})\|\s*)?(.*?)$/
      .exec(line);
    if (edge) {
      const from = mermaidNodeToken(edge[1]);
      const to = mermaidNodeToken(edge[4]);
      const label = edge[3] === undefined ? "" : mermaidPlainLabel(edge[3]);
      if (
        !from || !to || label === null || !remember(from) || !remember(to)
      ) {
        return {
          ok: false,
          error: `Invalid Mermaid statement on line ${lineIndex + 1}.`,
        };
      }
      edges.push({
        from: from.id,
        to: to.id,
        label,
        arrow: edge[2] === "<-->"
          ? "both"
          : edge[2] === "-->"
          ? "forward"
          : "none",
      });
    } else {
      const node = mermaidNodeToken(line);
      if (!node || !remember(node)) {
        return {
          ok: false,
          error: `Invalid Mermaid statement on line ${lineIndex + 1}.`,
        };
      }
    }
    if (nodes.size > 40 || edges.length > 80 || groups.length > 12) {
      return {
        ok: false,
        error: "Mermaid diagram exceeds its node, edge, or subgraph limit.",
      };
    }
  }
  if (groupStack.length > 0) {
    return { ok: false, error: "Mermaid flowchart has an unclosed subgraph." };
  }
  if (nodes.size === 0) {
    return { ok: false, error: "Mermaid flowchart has no nodes." };
  }
  const nodeValues = [...nodes.values()];
  const alternative = [
    `Flowchart ${direction}.`,
    `Nodes: ${
      nodeValues.map((node) => `${node.id}, ${node.label}`).join("; ")
    }.`,
    edges.length > 0
      ? `Connections: ${
        edges.map((edge) =>
          `${edge.from} ${edge.arrow === "none" ? "with" : "to"} ${edge.to}${
            edge.label ? `, ${edge.label}` : ""
          }`
        ).join("; ")
      }.`
      : "",
  ].filter(Boolean).join(" ");
  return {
    ok: true,
    value: {
      kind: "flowchart",
      direction,
      nodes: nodeValues,
      edges,
      groups,
      alternative,
    },
  };
}

export function parseMermaid(source: string): VisualResult<MermaidDiagram> {
  if (source.length > MERMAID_SOURCE_LIMIT) {
    return { ok: false, error: "Mermaid source exceeds the 32 KiB limit." };
  }
  const lines = source.replace(/\r\n?|\n/g, "\n").split("\n");
  if (lines.length > 256) {
    return { ok: false, error: "Mermaid source exceeds the 256-line limit." };
  }
  let lineIndex = 0;
  while (lineIndex < lines.length && lines[lineIndex].trim() === "") {
    lineIndex++;
  }
  if (/^sequenceDiagram\s*$/i.test(lines[lineIndex]?.trim() ?? "")) {
    return parseMermaidSequence(lines, lineIndex);
  }
  const header = /^(?:flowchart|graph)\s+(TD|TB|BT|LR|RL)\s*$/i.exec(
    lines[lineIndex]?.trim() ?? "",
  );
  if (!header) {
    return {
      ok: false,
      error: "Unsupported Mermaid. Use a flowchart or sequence diagram.",
    };
  }
  const direction =
    (header[1].toUpperCase() === "TB"
      ? "TD"
      : header[1].toUpperCase()) as MermaidFlowchart["direction"];
  return parseMermaidFlowchart(lines, lineIndex, direction);
}

export function decodeXmlText(value: string): string | null {
  let valid = true;
  const decoded = value.replace(
    /&(#x[0-9A-Fa-f]+|#[0-9]+|amp|lt|gt|quot|apos);/g,
    (_match, entity: string) => {
      if (entity === "amp") return "&";
      if (entity === "lt") return "<";
      if (entity === "gt") return ">";
      if (entity === "quot") return '"';
      if (entity === "apos") return "'";
      const numeric = entity.startsWith("#x")
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      if (
        !Number.isInteger(numeric) || numeric <= 0 ||
        numeric > 0x10ffff || (numeric >= 0xd800 && numeric <= 0xdfff) ||
        (numeric <= 0x1f && numeric !== 0x09 && numeric !== 0x0a &&
          numeric !== 0x0d) ||
        numeric === 0x7f
      ) {
        valid = false;
        return "";
      }
      return String.fromCodePoint(numeric);
    },
  );
  if (!valid || /&[^;\s]*;|&/.test(decoded)) return null;
  return decoded;
}

export function findXmlTagEnd(source: string, start: number): number {
  let quote = "";
  for (let index = start; index < source.length; index++) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = "";
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  return -1;
}

export function parseXmlAttributes(
  source: string,
): VisualResult<Record<string, string>> {
  const attributes: Record<string, string> = {};
  let cursor = 0;
  while (cursor < source.length) {
    while (/\s/.test(source[cursor] ?? "")) cursor++;
    if (cursor >= source.length) break;
    const name = /^[A-Za-z_:][A-Za-z0-9_.:-]*/.exec(source.slice(cursor));
    if (!name) {
      return { ok: false, error: "SVG contains malformed attributes." };
    }
    cursor += name[0].length;
    while (/\s/.test(source[cursor] ?? "")) cursor++;
    if (source[cursor] !== "=") {
      return { ok: false, error: "SVG attributes must use quoted values." };
    }
    cursor++;
    while (/\s/.test(source[cursor] ?? "")) cursor++;
    const quote = source[cursor];
    if (quote !== '"' && quote !== "'") {
      return { ok: false, error: "SVG attributes must use quoted values." };
    }
    const end = source.indexOf(quote, cursor + 1);
    if (end < 0) {
      return { ok: false, error: "SVG contains an unterminated attribute." };
    }
    if (Object.hasOwn(attributes, name[0])) {
      return { ok: false, error: "SVG contains a duplicate attribute." };
    }
    const decoded = decodeXmlText(source.slice(cursor + 1, end));
    if (decoded === null) {
      return { ok: false, error: "SVG contains an unsupported entity." };
    }
    attributes[name[0]] = decoded;
    cursor = end + 1;
  }
  return { ok: true, value: attributes };
}

export function safeSvgNumber(value: string): boolean {
  return /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(value) &&
    Number.isFinite(Number(value)) && Math.abs(Number(value)) <= 1_000_000;
}

export function safeSvgNumberList(
  value: string,
  minimum = 1,
  maximum = 8,
): boolean {
  const values = value.trim().split(/[\s,]+/).filter(Boolean);
  return values.length >= minimum && values.length <= maximum &&
    values.every(safeSvgNumber);
}

export function safeSvgColor(value: string): boolean {
  const normalized = value.trim();
  if (/^(none|currentColor|transparent)$/i.test(normalized)) return true;
  if (/^#[0-9A-Fa-f]{3,4}(?:[0-9A-Fa-f]{3,4})?$/.test(normalized)) return true;
  if (
    /^(black|white|gray|grey|red|green|blue|yellow|orange|purple|pink|brown|cyan|magenta)$/i
      .test(normalized)
  ) return true;
  return /^rgba?\(\s*[\d.]+%?(?:\s*,\s*[\d.]+%?){2}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/i
    .test(normalized);
}

export function safeSvgTransform(value: string): boolean {
  let remainder = value.trim();
  const operation =
    /^(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^()]*)\)\s*/;
  let count = 0;
  while (remainder !== "") {
    const match = operation.exec(remainder);
    if (!match || !safeSvgNumberList(match[2], 1, 6)) return false;
    remainder = remainder.slice(match[0].length);
    if (++count > 12) return false;
  }
  return count > 0;
}

export function sanitizeSvgAttributes(
  name: string,
  values: Readonly<Record<string, string>>,
): VisualResult<Record<string, string>> {
  const geometry: Record<string, readonly string[]> = {
    svg: ["viewBox", "width", "height", "preserveAspectRatio", "xmlns"],
    g: ["transform"],
    path: ["d", "transform"],
    rect: ["x", "y", "width", "height", "rx", "ry", "transform"],
    circle: ["cx", "cy", "r", "transform"],
    ellipse: ["cx", "cy", "rx", "ry", "transform"],
    line: ["x1", "y1", "x2", "y2", "transform"],
    polyline: ["points", "transform"],
    polygon: ["points", "transform"],
    text: [
      "x",
      "y",
      "dx",
      "dy",
      "transform",
      "text-anchor",
      "dominant-baseline",
    ],
    tspan: ["x", "y", "dx", "dy", "text-anchor", "dominant-baseline"],
    title: [],
    desc: [],
  };
  const presentation = [
    "fill",
    "fill-opacity",
    "fill-rule",
    "stroke",
    "stroke-width",
    "stroke-opacity",
    "stroke-linecap",
    "stroke-linejoin",
    "stroke-dasharray",
    "opacity",
    "font-size",
    "font-weight",
  ];
  const allowed = new Set([...(geometry[name] ?? []), ...presentation]);
  const result: Record<string, string> = {};
  for (const [attribute, value] of Object.entries(values)) {
    const lower = attribute.toLowerCase();
    if (
      lower.startsWith("on") || lower === "style" || lower === "href" ||
      lower.endsWith(":href") || !allowed.has(attribute)
    ) {
      return {
        ok: false,
        error: `SVG attribute "${attribute}" is not allowed.`,
      };
    }
    let safe = false;
    if (attribute === "xmlns") {
      safe = name === "svg" && value === "http://www.w3.org/2000/svg";
    } else if (attribute === "viewBox") {
      safe = safeSvgNumberList(value, 4, 4) &&
        Number(value.trim().split(/[\s,]+/)[2]) > 0 &&
        Number(value.trim().split(/[\s,]+/)[3]) > 0;
    } else if (attribute === "preserveAspectRatio") {
      safe = /^(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max)(?:\s+(?:meet|slice))?)$/
        .test(value);
    } else if (
      [
        "x",
        "y",
        "x1",
        "y1",
        "x2",
        "y2",
        "cx",
        "cy",
        "r",
        "rx",
        "ry",
        "width",
        "height",
        "dx",
        "dy",
        "stroke-width",
        "font-size",
      ].includes(attribute)
    ) {
      safe = safeSvgNumber(value);
    } else if (
      ["fill-opacity", "stroke-opacity", "opacity"].includes(attribute)
    ) {
      safe = safeSvgNumber(value) && Number(value) >= 0 && Number(value) <= 1;
    } else if (attribute === "fill" || attribute === "stroke") {
      safe = safeSvgColor(value);
    } else if (attribute === "d") {
      safe = value.length <= 16_384 &&
        /^[MmLlHhVvCcSsQqTtAaZz0-9eE+.,\s-]+$/.test(value) &&
        /[MmLlHhVvCcSsQqTtAaZz]/.test(value);
    } else if (attribute === "points" || attribute === "stroke-dasharray") {
      safe = safeSvgNumberList(value, 2, attribute === "points" ? 512 : 32);
    } else if (attribute === "transform") {
      safe = safeSvgTransform(value);
    } else if (attribute === "fill-rule") {
      safe = /^(nonzero|evenodd)$/.test(value);
    } else if (attribute === "stroke-linecap") {
      safe = /^(butt|round|square)$/.test(value);
    } else if (attribute === "stroke-linejoin") {
      safe = /^(miter|round|bevel)$/.test(value);
    } else if (attribute === "text-anchor") {
      safe = /^(start|middle|end)$/.test(value);
    } else if (attribute === "dominant-baseline") {
      safe = /^(auto|middle|central|hanging|text-after-edge|text-before-edge)$/
        .test(value);
    } else if (attribute === "font-weight") {
      safe = /^(normal|bold|[1-9]00)$/.test(value);
    }
    if (!safe) {
      return {
        ok: false,
        error: `SVG attribute "${attribute}" has an unsafe value.`,
      };
    }
    if (
      attribute !== "xmlns" && attribute !== "width" && attribute !== "height"
    ) {
      result[attribute] = value;
    }
  }
  return { ok: true, value: result };
}

export function safeSvgAlternative(node: SafeSvgNode): string {
  const pieces: string[] = [];
  const visit = (candidate: SafeSvgNode | string, inAlternative: boolean) => {
    if (typeof candidate === "string") {
      if (inAlternative) pieces.push(candidate);
      return;
    }
    const selected = inAlternative || candidate.name === "title" ||
      candidate.name === "desc";
    for (const child of candidate.children) visit(child, selected);
  };
  visit(node, false);
  return pieces.join(" ").replace(/\s+/g, " ").trim().slice(0, 500);
}

export function sanitizeSvg(source: string): VisualResult<SafeSvg> {
  if (source.length > SVG_SOURCE_LIMIT) {
    return { ok: false, error: "SVG source exceeds the 64 KiB limit." };
  }
  // deno-lint-ignore no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(source)) {
    return { ok: false, error: "SVG contains disallowed control characters." };
  }
  const allowedElements = new Set([
    "svg",
    "g",
    "path",
    "rect",
    "circle",
    "ellipse",
    "line",
    "polyline",
    "polygon",
    "text",
    "tspan",
    "title",
    "desc",
  ]);
  type MutableNode = {
    name: string;
    attributes: Record<string, string>;
    children: (MutableNode | string)[];
  };
  const stack: MutableNode[] = [];
  let root: MutableNode | null = null;
  let cursor = 0;
  let elementCount = 0;
  while (cursor < source.length) {
    const open = source.indexOf("<", cursor);
    const textEnd = open < 0 ? source.length : open;
    if (textEnd > cursor) {
      const decoded = decodeXmlText(source.slice(cursor, textEnd));
      if (decoded === null) {
        return { ok: false, error: "SVG contains an unsupported entity." };
      }
      if (decoded.trim() !== "" && stack.length === 0) {
        return {
          ok: false,
          error: "SVG contains text outside its root element.",
        };
      }
      if (stack.length > 0 && decoded !== "") {
        stack.at(-1)!.children.push(decoded);
      }
    }
    if (open < 0) break;
    if (source.startsWith("<!--", open)) {
      const end = source.indexOf("-->", open + 4);
      if (end < 0) {
        return { ok: false, error: "SVG contains an unterminated comment." };
      }
      cursor = end + 3;
      continue;
    }
    if (source.startsWith("<?xml", open)) {
      if (root || stack.length > 0 || source.slice(0, open).trim() !== "") {
        return { ok: false, error: "SVG XML declaration is misplaced." };
      }
      const end = source.indexOf("?>", open + 5);
      if (end < 0) {
        return { ok: false, error: "SVG XML declaration is unterminated." };
      }
      if (
        !/^<\?xml\s+version\s*=\s*["']1\.[01]["']\s*\?>$/.test(
          source.slice(open, end + 2),
        )
      ) {
        return { ok: false, error: "SVG XML declaration is unsupported." };
      }
      cursor = end + 2;
      continue;
    }
    if (source.startsWith("<!", open) || source.startsWith("<?", open)) {
      return {
        ok: false,
        error:
          "SVG declarations, entities, and processing instructions are not allowed.",
      };
    }
    const end = findXmlTagEnd(source, open + 1);
    if (end < 0) {
      return { ok: false, error: "SVG contains an unterminated tag." };
    }
    let tag = source.slice(open + 1, end).trim();
    const closing = tag.startsWith("/");
    if (closing) tag = tag.slice(1).trim();
    const selfClosing = !closing && tag.endsWith("/");
    if (selfClosing) tag = tag.slice(0, -1).trim();
    const nameMatch = /^[A-Za-z][A-Za-z0-9-]*/.exec(tag);
    if (!nameMatch || (closing && tag !== nameMatch[0])) {
      return { ok: false, error: "SVG contains a malformed tag." };
    }
    const name = nameMatch[0];
    if (!allowedElements.has(name)) {
      return { ok: false, error: `SVG element "${name}" is not allowed.` };
    }
    if (closing) {
      if (stack.at(-1)?.name !== name) {
        return { ok: false, error: "SVG contains mismatched closing tags." };
      }
      stack.pop();
    } else {
      const parsedAttributes = parseXmlAttributes(tag.slice(name.length));
      if (!parsedAttributes.ok) return parsedAttributes;
      const attributes = sanitizeSvgAttributes(name, parsedAttributes.value);
      if (!attributes.ok) return attributes;
      const node: MutableNode = {
        name,
        attributes: attributes.value,
        children: [],
      };
      if (stack.length === 0) {
        if (root) {
          return {
            ok: false,
            error: "SVG must contain exactly one root element.",
          };
        }
        root = node;
      } else {
        stack.at(-1)!.children.push(node);
      }
      elementCount++;
      if (elementCount > 512 || stack.length >= 32) {
        return {
          ok: false,
          error: "SVG exceeds the 512-element or 32-level limit.",
        };
      }
      if (!selfClosing) stack.push(node);
    }
    cursor = end + 1;
  }
  if (!root || root.name !== "svg" || stack.length !== 0) {
    return {
      ok: false,
      error: "SVG must contain one complete svg root element.",
    };
  }
  if (!Object.hasOwn(root.attributes, "viewBox")) {
    return { ok: false, error: "SVG requires a positive numeric viewBox." };
  }
  const safeRoot = root as SafeSvgNode;
  return {
    ok: true,
    value: {
      root: safeRoot,
      alternative: safeSvgAlternative(safeRoot) ||
        "SVG visual. Exact source is available below.",
    },
  };
}
