import { VantageError } from "./errors.ts";
import { PersistenceOwner } from "./persistence.ts";
import type {
  ProjectRegistrySnapshot as StoredRegistrySnapshot,
  RegisteredProjectRecord,
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
  };
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
  ) {}

  async initialize(): Promise<ProjectRegistryView> {
    this.#assertOpen();
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
  }

  snapshot(): ProjectRegistryView {
    return {
      projects: this.#view.projects.map((project) => ({ ...project })),
      selectedProjectId: this.#view.selectedProjectId,
    };
  }

  async activateSelectedProject(): Promise<ProjectRegistryView> {
    this.#assertOpen();
    const selected = this.#selectedView();
    if (!selected) {
      await this.session.clearSession();
      return this.snapshot();
    }
    if (selected.availability !== "available") {
      await this.session.clearSession();
      return this.snapshot();
    }
    await this.session.startSession(
      selected.canonicalRoot,
      selected.canonicalRoot,
    );
    return this.snapshot();
  }

  async addProject(input: unknown): Promise<ProjectRegistryView> {
    this.#assertOpen();
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
    await this.session.startSession(canonicalRoot, canonicalRoot);
    return this.snapshot();
  }

  async selectProject(projectId: unknown): Promise<ProjectRegistryView> {
    this.#assertOpen();
    this.#assertSessionReplaceable();
    const project = this.#requireProject(projectId);
    if (project.project.id === this.#stored.selectedProjectId) {
      return this.snapshot();
    }

    await this.session.clearSession();
    await this.persistence.setSelectedProject(project.project.id, this.now());
    await this.#reload();
    const selected = this.#selectedView();
    if (selected?.availability === "available") {
      await this.session.startSession(
        selected.canonicalRoot,
        selected.canonicalRoot,
      );
    } else {
      await this.session.clearSession();
    }
    return this.snapshot();
  }

  async refreshProjects(): Promise<ProjectRegistryView> {
    this.#assertOpen();
    await this.#reload();
    const selected = this.#selectedView();
    if (
      selected?.availability !== "available" &&
      this.session.snapshot().repository !== null
    ) {
      await this.session.reapSession();
    }
    return this.snapshot();
  }

  async removeProject(
    projectId: unknown,
    confirmed: unknown,
  ): Promise<ProjectRegistryView> {
    this.#assertOpen();
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
      await this.session.reapSession();
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
        await this.session.startSession(
          selected.canonicalRoot,
          selected.canonicalRoot,
        );
      }
    }
    return this.snapshot();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.session.close();
    await this.persistence.close();
  }

  async #reload(): Promise<void> {
    this.#stored = await this.persistence.readProjectRegistry();
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
