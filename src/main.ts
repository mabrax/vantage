import { createCodexSession } from "./codex_client.ts";
import type { SessionEvent } from "./events.ts";
import { SessionController } from "./session_controller.ts";
import { CSS, HTML, JAVASCRIPT } from "./ui.ts";

interface DesktopCloseEvent extends Event {
  preventDefault(): void;
}

interface DesktopWindow {
  bind(
    name: string,
    handler: (...args: unknown[]) => unknown | Promise<unknown>,
  ): void;
  addEventListener(
    type: "close",
    listener: (event: DesktopCloseEvent) => void,
  ): void;
  close(): void;
  executeJs(source: string): Promise<unknown>;
  isClosed(): boolean;
}

interface DesktopRuntime {
  BrowserWindow: new (options: {
    title: string;
    width: number;
    height: number;
  }) => DesktopWindow;
}

const securityHeaders = {
  "cache-control": "no-store",
  "cross-origin-opener-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

Deno.serve((request) => {
  if (request.method !== "GET") {
    return new Response("Method not allowed", {
      status: 405,
      headers: securityHeaders,
    });
  }
  const path = new URL(request.url).pathname;
  if (path === "/") return asset(HTML, "text/html; charset=utf-8");
  if (path === "/styles.css") return asset(CSS, "text/css; charset=utf-8");
  if (path === "/app.js") {
    return asset(JAVASCRIPT, "text/javascript; charset=utf-8");
  }
  return new Response("Not found", { status: 404, headers: securityHeaders });
});

const desktop = Deno as typeof Deno & DesktopRuntime;
const window = new desktop.BrowserWindow({
  title: "Vantage",
  width: 980,
  height: 820,
});

let eventQueue = Promise.resolve();
const sendEvent = (event: SessionEvent): Promise<void> => {
  eventQueue = eventQueue.then(async () => {
    if (window.isClosed()) return;
    const serialized = JSON.stringify(event)
      .replaceAll("\u2028", "\\u2028")
      .replaceAll("\u2029", "\\u2029");
    await window.executeJs(`globalThis.vantageReceiveEvent?.(${serialized})`);
  }).catch(() => {
    // A closing or reloading webview may reject an in-flight projection.
  });
  return eventQueue;
};

const controller = new SessionController(sendEvent, createCodexSession);

window.bind("startSession", async (path: unknown) => {
  await controller.startSession(path);
  return null;
});
window.bind("submitPrompt", async (prompt: unknown) => {
  await controller.submitPrompt(prompt);
  return null;
});

let closing = false;
window.addEventListener("close", (event) => {
  if (closing) return;
  event.preventDefault();
  closing = true;
  void (async () => {
    await controller.close();
    window.close();
  })();
});

function asset(body: string, contentType: string): Response {
  return new Response(body, {
    headers: {
      ...securityHeaders,
      "content-type": contentType,
    },
  });
}
