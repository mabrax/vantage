# Rich response rendering

Status: **Accepted safe Markdown boundary for Milestone 2 issue #18**

The [Milestone 2 map](../milestones/02-rich-markdown.md) owns the vertical-wide outcome and
sequencing. This document owns the trusted source-to-presentation contract for streamed assistant
Markdown and fenced code. It extends the session-only transcript defined by the
[first vertical slice](vertical-slice.md) without changing native conversation behavior.

## Decision

Each assistant response has one ordered raw source string. The UI appends native
`assistant_delta` values to that string exactly once and in arrival order. After each append, it
parses the complete source-so-far into a presentation snapshot and replaces only that response's
rendered children.

The parser produces a small typed block and inline tree. The renderer creates a fixed set of DOM
elements with `document.createElement` and assigns provider text with `textContent` or text nodes.
It never sends provider output through an HTML parser. User prompts continue through their existing
literal `textContent` path and are not parsed as Markdown.

This is a presentation projection only. Native acceptance, delta ordering, completion,
interruption, failure, follow-up, retry, stop, and cleanup remain owned by the existing session
controller and event path.

## Source and projection contract

For every assistant turn:

1. `turn_pending` creates a transcript entry with an empty raw source and an empty rendered body.
2. Each `assistant_delta` is appended to the raw source without normalization, deduplication, or
   interpretation.
3. The complete source-so-far is reparsed into a new detached DOM fragment.
4. The fragment replaces the rendered children of that assistant entry only.
5. `turn_terminal` performs one final render from the same source before showing the native
   terminal state.

The raw source is transcript truth. The parsed tree and DOM are disposable views. Parsing cannot
edit the raw source, emit native commands, change turn state, reach another transcript entry, or
reorder prior content.

Reparsing the bounded response-so-far deliberately favors deterministic snapshots over an
incremental parser with hidden partial state. Chunk boundaries therefore cannot change final
presentation: the same concatenated source always produces the same final tree. An incomplete
construct may change presentation when its closing delimiter arrives, but prior source remains
readable and intact throughout.

## Supported Markdown

The issue #18 parser recognizes:

- ATX headings, paragraphs, emphasis, and strong emphasis;
- unordered and ordered lists, including read-only task-list markers;
- blockquotes and thematic breaks;
- pipe tables with left, center, and right alignment markers;
- inline code;
- backtick and tilde fenced code blocks, with an optional language token; and
- inline links and image syntax under the non-navigation policy below.

Soft source line breaks render as visible line breaks so partial output remains legible. Unsupported
or malformed syntax stays literal text. Raw HTML is never a supported Markdown extension.
Indentation-sensitive nested lists, syntax highlighting, autolinks, arbitrary HTML, media,
Mermaid/SVG presentation, and application-specific rich components are outside this contract.

## Code presentation and copying

A fenced block renders as a trusted `figure` containing:

- a visible supplied language token, or the neutral label `Code`;
- a user-initiated Copy button; and
- a horizontally scrollable `pre`/`code` region that cannot expand the transcript width.

The code element receives only a text node. Copy writes the exact raw fenced payload represented by
the code block, including its original line endings and final newline when one appears before the
closing fence. It does not include fence delimiters or execute, evaluate, open, or send the code.
Clipboard access is attempted only from the Copy click. A browser copy fallback uses a temporary
read-only textarea containing the same value and removes it immediately afterward.

An unclosed fence renders as a visibly streaming code block containing all payload received so far.
Arrival of a valid closing fence settles it to the same result obtained by parsing the complete
source in one operation.

## Link and resource policy

Provider Markdown, URLs, paths, and labels are untrusted. Issue #18 does not introduce navigation,
file opening, or an external-browser host command.

- Link labels receive link typography, but render as `span` elements without `href`, navigation
  handlers, or host bindings.
- Conventional HTTP, HTTPS, mail, fragment, relative, and absolute-path destinations may appear in
  an inert hover description. They remain non-navigable.
- Scriptable, active, control-character, `data:`, `file:`, and other unrecognized schemes receive a
  visible blocked treatment and their destination is not exposed as an active attribute.
