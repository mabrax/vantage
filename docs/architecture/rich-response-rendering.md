# Rich response rendering

Status: **Accepted safe Markdown and visual boundary for Milestone 2 issues #18
and #19**

The [Milestone 2 map](../milestones/02-rich-markdown.md) owns the vertical-wide
outcome and sequencing. This document owns the trusted source-to-presentation
contract for streamed assistant Markdown and fenced code. It extends the
session-only transcript defined by the [first vertical slice](vertical-slice.md)
without changing native conversation behavior.

## Decision

Each assistant response has one ordered raw source string. The UI appends native
`assistant_delta` values to that string exactly once and in arrival order. After
each append, it parses the complete source-so-far into a presentation snapshot
and replaces only that response's rendered children.

The parser produces a small typed block and inline tree. The renderer creates a
fixed set of DOM elements with `document.createElement` and, for accepted visual
geometry, `createElementNS`. It assigns provider text with `textContent` or text
nodes. It never sends provider output through an HTML parser. User prompts
continue through their existing literal `textContent` path and are not parsed as
Markdown.

This is a presentation projection only. Native acceptance, delta ordering,
completion, interruption, failure, follow-up, retry, stop, and cleanup remain
owned by the existing session controller and event path.

## Source and projection contract

For every assistant turn:

1. `turn_pending` creates a transcript entry with an empty raw source and an
   empty rendered body.
2. Each `assistant_delta` is appended to the raw source without normalization,
   deduplication, or interpretation.
3. The complete source-so-far is reparsed into a new detached DOM fragment.
4. The fragment replaces the rendered children of that assistant entry only.
5. `turn_terminal` performs one final render from the same source before showing
   the native terminal state.

The raw source is transcript truth. The parsed tree and DOM are disposable
views. Parsing cannot edit the raw source, emit native commands, change turn
state, reach another transcript entry, or reorder prior content.

Reparsing the bounded response-so-far deliberately favors deterministic
snapshots over an incremental parser with hidden partial state. Chunk boundaries
therefore cannot change final presentation: the same concatenated source always
produces the same final tree. An incomplete construct may change presentation
when its closing delimiter arrives, but prior source remains readable and intact
throughout.

## Supported Markdown

The issue #18 parser recognizes:

- ATX headings, paragraphs, emphasis, and strong emphasis;
- unordered and ordered lists, including read-only task-list markers;
- blockquotes and thematic breaks;
- pipe tables with left, center, and right alignment markers;
- inline code;
- backtick and tilde fenced code blocks, with an optional language token; and
- inline links and image syntax under the non-navigation policy below.

Soft source line breaks render as visible line breaks so partial output remains
legible. Unsupported or malformed syntax stays literal text. Raw HTML is never a
supported Markdown extension. Indentation-sensitive nested lists, syntax
highlighting, autolinks, arbitrary HTML, media outside the bounded visual-fence
contract below, and application-specific rich components are outside this
contract.

## Code presentation and copying

A fenced block renders as a trusted `figure` containing:

- a visible supplied language token, or the neutral label `Code`;
- a user-initiated Copy button; and
- a horizontally scrollable `pre`/`code` region that cannot expand the
  transcript width.

The code element receives only a text node. Copy writes the exact raw fenced
payload represented by the code block, including its original line endings and
final newline when one appears before the closing fence. It does not include
fence delimiters or execute, evaluate, open, or send the code. Clipboard access
is attempted only from the Copy click. A browser copy fallback uses a temporary
read-only textarea containing the same value and removes it immediately
afterward.

An unclosed fence renders as a visibly streaming code block containing all
payload received so far. Arrival of a valid closing fence settles it to the same
result obtained by parsing the complete source in one operation.

## Completed visual fences

Only a closed fence whose case-insensitive language token is exactly `mermaid`
or `svg` becomes a visual intent in the typed presentation tree. An unclosed
fence stays the ordinary streaming code node, including its language label,
exact payload, and Copy action. Closing the fence does not by itself make
provider content safe: the format-specific bounded validator must accept the
complete payload before the renderer creates a visual.

An accepted visual is one trusted `figure` containing:

- a format label and user-initiated **Copy source** action;
- a non-interactive inline SVG with a trusted `role="img"` and derived text
  alternative;
