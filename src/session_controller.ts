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
  #cleanupBarrier = Promise.resolve();
  #shutdowns = new WeakMap<CodexSession, Promise<void>>();
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

  hasSessionOwnership(): boolean {
    return this.#codex !== null ||
      (this.#phase !== "empty" && this.#phase !== "closed");
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
    this.#phase = "starting";
    this.#repository = null;
    const cleanup = this.#detachCodex();
    let codex: CodexSession | null = null;

    try {
      await cleanup;
      if (!this.#owns(generation, null)) return this.snapshot();

      const repository = await this.repositoryValidator(input);
      if (!this.#owns(generation, null)) return this.snapshot();
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
      codex = this.codexFactory(repository);
      this.#codex = codex;
      await codex.initialize();
      if (!this.#owns(generation, codex)) return this.snapshot();
      this.#repository = repository;
      this.#phase = "ready";
      await this.eventSink({ type: "repository_ready", repository });
      if (!this.#owns(generation, codex)) return this.snapshot();
      return this.snapshot();
    } catch (error) {
      return await this.#failSessionStart(error, generation, codex);
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
    const generation = this.#sessionGeneration;
    const codex = this.#codex;
    this.#phase = "turn_starting";

    try {
      await this.eventSink({ type: "turn_pending", prompt });
      if (!this.#owns(generation, codex)) return this.snapshot();

      await codex.startTurn(prompt, (event) => {
        this.#nativeEvents = this.#nativeEvents.catch(() => undefined).then(
          () => this.#onTurnEvent(event, generation, codex),
        );
      });
      if (!this.#owns(generation, codex)) return this.snapshot();
      if (this.#phase === "turn_starting") {
        this.#phase = "running";
        await this.eventSink({ type: "turn_accepted" });
        if (!this.#owns(generation, codex)) return this.snapshot();
      }
      return this.snapshot();
    } catch (error) {
      return await this.#failTurn(error, generation, codex);
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

    const generation = this.#sessionGeneration;
    const codex = this.#codex;
    this.#phase = "interrupting";

    try {
      await this.eventSink({ type: "turn_interrupting" });
      if (!this.#owns(generation, codex)) return this.snapshot();
      await codex.interruptTurn();
      if (!this.#owns(generation, codex)) return this.snapshot();
    } catch (error) {
      await this.#nativeEvents;
      if (!this.#owns(generation, codex)) return this.snapshot();
      if (this.#phase !== "interrupting") {
        return this.snapshot();
      }
      return await this.#failTurn(error, generation, codex);
    }
    return this.snapshot();
  }

  async close(): Promise<void> {
    if (this.#phase === "closed") return;
    this.#sessionGeneration++;
    this.#phase = "closed";
    this.#repository = null;
    await this.#detachCodex();
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
    const generation = ++this.#sessionGeneration;
    this.#repository = null;
    this.#phase = "empty";
    await this.#detachCodex();
    if (!this.#isCurrent(generation)) return this.snapshot();
    return this.snapshot();
  }

  async #onTurnEvent(
    event: NativeTurnEvent,
    generation: number,
    codex: CodexSession,
  ): Promise<void> {
    if (!this.#owns(generation, codex)) return;
    if (event.type === "accepted") {
      if (this.#phase === "turn_starting") {
        this.#phase = "running";
        await this.eventSink({ type: "turn_accepted" });
        if (!this.#owns(generation, codex)) return;
      }
      return;
    }
    if (event.type === "delta" && typeof event.delta === "string") {
      if (this.#phase === "turn_starting") {
        this.#phase = "running";
        await this.eventSink({ type: "turn_accepted" });
        if (!this.#owns(generation, codex)) return;
      }
      if (this.#phase === "running") {
        await this.eventSink({
          type: "assistant_delta",
          delta: event.delta,
        });
        if (!this.#owns(generation, codex)) return;
      }
      return;
    }
    if (event.type === "terminal" && event.status) {
      const canContinue = event.canContinue !== false;
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
      if (!this.#owns(generation, codex)) return;
    }
  }

  async #failSessionStart(
    error: unknown,
    generation: number,
    codex: CodexSession | null,
  ): Promise<SessionSnapshot> {
    if (!this.#owns(generation, codex)) return this.snapshot();
    this.#phase = "failed";
    this.#repository = null;
    try {
      await this.#detachCodex(codex);
    } catch (cleanupError) {
      if (!this.#isCurrent(generation)) return this.snapshot();
      throw cleanupError;
    }
    if (!this.#isCurrent(generation)) return this.snapshot();

    const failure = asVantageError(error);
    await this.eventSink({
      type: "session_failed",
      code: failure.code,
      message: failure.message,
      action: failure.action,
    });
    if (!this.#isCurrent(generation)) return this.snapshot();
    return this.snapshot();
  }

  async #failTurn(
    error: unknown,
    generation: number,
    codex: CodexSession,
  ): Promise<SessionSnapshot> {
    if (!this.#owns(generation, codex)) return this.snapshot();
    const failure = asVantageError(error);
    this.#phase = "failed";
    try {
      await this.#detachCodex(codex);
    } catch (cleanupError) {
      if (!this.#isCurrent(generation)) return this.snapshot();
      throw cleanupError;
    }
    if (!this.#isCurrent(generation)) return this.snapshot();

    await this.eventSink({
      type: "turn_terminal",
      status: "failed",
      message: failure.message,
      action: failure.action,
      canContinue: false,
    });
    if (!this.#isCurrent(generation)) return this.snapshot();
    return this.snapshot();
  }

  #canSubmitPrompt(): boolean {
    return this.#phase === "ready" ||
      this.#phase === "completed" ||
      this.#phase === "interrupted" ||
      this.#phase === "turn_failed";
  }

  #owns(generation: number, codex: CodexSession | null): boolean {
    return this.#isCurrent(generation) && this.#codex === codex;
  }

  #isCurrent(generation: number): boolean {
    return generation === this.#sessionGeneration &&
      this.#phase !== "closed";
  }

  #detachCodex(expected?: CodexSession | null): Promise<void> {
    if (expected !== undefined && this.#codex !== expected) {
      return this.#cleanupBarrier;
    }
    const codex = this.#codex;
    this.#codex = null;
    if (codex === null) return this.#cleanupBarrier;

    let shutdown = this.#shutdowns.get(codex);
    if (!shutdown) {
      shutdown = Promise.resolve().then(() => codex.shutdown());
      this.#shutdowns.set(codex, shutdown);
    }
    const previousCleanup = this.#cleanupBarrier.catch(() => undefined);
    this.#cleanupBarrier = Promise.all([previousCleanup, shutdown]).then(
      () => undefined,
    );
    return this.#cleanupBarrier;
  }
}