- Image syntax becomes a literal `Image omitted:` description. No `img`, `picture`, `object`,
  foreign content, or resource URL enters the DOM.

This uniform non-navigation policy prevents both safe-looking and hostile provider destinations
from navigating the WebView or causing a resource fetch. A future navigation vertical must define
an explicit user gesture, destination validation, host mediation, and containment contract rather
than adding active anchors here.

## DOM and WebView security boundary

The renderer has a fixed output vocabulary: headings, paragraphs, emphasis, lists, blockquotes,
breaks, tables, code containers, trusted controls, and inert spans. Provider strings are assigned
only through `textContent`, text nodes, the non-URL `title` description for recognized inert links,
the code-language data label, and accessible labels assembled by trusted code.

The renderer never uses:

- `innerHTML`, `outerHTML`, `insertAdjacentHTML`, DOM parsing, or template HTML;
- provider-selected tag or attribute names;
- `href`, `src`, `srcset`, CSS values, event-handler attributes, or executable URLs;
- scripts, styles, iframes, objects, embeds, forms, remote media, or foreign content; or
- network, filesystem, process, terminal, evaluation, or native-command authority.

The existing CSP remains unchanged:

`default-src 'none'; script-src 'self'; style-src 'self'; img-src 'none'; connect-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`

There is no CDN or runtime network dependency. The parser and renderer are packaged with the
application.

## Streaming and failure behavior

Incomplete emphasis, links, tables, and other inline structures remain literal until a matching
closing structure is available. A table becomes a table only when its delimiter row is complete.
An incomplete fence remains a readable code block. Invalid input produces text or a conservative
partial structure; it cannot erase another message or mutate transcript state.

Blockquote recursion stops after 32 presentation levels. Any remaining quote markers render as
literal readable text within the bounded quote tree. This deterministic budget prevents adversarial
nesting from consuming the JavaScript call stack without truncating or changing the raw response
source.

Parsing and rendering are failure-isolated per assistant response. The rich renderer builds a
detached fragment and replaces the current response only after successful completion. If parsing,
DOM construction, or replacement throws, that response body receives the complete ordered raw
source through `textContent` and a pre-wrapped fallback style. Later deltas retry from the unchanged
complete raw source; no failure can reach, erase, or reorder another transcript entry.

Rendering is synchronous and side-effect-free except for replacing the current assistant body's
children. A renderer defect therefore does not authorize a native retry or change a terminal
outcome. Terminal projection applies its native label in a `finally` boundary, after attempting the
rich snapshot or raw fallback, so rendering failure cannot suppress completion, interruption, or
failure truth. Terminal labels are still shown only from native `turn_terminal` events.

## Validation contract

Focused automated checks cover:

- every supported block and inline family;
- reparsing prefixes split inside emphasis, links, tables, inline code, and code fences;
- incomplete and malformed input;
- deeply nested blockquotes and synthetic parser/renderer failure;
- raw-source fallback scoped to one response and terminal-label ordering under renderer failure;
- exact fenced payload preservation for copying;
- raw HTML, event attributes, resource syntax, and unsafe link schemes;
- absence of HTML-injection and active URL sinks in the packaged renderer; and
- the existing session-controller suite for conversation ordering, follow-up, stop, retry, and
  cleanup behavior.

Packaged acceptance additionally uses a real authenticated Codex response to inspect representative
typography, streaming settlement, inert hostile fixtures, code overflow and copying, truthful
terminal states, same-session controls, and Vantage-owned process cleanup. Harness-only rendering
does not satisfy the presentation criterion.

## Deferred extensions

Issue #19 may add completed Mermaid and sanitized SVG presentation by extending this source tree
with an explicit completed-fence contract and a safe fallback. It must not create a second
transcript source or weaken this DOM, navigation, resource, CSP, or terminal-state boundary.

Remote media, arbitrary HTML, interactive widgets, rich Codex activity, file actions, editing,
snippet execution, terminal integration, persistence, navigation, model controls, provider
abstraction, and release signing remain outside this design.
