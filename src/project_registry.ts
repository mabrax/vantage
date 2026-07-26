import { VantageError } from "./errors.ts";
import { PersistenceOwner } from "./persistence.ts";
import type {
  ConversationSnapshot,
  NativeResumeFailure,
  NativeResumeState,
  ProjectRegistrySnapshot as StoredRegistrySnapshot,
  RegisteredProjectRecord,
  TurnPhase,
} from "./persistence_protocol.ts";
import { validateRepository } from "./repository.ts";
import { SessionController } from "./session_controller.ts";

export type ProjectAvailability =
  | "available"
  | "missing"
  | "inaccessible"
  | "not_git"
  | "identity_changed";

export interface ProjectView {
  readonly id: string;
  readonly name: string;
  readonly canonicalRoot: string;
  readonly createdAt: number;
  readonly selected: boolean;
  readonly availability: ProjectAvailability;
  readonly unavailableMessage: string | null;
  readonly unavailableAction: string | null;
}

export interface ProjectRegistryView {
  readonly projects: readonly ProjectView[];
  readonly selectedProjectId: string | null;
  readonly conversation: ConversationView | null;
}

export interface ConversationTurnView {
  readonly id: string;
  readonly prompt: string;
  readonly assistantSource: string;
  readonly phase: TurnPhase;
  readonly terminalLabel: string;
  readonly recoveryLabel: string | null;
}

export interface ConversationView {
  readonly projectId: string;
  readonly conversationId: string;
  readonly nativeThreadId: string | null;
  readonly nativeResumeState: NativeResumeState;
  readonly nativeResumeFailure: NativeResumeFailure | null;
  readonly readOnly: boolean;
  readonly composerAvailable: boolean;
  readonly turns: readonly ConversationTurnView[];
}

export interface AvailabilityResult {
  readonly availability: ProjectAvailability;
  readonly message: string | null;
  readonly action: string | null;
}

export type AvailabilityInspector = (
  canonicalRoot: string,
) => Promise<AvailabilityResult>;

const AVAILABLE: AvailabilityResult = {
  availability: "available",
  message: null,
  action: null,
};