- a contained viewport that scales to transcript width and owns any residual
  overflow; and
- a keyboard-operable disclosure containing the exact fenced payload, excluding
  delimiters.

The source disclosure is collapsed for a successful visual and open for a
rejected visual. Copying always uses the unchanged payload, including original
line endings and a final newline before the closing fence. The disclosure is
also the diagnostic and accessibility fallback when a visual cannot communicate
all source detail.

Validation failure, unsupported syntax, or a budget rejection produces a concise
status followed by the open exact-source disclosure. It does not throw from the
response projection, change the native terminal event, block a later prompt, or
discard the source. A later delta reparses the same ordered raw source under the
ordinary failure-isolation boundary.

### Deterministic offline Mermaid subset

Vantage implements a packaged flowchart renderer rather than loading Mermaid
from a CDN or executing Mermaid directives. It accepts a deliberately small,
deterministic subset:

- a required `flowchart` or `graph` header with `TD`/`TB`, `BT`, `LR`, or `RL`
  direction;
- node identifiers beginning with an ASCII letter and containing letters,
  digits, `_`, or `-`;
- rectangle (`A[label]`), rounded (`A(label)`), and diamond (`A{label}`) nodes;
- one `-->` or `---` connection per line, with an optional `|label|`; and
- blank lines and `%%` comment lines.

It does not accept sequence diagrams, class or style directives, initialization
directives, clicks, links, icons, images, HTML labels, subgraphs, scripts,
callbacks, or configuration. Source is limited to 32 KiB and 256 lines; a
diagram is limited to 40 nodes and 80 edges; identifiers, node labels, and edge
labels have smaller lexical bounds. Unsupported or malformed input remains
source rather than being partially executed or interpreted.

The renderer lays out accepted nodes in a bounded deterministic grid, then
creates only trusted SVG `line`, `polygon`, `rect`, and `text` elements.
Provider labels enter text nodes only. The screen-reader alternative names the
direction, nodes, and connections; long visible labels may be ellipsized while
their full values remain in that alternative and the exact-source disclosure.

### SVG tokenizer and allowlist

Provider SVG is never inserted as markup and never passed to `DOMParser`. A
packaged, non-resolving XML tokenizer accepts one complete lowercase `svg` root,
quoted attributes, ordinary text, the five predefined XML entities, numeric
character references, comments, and an optional minimal XML 1.0 or 1.1
declaration. It rejects doctypes, entity declarations, processing instructions,
CDATA, unknown entities, control characters, malformed nesting, duplicate
attributes, and text outside the root.

The accepted element vocabulary is:

`svg`, `g`, `path`, `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon`,
`text`, `tspan`, `title`, and `desc`.

Attributes are selected from a per-element geometry allowlist plus these bounded
presentation properties: solid `fill` and `stroke` colors, opacity, fill rule,
stroke width/cap/join/dasharray, numeric font size/weight, text anchor/baseline,
and numeric transforms. The root requires a positive numeric `viewBox`; provider
width and height do not enter the live element. Path and point data accept only
bounded numeric SVG geometry tokens. Source is limited to 64 KiB, 512 elements,
32 nesting levels, and smaller path/list/transform budgets.

Every unknown element or attribute rejects the whole visual. In particular,
`script`, `style`, `foreignObject`, `a`, `image`, `use`, animation, embedded
content, event attributes, `href`, `xlink:href`, `class`, `id`, and all
URL-valued or `url(...)` surfaces are absent from the allowlist. External and
fragment references therefore cannot survive validation. The accepted pure tree
is reconstructed with `createElementNS`; sanitized attribute names and values
are applied only after allowlist validation. No provider CSS or markup is parsed
into the live DOM.

The accessible name is derived from bounded `title` and `desc` text. When
neither is present, Vantage supplies a trusted description pointing to the
exact-source disclosure.

## Link and resource policy

Provider Markdown, URLs, paths, and labels are untrusted. Issue #18 does not
introduce navigation, file opening, or an external-browser host command.

- Link labels receive link typography, but render as `span` elements without
  `href`, navigation handlers, or host bindings.
- Conventional HTTP, HTTPS, mail, fragment, relative, and absolute-path
  destinations may appear in an inert hover description. They remain
  non-navigable.
