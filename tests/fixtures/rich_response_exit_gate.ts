export const MARKDOWN_ATTACK_FIXTURE = [
  '<script src="https://attacker.invalid/script.js">globalThis.pwned = true</script>',
  '<img src="https://attacker.invalid/pixel" onerror="globalThis.pwned = true">',
  '<iframe src="data:text/html,hostile"></iframe>',
  '<object data="file:///etc/passwd"></object>',
  "[script scheme](javascript:globalThis.pwned=true)",
  "[data scheme](data:text/html,<script>globalThis.pwned=true</script>)",
  "[file scheme](file:///etc/passwd)",
  "[custom scheme](vbscript:msgbox(1))",
  "![remote image](https://attacker.invalid/image.png)",
].join("\n");

export const UNSAFE_LINK_DESTINATIONS = [
  "javascript:alert(1)",
  "JAVASCRIPT:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  "file:///etc/passwd",
  "vbscript:msgbox(1)",
  "\u0000https://attacker.invalid",
] as const;

export const MERMAID_ATTACK_FIXTURES = [
  "flowchart LR\nclick A https://attacker.invalid",
  "flowchart LR\nA --> B\nclick A call globalThis.pwned()",
  "flowchart LR\nA --> B\nstyle A fill:url(https://attacker.invalid/x)",
  "flowchart LR\nA --> B\nlinkStyle 0 stroke:url(https://attacker.invalid/x)",
  "%%{init: {'securityLevel': 'loose'}}%%\nflowchart LR\nA --> B",
  "flowchart LR\nA[<img src=x onerror=alert(1)>]:::hostile",
] as const;

export const SVG_ATTACK_FIXTURES = [
  '<svg viewBox="0 0 10 10"><script>globalThis.pwned=true</script></svg>',
  '<svg viewBox="0 0 10 10"><rect onload="globalThis.pwned=true"/></svg>',
  '<svg viewBox="0 0 10 10"><foreignObject><p>hostile</p></foreignObject></svg>',
  '<svg viewBox="0 0 10 10"><a href="https://attacker.invalid"><text>x</text></a></svg>',
  '<svg viewBox="0 0 10 10"><image href="data:image/svg+xml,hostile"/></svg>',
  '<svg viewBox="0 0 10 10"><use href="#hostile"/></svg>',
  '<svg viewBox="0 0 10 10"><style>@import "https://attacker.invalid/x.css";</style></svg>',
  '<svg viewBox="0 0 10 10"><rect style="fill:url(https://attacker.invalid/x)"/></svg>',
  '<svg viewBox="0 0 10 10"><rect fill="url(https://attacker.invalid/x)"/></svg>',
  '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg viewBox="0 0 10 10"/>',
  '<svg viewBox="0 0 10 10"><text>&#1;</text></svg>',
  '<svg viewBox="0 0 10 10"><text>&#x7f;</text></svg>',
] as const;

export const EXACT_COPY_FIXTURES = [
  {
    name: "code",
    markdown:
      '```javascript\r\nconsole.log("alpha");\r\nconsole.log("omega");\r\n```',
    value: 'console.log("alpha");\r\nconsole.log("omega");\r\n',
    bytes: 46,
    sha256: "a11364d94dff0fce2dcfc6e8285b44b89442f6b31ef5afe22f0f107f2019c992",
  },
  {
    name: "mermaid",
    markdown: "```mermaid\r\nflowchart LR\r\nA[Alpha] --> B[Omega]\r\n```",
    value: "flowchart LR\r\nA[Alpha] --> B[Omega]\r\n",
    bytes: 37,
    sha256: "344ec35bb6f6294d2a9e43aaf9703dda8e5c3fdd43c1f58391853f055210d289",
  },
  {
    name: "svg",
    markdown:
      '```svg\r\n<svg viewBox="0 0 20 20">\r\n<title>Alpha</title><circle cx="10" cy="10" r="8"/>\r\n</svg>\r\n```',
    value:
      '<svg viewBox="0 0 20 20">\r\n<title>Alpha</title><circle cx="10" cy="10" r="8"/>\r\n</svg>\r\n',
    bytes: 88,
    sha256: "0d030b1e37adc21d811214ea08825911884e678b8fe54903dfe2eed3a90268b3",
  },
] as const;