export class ProjectRegistryController {
  #stored: StoredRegistrySnapshot = {
    projects: [],
    selectedProjectId: null,
  };
  #view: ProjectRegistryView = {
    projects: [],
    selectedProjectId: null,
    conversation: null,
  };
  #selectedConversation: ConversationSnapshot | null = null;
  #registryBusy = false;
  #closed = false;

  constructor(
    readonly persistence: PersistenceOwner,
    readonly session: SessionController,
    readonly repositoryValidator: (
      input: unknown,
    ) => Promise<string> = validateRepository,
    readonly availabilityInspector: AvailabilityInspector =
      inspectRegisteredRepository,
    readonly createId: () => string = () => crypto.randomUUID(),
    readonly now: () => number = () => Date.now(),
  ) {
    this.session.attachPersistence(persistence);
  }

  async initialize(): Promise<ProjectRegistryView> {
    return await this.#runRegistryMutation(async () => {
      await this.#reload();
      for (const entry of this.#stored.projects) {
        const conversation = await this.persistence.readConversation({
          projectId: entry.project.id,
          conversationId: entry.conversation.id,
        });
        if (
          conversation?.turns.some((turn) =>
            (turn.phase === "pending" ||
              turn.phase === "accepted" ||
              turn.phase === "streaming") &&
            turn.recoveryDisposition === null
          )
        ) {
          await this.persistence.reconcileAfterSessionLoss({
            projectId: entry.project.id,
            conversationId: entry.conversation.id,
            reason: "crash",
          });
        }
      }
      await this.#reload();
      if (
        this.#stored.projects.length > 0 &&
        this.#stored.selectedProjectId === null
      ) {
        const firstProjectId = this.#stored.projects[0].project.id;
        await this.persistence.setSelectedProject(firstProjectId, this.now());
        await this.#reload();
      }
      return this.snapshot();
    });
  }

  snapshot(): ProjectRegistryView {
    return {
      projects: this.#view.projects.map((project) => ({ ...project })),
      selectedProjectId: this.#view.selectedProjectId,
      conversation: this.#view.conversation
        ? {
          ...this.#view.conversation,
          turns: this.#view.conversation.turns.map((turn) => ({ ...turn })),
        }
        : null,
    };
  }

  async activateSelectedProject(): Promise<ProjectRegistryView> {
    return await this.#runRegistryMutation(async () => {
      await this.#reload();
      const selected = this.#selectedView();
      if (!selected) {
        await this.session.clearSession();
        return this.snapshot();
      }
      if (selected.availability !== "available") {
        await this.session.clearSession();
        return this.snapshot();
      }
      await this.#startSelectedSession();
      await this.#reload();
      return this.snapshot();
    });
  }

  async addProject(input: unknown): Promise<ProjectRegistryView> {
    return await this.#runRegistryMutation(async () => {
      this.#assertSessionReplaceable();
      const canonicalRoot = await this.repositoryValidator(input);
      const duplicate = this.#stored.projects.find((entry) =>
        entry.project.canonicalRoot === canonicalRoot
      );
      if (duplicate) {
        throw new VantageError(
          "project_duplicate",
          "That Git repository is already saved.",
          `Select the existing project at ${canonicalRoot}.`,
        );
      }

      await this.session.clearSession();
      const createdAt = Math.max(
        this.now(),
        ...this.#stored.projects.map((entry) => entry.project.createdAt + 1),
      );
      const projectId = this.createId();
      const conversationId = this.createId();
      await this.persistence.createProjectWithConversation({
        projectId,
        conversationId,
        canonicalRoot,
        createdAt,
      });
      await this.persistence.setSelectedProject(projectId, createdAt);
      await this.#reload();
      await this.#startSelectedSession();
      await this.#reload();
      return this.snapshot();
    });
  }

  async selectProject(
    projectId: unknown,
    confirmedActiveSwitch = false,
  ): Promise<ProjectRegistryView> {
    return await this.#runRegistryMutation(async () => {
      const project = this.#requireProject(projectId);
      if (project.project.id === this.#stored.selectedProjectId) {
        return this.snapshot();
      }

      if (this.session.hasActiveTurn()) {
        await this.session.prepareForProjectSwitch(confirmedActiveSwitch);
      } else {
        this.#assertSessionReplaceable();
        await this.session.clearSession();
      }
      await this.persistence.setSelectedProject(
        project.project.id,
        this.now(),
      );
      await this.#reload();
      const selected = this.#selectedView();
      if (selected?.availability === "available") {
        await this.#startSelectedSession();
        await this.#reload();
      } else {
        await this.session.clearSession();
      }
      return this.snapshot();
    });
  }

  async refreshProjects(): Promise<ProjectRegistryView> {
    return await this.#runRegistryMutation(async () => {
      await this.#reload();
      const selected = this.#selectedView();
      if (
        selected?.availability !== "available" &&
        this.session.hasSessionOwnership()
      ) {
        await this.session.reapSession();
      }
      return this.snapshot();
    });
  }

  async removeProject(
    projectId: unknown,
    confirmed: unknown,
  ): Promise<ProjectRegistryView> {
    return await this.#runRegistryMutation(async () => {
      if (confirmed !== true) {
        throw new VantageError(
          "removal_confirmation",
          "Project removal requires explicit confirmation.",
          "Confirm removal in Vantage or cancel without changing saved state.",
        );
      }
      const project = this.#requireProject(projectId);
      const isSelected = project.project.id === this.#stored.selectedProjectId;
      if (isSelected) {
        if (this.session.hasActiveTurn()) {
          await this.session.prepareForProjectSwitch(true);
        } else {
          await this.session.reapSession();
        }
      }

      const remaining = this.#stored.projects.filter((entry) =>
        entry.project.id !== project.project.id
      );
      const nextSelectedProjectId = isSelected
        ? remaining[0]?.project.id ?? null
        : this.#stored.selectedProjectId;
      await this.persistence.removeProject(
        project.project.id,
        nextSelectedProjectId,
        this.now(),
      );
      await this.#reload();

      if (isSelected) {
        const selected = this.#selectedView();
        if (selected?.availability === "available") {
          await this.#startSelectedSession();
          await this.#reload();
        }
      }
      return this.snapshot();
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    let failure: unknown = null;
    try {
      await this.session.close();
    } catch (error) {
      failure = error;
    } finally {
      try {
        await this.persistence.close();
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
  }

  async #reload(): Promise<void> {
    this.#stored = await this.persistence.readProjectRegistry();
    const selectedStored = this.#stored.projects.find((entry) =>
      entry.project.id === this.#stored.selectedProjectId
    );
    this.#selectedConversation = selectedStored
      ? await this.persistence.readConversation({
        projectId: selectedStored.project.id,
        conversationId: selectedStored.conversation.id,
      })
      : null;
    const availability = await Promise.all(
      this.#stored.projects.map((entry) =>
        this.availabilityInspector(entry.project.canonicalRoot)
      ),
    );
    this.#view = {
      projects: this.#stored.projects.map((entry, index) =>
        projectView(
          entry,
          entry.project.id === this.#stored.selectedProjectId,
          availability[index],
        )
      ),
      selectedProjectId: this.#stored.selectedProjectId,
      conversation: this.#selectedConversation
        ? conversationView(this.#selectedConversation)
        : null,
    };
  }

  #selectedView(): ProjectView | null {
    return this.#view.projects.find((project) => project.selected) ?? null;
  }

  #requireProject(projectId: unknown): RegisteredProjectRecord {
    if (typeof projectId !== "string" || projectId.length === 0) {
      throw new VantageError(
        "invalid_command",
        "Choose a saved project.",
        "Reload the project list and try again.",
      );
    }
    const project = this.#stored.projects.find((entry) =>
      entry.project.id === projectId
    );
    if (!project) {
      throw new VantageError(
        "project_missing",
        "That saved project no longer exists.",
        "Reload the project list before trying the command again.",
      );
    }
    return project;
  }

  #assertSessionReplaceable(): void {
    if (!this.session.canReplaceSession()) {
      throw new VantageError(
        "invalid_command",
        "Projects can be changed only while Codex is idle.",
        "Wait for the current turn to finish or stop it before changing projects.",
      );
    }
  }

  async #startSelectedSession(): Promise<void> {
    const selected = this.#selectedView();
    const stored = this.#stored.projects.find((entry) =>
      entry.project.id === this.#stored.selectedProjectId
    );
    if (!selected || !stored || !this.#selectedConversation) return;
    const readOnly = this.#selectedConversation.turns.some((turn) =>
      turn.recoveryDisposition !== null
    );
    if (readOnly) {
      await this.session.clearSession();
      return;
    }
    await this.session.startSession(
      selected.canonicalRoot,
      selected.canonicalRoot,
      {
        projectId: stored.project.id,
        conversationId: stored.conversation.id,
        nativeThreadId: stored.conversation.nativeThreadId,
        nativeResumeState: stored.conversation.nativeResumeState,
        nextOrdinal: this.#selectedConversation.turns.length,
        readOnly,
      },
    );
  }

  async #runRegistryMutation<T>(operation: () => Promise<T>): Promise<T> {
    this.#assertOpen();
    if (this.#registryBusy) {
      throw new VantageError(
        "invalid_command",
        "Another saved-project change is already in progress.",
        "Wait for the current project operation to finish.",
      );
    }
    this.#registryBusy = true;
    try {
      return await operation();
    } finally {
      this.#registryBusy = false;
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new VantageError(
        "closed",
        "The saved project registry is closed.",
        "Reopen Vantage before changing projects.",
      );
    }
  }
}

