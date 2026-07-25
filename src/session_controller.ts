import type {
  CodexSession,
  CodexSessionFactory,
  NativeTurnEvent,
} from "./codex_client.ts";
import { asVantageError, VantageError } from "./errors.ts";
import type { EventSink } from "./events.ts";
import { validateRepository } from "./repository.ts";

export type SessionPhase =
  | "empty"
  | "starting"
  | "ready"
  | "turn_starting"
  | "running"
  | "completed"
  | "failed"
  | "closed";

export interface SessionSnapshot {
  readonly phase: SessionPhase;
  readonly repository: string | null;
}

export class SessionController {
  #phase: SessionPhase = "empty";
  #repository: string | null = null;
  #codex: CodexSession | null = null;
  #promptUsed = false;

  constructor(
    readonly eventSink: EventSink,
    readonly codexFactory: CodexSessionFactory,
    readonly repositoryValidator: (
      input: unknown,
    ) => Promise<string> = validateRepository,
  ) {}

  snapshot(): SessionSnapshot {
    return { phase: this.#phase, repository: this.#repository };
  }

  async startSession(input: unknown): Promise<SessionSnapshot> {
    if (
      this.#phase === "starting" ||
      this.#phase === "turn_starting" ||
      this.#phase === "running" ||
      this.#phase === "closed"
    ) {
      throw new VantageError(
        "invalid_command",
        "The session cannot be replaced right now.",
        "Wait for the current operation to finish.",
      );
    }

    await this.#disposeCodex();
    this.#phase = "starting";
    this.#repository = null;
    this.#promptUsed = false;

    try {
      const repository = await this.repositoryValidator(input);
      const codex = this.codexFactory(repository);
      this.#codex = codex;
      await codex.initialize();
      this.#repository = repository;
      this.#phase = "ready";
      await this.eventSink({ type: "repository_ready", repository });
      return this.snapshot();
    } catch (error) {
      await this.#disposeCodex();
      this.#phase = "failed";
      const failure = asVantageError(error);
      await this.eventSink({
        type: "session_failed",
        code: failure.code,
        message: failure.message,
        action: failure.action,
      });
      return this.snapshot();
    }
  }

  async submitPrompt(input: unknown): Promise<SessionSnapshot> {
    if (typeof input !== "string" || input.trim().length === 0) {
      throw new VantageError(
        "invalid_command",
        "Enter a question for Codex.",
        "Type a prompt and try again.",
      );
    }
    if (input.length > 32_000) {
      throw new VantageError(
        "invalid_command",
        "That prompt is too long for this Vantage slice.",
        "Shorten the prompt and try again.",
      );
    }
    if (this.#phase !== "ready" || this.#codex === null || this.#promptUsed) {
      throw new VantageError(
        "invalid_command",
        "This session cannot accept another prompt.",
        this.#phase === "turn_starting" || this.#phase === "running"
          ? "Wait for the current turn to finish."
          : "Start a new app session to ask another question.",
      );
    }

    const prompt = input.trim();
    this.#promptUsed = true;
    this.#phase = "turn_starting";
    await this.eventSink({ type: "turn_pending", prompt });

    try {
      await this.#codex.startTurn(prompt, (event) => {
        void this.#onTurnEvent(event);
      });
      if (this.#phase === "turn_starting") {
        this.#phase = "running";
        await this.eventSink({ type: "turn_accepted" });
      }
      return this.snapshot();
    } catch (error) {
      const failure = asVantageError(error);
      this.#phase = "failed";
      await this.eventSink({
        type: "turn_terminal",
        status: "failed",
        message: failure.message,
        action: failure.action,
      });
      return this.snapshot();
    }
  }

  async close(): Promise<void> {
    if (this.#phase === "closed") return;
    this.#phase = "closed";
    await this.#disposeCodex();
  }

  async #onTurnEvent(event: NativeTurnEvent): Promise<void> {
    if (this.#phase === "closed") return;
    if (event.type === "accepted") {
      if (this.#phase === "turn_starting") {
        this.#phase = "running";
        await this.eventSink({ type: "turn_accepted" });
      }
      return;
    }
    if (event.type === "delta" && typeof event.delta === "string") {
      if (this.#phase === "turn_starting") {
        this.#phase = "running";
        await this.eventSink({ type: "turn_accepted" });
      }
      if (this.#phase === "running") {
        await this.eventSink({
          type: "assistant_delta",
          delta: event.delta,
        });
      }
      return;
    }
    if (event.type === "terminal" && event.status) {
      this.#phase = event.status === "completed" ? "completed" : "failed";
      await this.eventSink({
        type: "turn_terminal",
        status: event.status,
        message: event.message,
        action: event.action,
      });
    }
  }

  async #disposeCodex(): Promise<void> {
    const codex = this.#codex;
    this.#codex = null;
    if (codex) await codex.shutdown();
  }
}
