import type {
  CodexSession,
  CodexSessionFactory,
  NativeSessionIdentity,
  NativeTurnEvent,
} from "./codex_client.ts";
import { asVantageError, VantageError } from "./errors.ts";
import type { EventSink } from "./events.ts";
import { PersistenceOwner, StorageError } from "./persistence.ts";
import type {
  NativeResumeState,
  SessionLossReason,
} from "./persistence_protocol.ts";
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

export interface DurableSessionScope {
  readonly projectId: string;
  readonly conversationId: string;
  readonly nativeThreadId: string | null;
  readonly nativeResumeState: NativeResumeState;
  readonly nextOrdinal: number;
  readonly readOnly: boolean;
}

interface DurableTurn {
  readonly id: string;
  sequence: number;
  accepted: boolean;
}

export type SessionPersistence = Pick<
  PersistenceOwner,
  | "setNativeThread"
  | "beginTurn"
  | "markTurnAccepted"
  | "appendAssistantDelta"
  | "finishTurn"
  | "reconcileAfterSessionLoss"
  | "markNativeNonResumable"
>;

export class SessionController {
  #phase: SessionPhase = "empty";
  #repository: string | null = null;
  #codex: CodexSession | null = null;
  #nativeEvents = Promise.resolve();
  #cleanupBarrier = Promise.resolve();
  #shutdowns = new WeakMap<CodexSession, Promise<void>>();
  #sessionGeneration = 0;
  #persistence: SessionPersistence | null = null;
  #scope: DurableSessionScope | null = null;
  #durableTurn: DurableTurn | null = null;
  #acceptance: Promise<void> | null = null;
  #terminalSettled: PromiseWithResolvers<void> | null = null;

  constructor(
    readonly eventSink: EventSink,
    readonly codexFactory: CodexSessionFactory,
    readonly repositoryValidator: (
      input: unknown,
    ) => Promise<string> = validateRepository,
  ) {}

  attachPersistence(persistence: SessionPersistence): void {
    if (this.#persistence !== null && this.#persistence !== persistence) {
      throw new VantageError(
        "storage_owner",
        "The session controller already has a persistence owner.",
        "Reuse the existing saved-state owner for this application process.",
      );
    }
    this.#persistence = persistence;
  }

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

  hasActiveTurn(): boolean {
    return this.#phase === "turn_starting" ||
      this.#phase === "running" ||
      this.#phase === "interrupting";
  }

