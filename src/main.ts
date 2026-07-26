import { createCodexSession } from "./codex_client.ts";
import { asVantageError, VantageError } from "./errors.ts";
import type { SessionEvent } from "./events.ts";
import { PersistenceOwner, StorageError } from "./persistence.ts";
import {
  ProjectRegistryController,
  type ProjectRegistryView,
} from "./project_registry.ts";
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
let registry: ProjectRegistryController | null = null;

window.bind("initializeApp", async () => {
  try {
    if (registry === null) {
      const databasePath = await applicationDatabasePath();
      const persistence = await PersistenceOwner.open(databasePath);
      const candidate = new ProjectRegistryController(persistence, controller);
      try {
        await candidate.initialize();
        registry = candidate;
      } catch (error) {
        await persistence.close().catch(() => undefined);
        throw error;
      }
    }
    return success(registry.snapshot());
  } catch (error) {
    return failure(error);
  }
});
window.bind("activateSelectedProject", async () => {
  return await registryCommand((savedProjects) =>
    savedProjects.activateSelectedProject()
  );
});
window.bind("addProject", async (path: unknown) => {
  return await registryCommand((savedProjects) =>
    savedProjects.addProject(path)
  );
});
window.bind("selectProject", async (
  projectId: unknown,
  confirmedActiveSwitch: unknown,
) => {
  return await registryCommand((savedProjects) =>
    savedProjects.selectProject(projectId, confirmedActiveSwitch === true)
  );
});
window.bind("refreshProjects", async () => {
  return await registryCommand((savedProjects) =>
    savedProjects.refreshProjects()
  );
});
window.bind("removeProject", async (
  projectId: unknown,
  confirmed: unknown,
) => {
  return await registryCommand((savedProjects) =>
    savedProjects.removeProject(projectId, confirmed)
  );
});
window.bind("submitPrompt", async (prompt: unknown) => {
  await controller.submitPrompt(prompt);
  return null;
});
window.bind("stopTurn", async () => {
  await controller.stopTurn();
  return null;
});

let closing = false;
window.addEventListener("close", (event) => {
  if (closing) return;
  event.preventDefault();
  closing = true;
  void (async () => {
    try {
      if (registry) {
        await registry.close();
      } else {
        await controller.close();
      }
    } finally {
      window.close();
    }
  })();
});

interface HostSuccess {
  readonly ok: true;
  readonly snapshot: ProjectRegistryView;
}

interface HostFailure {
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly action: string;
  };
}

async function registryCommand(
  command: (
    savedProjects: ProjectRegistryController,
  ) => Promise<ProjectRegistryView>,
): Promise<HostSuccess | HostFailure> {
  if (!registry) {
    return failure(
      new VantageError(
        "invalid_command",
        "Saved projects are not ready.",
        "Reload Vantage and retry after local storage opens.",
      ),
    );
  }
  try {
    return success(await command(registry));
  } catch (error) {
    return failure(error);
  }
}

function success(snapshot: ProjectRegistryView): HostSuccess {
  return { ok: true, snapshot };
}

function failure(error: unknown): HostFailure {
  if (error instanceof StorageError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        action: error.action,
      },
    };
  }
  const result = asVantageError(error);
  return {
    ok: false,
    error: {
      code: result.code,
      message: result.message,
      action: result.action,
    },
  };
}

async function applicationDatabasePath(): Promise<string> {
  const override = Deno.env.get("VANTAGE_DATABASE_PATH");
  if (override) return override;
  const home = Deno.env.get("HOME");
  if (!home) {
    throw new StorageError(
      "storage_open",
      "Vantage could not locate the per-user application-support directory.",
      "Restore the HOME environment value and reopen Vantage.",
    );
  }
  const directory = `${home}/Library/Application Support/Vantage`;
  try {
    await Deno.mkdir(directory, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new StorageError(
      "storage_open",
      "Vantage could not create its application-support directory.",
      "Restore write access to your Library/Application Support directory and retry.",
      { cause: error },
    );
  }
  return `${directory}/vantage.sqlite3`;
}

function asset(body: string, contentType: string): Response {
  return new Response(body, {
    headers: {
      ...securityHeaders,
      "content-type": contentType,
    },
  });
}