function conversationView(
  snapshot: ConversationSnapshot,
): ConversationView {
  const recovered = snapshot.turns.some((turn) =>
    turn.recoveryDisposition !== null
  );
  const readOnly = recovered ||
    snapshot.conversation.nativeResumeState === "non_resumable";
  return {
    projectId: snapshot.project.id,
    conversationId: snapshot.conversation.id,
    nativeThreadId: snapshot.conversation.nativeThreadId,
    nativeResumeState: snapshot.conversation.nativeResumeState,
    nativeResumeFailure: snapshot.conversation.nativeResumeFailure,
    readOnly,
    composerAvailable: !readOnly,
    turns: snapshot.turns.map((turn) => ({
      id: turn.id,
      prompt: turn.prompt,
      assistantSource: turn.assistantSource,
      phase: turn.phase,
      terminalLabel: terminalLabel(turn.phase),
      recoveryLabel: recoveryLabel(turn.recoveryDisposition),
    })),
  };
}

function terminalLabel(phase: TurnPhase): string {
  if (phase === "completed") return "Completed";
  if (phase === "interrupted") return "Interrupted";
  if (phase === "failed") return "Failed";
  return "Unresolved";
}

function recoveryLabel(
  disposition: ConversationSnapshot["turns"][number]["recoveryDisposition"],
): string | null {
  if (disposition === "uncertain_acceptance") {
    return "Prompt acceptance is uncertain. It was not replayed.";
  }
  if (disposition === "incomplete_accepted") {
    return "Codex accepted this turn, but no terminal outcome was proven.";
  }
  if (disposition === "incomplete_stream") {
    return "This response is incomplete. Saved source is shown exactly.";
  }
  return null;
}