- Scriptable, active, control-character, `data:`, `file:`, and other
  unrecognized schemes receive a visible blocked treatment and their destination
  is not exposed as an active attribute.
- Image syntax becomes a literal `Image omitted:` description. No `img`,
  `picture`, `object`, foreign content, or resource URL enters the DOM.

This uniform non-navigation policy prevents both safe-looking and hostile
provider destinations from navigating the WebView or causing a resource fetch. A
future navigation vertical must define an explicit user gesture, destination
validation, host mediation, and containment contract rather than adding active
anchors here.

## DOM and WebView security boundary

The renderer has a fixed output vocabulary: headings, paragraphs, emphasis,
lists, blockquotes, breaks, tables, code and visual containers, trusted
controls, inert spans, and the explicitly allowed SVG geometry above. Provider
strings are assigned only through `textContent`, text nodes, the non-URL `title`
description for recognized inert links, the code-language data label, sanitized
numeric/presentation attributes, and accessible labels assembled by trusted
code.

The renderer never uses:

- `innerHTML`, `outerHTML`, `insertAdjacentHTML`, DOM parsing, or template HTML;
- unvalidated provider-selected tag or attribute names;
- `href`, `src`, `srcset`, CSS values, event-handler attributes, or executable
  URLs;
- scripts, styles, iframes, objects, embeds, forms, remote media, or foreign
  content; or
- network, filesystem, process, terminal, evaluation, or native-command
  authority.

The existing CSP remains unchanged:

`default-src 'none'; script-src 'self'; style-src 'self'; img-src 'none'; connect-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`

There is no CDN or runtime network dependency. The parser and renderer are
packaged with the application.

## Streaming and failure behavior

Incomplete emphasis, links, tables, and other inline structures remain literal
until a matching closing structure is available. A table becomes a table only
when its delimiter row is complete. An incomplete fence remains a readable code
block. Invalid input produces text or a conservative partial structure; it
cannot erase another message or mutate transcript state.

Blockquote recursion stops after 32 presentation levels. Any remaining quote
markers render as literal readable text within the bounded quote tree. This
deterministic budget prevents adversarial nesting from consuming the JavaScript
call stack without truncating or changing the raw response source.

Parsing and rendering are failure-isolated per assistant response. The rich
renderer builds a detached fragment and replaces the current response only after
successful completion. If parsing, DOM construction, or replacement throws, that
response body receives the complete ordered raw source through `textContent` and
a pre-wrapped fallback style. Later deltas retry from the unchanged complete raw
source; no failure can reach, erase, or reorder another transcript entry.

Rendering is synchronous and side-effect-free except for replacing the current
assistant body's children. A renderer defect therefore does not authorize a
native retry or change a terminal outcome. Terminal projection applies its
native label in a `finally` boundary, after attempting the rich snapshot or raw
fallback, so rendering failure cannot suppress completion, interruption, or
failure truth. Terminal labels are still shown only from native `turn_terminal`
events.

## Validation contract

Focused automated checks cover:

- every supported block and inline family;
- reparsing prefixes split inside emphasis, links, tables, inline code, and code
  fences;
- completed, incomplete, malformed, oversized, and adversarial Mermaid/SVG
  fences;
- exact visual-source copying, safe SVG vocabulary, Mermaid text alternatives,
  visual fallback, and transcript-width containment;
- deeply nested blockquotes and synthetic parser/renderer failure;
- raw-source fallback scoped to one response and terminal-label ordering under
  renderer failure;
- exact fenced payload preservation for copying;
- raw HTML, event attributes, resource syntax, and unsafe link schemes;
- absence of HTML-injection and active URL sinks in the packaged renderer; and
- the existing session-controller suite for conversation ordering, follow-up,
  stop, retry, and cleanup behavior.

Packaged acceptance additionally uses real authenticated Codex responses to
inspect representative typography, Mermaid and safe SVG settlement, incomplete
and rejected visual source, inert hostile fixtures, source copying, overflow
containment, truthful terminal states, same-session controls, and Vantage-owned
process cleanup. Harness-only rendering does not satisfy the presentation
criterion.

## Deferred extensions

Remote media, arbitrary HTML, interactive widgets, rich Codex activity, file
actions, editing, diagram interaction, export and persistence, snippet
execution, terminal integration, navigation, model controls, provider
abstraction, and release signing remain outside this design.
