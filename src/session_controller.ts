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
  | "interrupting"
  | "completed"
  | "interrupted"
  | "turn_failed"
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
  #nativeEvents = Promise.resolve();
  #sessionGeneration = 0;

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

  canReplaceSession(): boolean {
    return this.#phase !== "starting" &&
      this.#phase !== "turn_starting" &&
      this.#phase !== "running" &&
      this.#phase !== "interrupting" &&
      this.#phase !== "closed";
  }

  async startSession(
    input: unknown,
    expectedCanonicalRoot?: string,
  ): Promise<SessionSnapshot> {
    if (
      this.#phase === "starting" ||
      this.#phase === "turn_starting" ||
      this.#phase === "running" ||
      this.#phase === "interrupting" ||
      this.#phase === "closed"
    ) {
      throw new VantageError(
        "invalid_command",
        "The session cannot be replaced right now.",
        "Wait for the current operation to finish.",
      );
    }

    const generation = ++this.#sessionGeneration;
    await this.#disposeCodex();
    this.#phase = "starting";
    this.#repository = null;

    try {
      const repository = await this.repositoryValidator(input);
      if (
        expectedCanonicalRoot !== undefined &&
        repository !== expectedCanonicalRoot
      ) {
        throw new VantageError(
          "repository",
          "The saved path now resolves to a different Git repository.",
          "Restore the original canonical root, or remove and explicitly re-add the new project.",
        );
      }
      const codex = this.codexFactory(repository);
      this.#codex = codex;
      await codex.initialize();
      if (generation !== this.#sessionGeneration) return this.snapshot();
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
    if (!this.#canSubmitPrompt() || this.#codex === null) {
      throw new VantageError(
        "invalid_command",
        "This session cannot accept a prompt right now.",
        this.#phase === "turn_starting" ||
          this.#phase === "running" ||
          this.#phase === "interrupting"
          ? "Wait for the current turn to finish."
          : "Retry the repository session.",
      );
    }

    const prompt = input.trim();
    this.#phase = "turn_starting";
    await this.eventSink({ type: "turn_pending", prompt });

    try {
      const generation = this.#sessionGeneration;
      await this.#codex.startTurn(prompt, (event) => {
        this.#nativeEvents = this.#nativeEvents.then(() =>
          this.#onTurnEvent(event, generation)
        );
      });
      if (this.#isClosed()) return this.snapshot();
      if (this.#phase === "turn_starting") {
        this.#phase = "running";
        await this.eventSink({ type: "turn_accepted" });
      }
      return this.snapshot();
    } catch (error) {
      if (this.#isClosed()) return this.snapshot();
      const failure = asVantageError(error);
      this.#phase = "failed";
      await this.#disposeCodex();
      await this.eventSink({
        type: "turn_terminal",
        status: "failed",
        message: failure.message,
        action: failure.action,
        canContinue: false,
      });
      return this.snapshot();
    }
  }

  async stopTurn(): Promise<SessionSnapshot> {
    if (this.#phase !== "running" || this.#codex === null) {
      throw new VantageError(
        "invalid_command",
        "There is no active Codex response to stop.",
        this.#phase === "interrupting"
          ? "Wait for Codex to report the terminal state."
          : "Start a prompt before using Stop.",
      );
    }

    this.#phase = "interrupting";
    await this.eventSink({ type: "turn_interrupting" });

    try {
      await this.#codex.interruptTurn();
    } catch (error) {
      await this.#nativeEvents;
      if (this.#phase !== "interrupting") {
        return this.snapshot();
      }
      const failure = asVantageError(error);
      this.#phase = "failed";
      await this.#disposeCodex();
      await this.eventSink({
        type: "turn_terminal",
        status: "failed",
        message: failure.message,
        action: failure.action,
        canContinue: false,
      });
    }
    return this.snapshot();
  }

  async close(): Promise<void> {
    if (this.#phase === "closed") return;
    this.#sessionGeneration++;
    this.#phase = "closed";
    await this.#disposeCodex();
  }

  async clearSession(): Promise<SessionSnapshot> {
    if (!this.canReplaceSession()) {
      throw new VantageError(
        "invalid_command",
        "The active project cannot be cleared right now.",
        "Wait for the current operation to finish.",
      );
    }
    return await this.reapSession();
  }

  async reapSession(): Promise<SessionSnapshot> {
    if (this.#phase === "closed") {
      throw new VantageError(
        "closed",
        "The active project session is closed.",
        "Reopen Vantage before starting another project.",
      );
    }
    this.#sessionGeneration++;
    await this.#disposeCodex();
    this.#repository = null;
    this.#phase = "empty";
    return this.snapshot();
  }

  async #onTurnEvent(
    event: NativeTurnEvent,
    generation: number,
  ): Promise<void> {
    if (this.#phase === "closed" || generation !== this.#sessionGeneration) {
      return;
    }
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
      const canContinue = event.canContinue !== false && this.#codex !== null;
      this.#phase = canContinue
        ? event.status === "completed"
          ? "completed"
          : event.status === "interrupted"
          ? "interrupted"
          : "turn_failed"
        : "failed";
      await this.eventSink({
        type: "turn_terminal",
        status: event.status,
        message: event.message,
        action: event.action,
        canContinue,
      });
    }
  }

  #canSubmitPrompt(): boolean {
    return this.#phase === "ready" ||
      this.#phase === "completed" ||
      this.#phase === "interrupted" ||
      this.#phase === "turn_failed";
  }

  #isClosed(): boolean {
    return this.#phase === "closed";
  }

  async #disposeCodex(): Promise<void> {
    const codex = this.#codex;
    this.#codex = null;
    if (codex) await codex.shutdown();
  }
}