export async function inspectRegisteredRepository(
  canonicalRoot: string,
): Promise<AvailabilityResult> {
  let resolved: string;
  try {
    resolved = await Deno.realPath(canonicalRoot);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return unavailable(
        "missing",
        "The saved repository is missing or has moved.",
        "Restore it at the exact saved path, or remove and re-add the project.",
      );
    }
    return unavailable(
      "inaccessible",
      "The saved repository is not accessible.",
      "Restore local read access, then check the project again.",
    );
  }
  if (resolved !== canonicalRoot) {
    return unavailable(
      "identity_changed",
      "The saved path now resolves to a different location.",
      "Restore the original canonical path, or remove and explicitly re-add the new location.",
    );
  }

  try {
    if (!(await Deno.stat(canonicalRoot)).isDirectory) {
      return unavailable(
        "missing",
        "The saved repository path is no longer a directory.",
        "Restore the Git repository at this path, or remove the saved project.",
      );
    }
  } catch {
    return unavailable(
      "inaccessible",
      "The saved repository is not accessible.",
      "Restore local read access, then check the project again.",
    );
  }

  try {
    const result = await new Deno.Command("git", {
      args: ["-C", canonicalRoot, "rev-parse", "--show-toplevel"],
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    }).output();
    const root = new TextDecoder().decode(result.stdout).trim();
    if (!result.success || root.length === 0) {
      return unavailable(
        "not_git",
        "The saved path is no longer a Git repository.",
        "Restore its Git metadata, or remove the saved project.",
      );
    }
    const canonicalGitRoot = await Deno.realPath(root);
    if (canonicalGitRoot !== canonicalRoot) {
      return unavailable(
        "identity_changed",
        "The saved path now belongs to a different Git root.",
        "Restore the original repository, or remove and explicitly add the new Git root.",
      );
    }
  } catch {
    return unavailable(
      "inaccessible",
      "Git could not inspect the saved repository.",
      "Restore access to Git and this path, then check the project again.",
    );
  }
  return AVAILABLE;
}

function projectView(
  entry: RegisteredProjectRecord,
  selected: boolean,
  availability: AvailabilityResult,
): ProjectView {
  const segments = entry.project.canonicalRoot.split("/").filter(Boolean);
  return {
    id: entry.project.id,
    name: segments.at(-1) ?? entry.project.canonicalRoot,
    canonicalRoot: entry.project.canonicalRoot,
    createdAt: entry.project.createdAt,
    selected,
    availability: availability.availability,
    unavailableMessage: availability.message,
    unavailableAction: availability.action,
  };
}

function unavailable(
  availability: Exclude<ProjectAvailability, "available">,
  message: string,
  action: string,
): AvailabilityResult {
  return { availability, message, action };
}