  async startSession(
    input: unknown,
    expectedCanonicalRoot?: string,
    scope?: DurableSessionScope,
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
    this.#scope = scope ?? null;
    this.#durableTurn = null;
    this.#acceptance = null;
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
      if (scope?.readOnly) {
        throw new VantageError(
          "conversation_read_only",
          "This saved conversation is read-only and cannot be resumed safely.",
          "Retry an exact native resume when available, or remove the project without changing its repository.",
        );
      }
      codex = this.codexFactory(repository);
      this.#codex = codex;
      const identity = await codex.initialize(
        scope?.nativeThreadId
          ? { nativeThreadId: scope.nativeThreadId }
          : undefined,
      );
      if (!this.#owns(generation, codex)) return this.snapshot();
      await this.#commitNativeIdentity(identity, scope);
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

    const prompt = input;
    const generation = this.#sessionGeneration;
    const codex = this.#codex;
    this.#phase = "turn_starting";
    this.#acceptance = null;

    try {
      if (!this.#scope?.nativeThreadId) {
        const nativeThreadId = await codex.startDurableThread();
        if (!this.#owns(generation, codex)) return this.snapshot();
        if (this.#scope && this.#persistence) {
          await this.#persistence.setNativeThread({
            projectId: this.#scope.projectId,
            conversationId: this.#scope.conversationId,
            nativeThreadId,
          });
          if (!this.#owns(generation, codex)) return this.snapshot();
          this.#scope = {
            ...this.#scope,
            nativeThreadId,
            nativeResumeState: "resumable",
          };
        }
      }
      if (this.#scope && this.#persistence) {
        const turnId = crypto.randomUUID();
        await this.#persistence.beginTurn({
          projectId: this.#scope.projectId,
          conversationId: this.#scope.conversationId,
          turnId,
          ordinal: this.#scope.nextOrdinal,
          prompt,
          createdAt: Date.now(),
        });
        if (!this.#owns(generation, codex)) return this.snapshot();
        this.#durableTurn = { id: turnId, sequence: 0, accepted: false };
        this.#scope = {
          ...this.#scope,
          nextOrdinal: this.#scope.nextOrdinal + 1,
        };
      }
      await this.eventSink({ type: "turn_pending", prompt });
      if (!this.#owns(generation, codex)) return this.snapshot();

      const nativeTurnId = await codex.startTurn(prompt, (event) => {
        this.#nativeEvents = this.#nativeEvents.catch(() => undefined).then(
          () => this.#onTurnEvent(event, generation, codex),
        ).catch((error) =>
          error instanceof StorageError
            ? this.#failDurability(error, generation, codex)
            : this.#failTurn(error, generation, codex).then(() => {})
        );
      });
      if (!this.#owns(generation, codex)) return this.snapshot();
      if (this.#phase === "turn_starting") {
        await this.#acceptTurn(nativeTurnId, generation, codex);
      }
      return this.snapshot();
    } catch (error) {
      if (error instanceof StorageError) {
        await this.#failDurability(error, generation, codex);
        return this.snapshot();
      }
      return await this.#failTurn(error, generation, codex);
    }
  }

  async stopTurn(): Promise<SessionSnapshot> {
    if (
      (this.#phase !== "running" && this.#phase !== "turn_starting") ||
      this.#codex === null
    ) {
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
    let failure: unknown = null;
    try {
      await this.#reconcileCurrent("clean_close");
    } catch (error) {
      failure = error;
    } finally {
      this.#scope = null;
      this.#durableTurn = null;
      this.#acceptance = null;
      this.#resolveTerminalWaiter();
      try {
        await this.#detachCodex();
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
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
    let failure: unknown = null;
    try {
      await this.#reconcileCurrent("clean_close");
    } catch (error) {
      failure = error;
    } finally {
      this.#scope = null;
      this.#durableTurn = null;
      this.#acceptance = null;
      this.#resolveTerminalWaiter();
      try {
        await this.#detachCodex();
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
    if (!this.#isCurrent(generation)) return this.snapshot();
    return this.snapshot();
  }

  async prepareForProjectSwitch(confirmed: boolean): Promise<void> {
    if (!this.hasActiveTurn()) {
      await this.reapSession();
      return;
    }
    if (!confirmed) {
      throw new VantageError(
        "switch_confirmation",
        "Codex is still working in the current project.",
        "Cancel to keep this project active, or confirm to stop it before switching.",
      );
    }

    const settled = this.#waitForTerminal();
    try {
      await this.stopTurn();
    } catch {
      // The conservative reconciliation below owns uncertain stop outcomes.
    }
    await Promise.race([
      settled,
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
    await this.reapSession();
  }

  async #onTurnEvent(
    event: NativeTurnEvent,
    generation: number,
    codex: CodexSession,
  ): Promise<void> {
    if (!this.#owns(generation, codex)) return;
    if (event.type === "accepted") {
      if (
        this.#phase === "turn_starting" ||
        (this.#phase === "interrupting" && !this.#durableTurn?.accepted)
      ) {
        if (!event.nativeTurnId) {
          await this.#failTurn(
            new Error("Codex acceptance omitted the native turn ID"),
            generation,
            codex,
          );
          return;
        }
        await this.#acceptTurn(event.nativeTurnId, generation, codex);
      }
      return;
    }
    if (event.type === "delta" && typeof event.delta === "string") {
      if (this.#phase === "turn_starting") {
        await this.#failTurn(
          new Error("Codex source arrived before durable native acceptance"),
          generation,
          codex,
        );
        return;
      }
      if (this.#phase === "running" || this.#phase === "interrupting") {
        if (this.#scope && this.#durableTurn && this.#persistence) {
          await this.#persistence.appendAssistantDelta({
            projectId: this.#scope.projectId,
            conversationId: this.#scope.conversationId,
            turnId: this.#durableTurn.id,
            sequence: this.#durableTurn.sequence,
            delta: event.delta,
          });
          this.#durableTurn.sequence++;
          if (!this.#owns(generation, codex)) return;
        }
        await this.eventSink({
          type: "assistant_delta",
          delta: event.delta,
        });
        if (!this.#owns(generation, codex)) return;
      }
      return;
    }
    if (event.type === "terminal" && event.status) {
      if (event.nativeTruth === false) {
        await this.#reconcileCurrent("crash");
        this.#phase = "failed";
        this.#durableTurn = null;
        this.#resolveTerminalWaiter();
        await this.eventSink({
          type: "session_failed",
          code: "codex_start",
          message: event.message ??
            "Codex stopped before native terminal truth was received.",
          action: event.action ??
            "Keep the saved turn unresolved and retry the exact native conversation.",
        });
        return;
      } else if (
        this.#scope && this.#durableTurn && this.#persistence &&
        this.#durableTurn.accepted
      ) {
        await this.#persistence.finishTurn({
          projectId: this.#scope.projectId,
          conversationId: this.#scope.conversationId,
          turnId: this.#durableTurn.id,
          status: event.status,
          terminalAt: Date.now(),
        });
        if (!this.#owns(generation, codex)) return;
      } else if (this.#durableTurn) {
        await this.#reconcileCurrent("crash");
      }
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
      this.#durableTurn = null;
      this.#resolveTerminalWaiter();
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
    if (this.#scope && this.#persistence) {
      const resumeFailure = failure.code === "native_missing"
        ? "missing"
        : failure.code === "native_incompatible"
        ? "incompatible"
        : failure.code === "native_resume_failed"
        ? "resume_failed"
        : null;
      if (resumeFailure) {
        await this.#persistence.markNativeNonResumable({
          projectId: this.#scope.projectId,
          conversationId: this.#scope.conversationId,
          failure: resumeFailure,
        });
      }
    }
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
    const cleanup = this.#detachCodex(codex);
    let storageFailure: unknown = null;
    try {
      await this.#reconcileCurrent("crash");
    } catch (storageError) {
      storageFailure = storageError;
    } finally {
      await cleanup.catch((cleanupError) => {
        storageFailure ??= cleanupError;
      });
    }
    if (storageFailure) {
      await this.#projectDurabilityFailure(storageFailure);
      this.#resolveTerminalWaiter();
      return this.snapshot();
    }

    await this.eventSink({
      type: "turn_terminal",
      status: "failed",
      message: failure.message,
      action: failure.action,
      canContinue: false,
    });
    this.#resolveTerminalWaiter();
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

  async #commitNativeIdentity(
    identity: NativeSessionIdentity,
    scope?: DurableSessionScope,
  ): Promise<void> {
    if (!scope || !this.#persistence) return;
    if (identity.threadId === null) {
      if (scope.nativeThreadId !== null) {
        throw new VantageError(
          "native_resume_failed",
          "Codex did not resume the saved native conversation.",
          "Retry the exact native resume without sending a new prompt.",
        );
      }
      return;
    }
    if (
      scope.nativeThreadId !== null &&
      identity.threadId !== scope.nativeThreadId
    ) {
      throw new VantageError(
        "native_incompatible",
        "Codex returned a different native conversation identity.",
        "Keep the transcript read-only and retry only the exact saved native thread.",
      );
    }
    await this.#persistence.setNativeThread({
      projectId: scope.projectId,
      conversationId: scope.conversationId,
      nativeThreadId: identity.threadId,
    });
    this.#scope = {
      ...scope,
      nativeThreadId: identity.threadId,
      nativeResumeState: "resumable",
    };
  }

  async #acceptTurn(
    nativeTurnId: string,
    generation: number,
    codex: CodexSession,
  ): Promise<void> {
    if (this.#phase !== "turn_starting" && this.#phase !== "interrupting") {
      return;
    }
    if (this.#acceptance) {
      await this.#acceptance;
      return;
    }
    const acceptance = (async () => {
      if (
        this.#scope && this.#durableTurn && this.#persistence &&
        !this.#durableTurn.accepted
      ) {
        await this.#persistence.markTurnAccepted({
          projectId: this.#scope.projectId,
          conversationId: this.#scope.conversationId,
          turnId: this.#durableTurn.id,
          nativeTurnId,
          acceptedAt: Date.now(),
        });
        this.#durableTurn.accepted = true;
        if (!this.#owns(generation, codex)) return;
      }
      if (this.#phase !== "interrupting") this.#phase = "running";
      await this.eventSink({ type: "turn_accepted" });
    })();
    this.#acceptance = acceptance;
    try {
      await acceptance;
    } finally {
      if (this.#acceptance === acceptance) this.#acceptance = null;
    }
  }

  async #reconcileCurrent(reason: SessionLossReason): Promise<void> {
    if (!this.#scope || !this.#durableTurn || !this.#persistence) return;
    await this.#persistence.reconcileAfterSessionLoss({
      projectId: this.#scope.projectId,
      conversationId: this.#scope.conversationId,
      reason,
    });
    this.#durableTurn = null;
  }

  async #failDurability(
    error: unknown,
    generation: number,
    codex: CodexSession,
  ): Promise<void> {
    if (!this.#owns(generation, codex)) return;
    this.#sessionGeneration++;
    this.#phase = "failed";
    const cleanup = this.#detachCodex(codex);
    let reconciliationFailure: unknown = null;
    try {
      await this.#reconcileCurrent("crash");
    } catch (failure) {
      reconciliationFailure = failure;
    } finally {
      this.#durableTurn = null;
      this.#acceptance = null;
      this.#resolveTerminalWaiter();
      await cleanup.catch((failure) => {
        reconciliationFailure ??= failure;
      });
    }
    await this.#projectDurabilityFailure(
      reconciliationFailure ?? error,
    );
  }

  async #projectDurabilityFailure(error: unknown): Promise<void> {
    const failure = error instanceof StorageError ? error : new StorageError(
      "storage_write",
      "Vantage could not preserve the saved conversation state.",
      "Preserve the database, stop this session, and retry without replaying the prompt.",
      { cause: error },
    );
    await this.eventSink({
      type: "session_failed",
      code: failure.code,
      message: failure.message,
      action: failure.action,
    });
  }

  #waitForTerminal(): Promise<void> {
    if (!this.hasActiveTurn()) return Promise.resolve();
    this.#terminalSettled ??= Promise.withResolvers<void>();
    return this.#terminalSettled.promise;
  }

  #resolveTerminalWaiter(): void {
    this.#terminalSettled?.resolve();
    this.#terminalSettled = null;
  }
}
