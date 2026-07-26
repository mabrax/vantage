export const LATEST_SCHEMA_VERSION = 2;

export type TurnPhase =
  | "pending"
  | "accepted"
  | "streaming"
  | "completed"
  | "interrupted"
  | "failed";

export type TerminalStatus = "completed" | "interrupted" | "failed";

export type RecoveryDisposition =
  | "uncertain_acceptance"
  | "incomplete_accepted"
  | "incomplete_stream";

export type SessionLossReason = "clean_close" | "crash";

export type NativeResumeState =
  | "unstarted"
  | "resumable"
  | "non_resumable";

export type NativeResumeFailure =
  | "missing"
  | "incompatible"
  | "resume_failed";

export interface ProjectRecord {
  readonly id: string;
  readonly canonicalRoot: string;
  readonly createdAt: number;
}

export interface ConversationRecord {
  readonly id: string;
  readonly projectId: string;
  readonly nativeThreadId: string | null;
  readonly nativeResumeState: NativeResumeState;
  readonly nativeResumeFailure: NativeResumeFailure | null;
  readonly createdAt: number;
}

export interface TurnRecord {
  readonly id: string;
  readonly conversationId: string;
  readonly ordinal: number;
  readonly prompt: string;
  readonly phase: TurnPhase;
  readonly nativeTurnId: string | null;
  readonly assistantSource: string;
  readonly deltaCount: number;
  readonly terminalStatus: TerminalStatus | null;
  readonly recoveryDisposition: RecoveryDisposition | null;
  readonly sessionLossReason: SessionLossReason | null;
  readonly createdAt: number;
  readonly acceptedAt: number | null;
  readonly terminalAt: number | null;
}

export interface ConversationSnapshot {
  readonly project: ProjectRecord;
  readonly conversation: ConversationRecord;
  readonly turns: readonly TurnRecord[];
}

export interface CreateProjectInput {
  readonly projectId: string;
  readonly conversationId: string;
  readonly canonicalRoot: string;
  readonly createdAt: number;
}

export interface ScopedConversationInput {
  readonly projectId: string;
  readonly conversationId: string;
}

export interface SetNativeThreadInput extends ScopedConversationInput {
  readonly nativeThreadId: string;
}

export interface MarkNativeNonResumableInput extends ScopedConversationInput {
  readonly failure: NativeResumeFailure;
}

export interface BeginTurnInput extends ScopedConversationInput {
  readonly turnId: string;
  readonly ordinal: number;
  readonly prompt: string;
  readonly createdAt: number;
}

export interface ScopedTurnInput extends ScopedConversationInput {
  readonly turnId: string;
}

export interface MarkTurnAcceptedInput extends ScopedTurnInput {
  readonly nativeTurnId: string;
  readonly acceptedAt: number;
}

export interface AppendAssistantDeltaInput extends ScopedTurnInput {
  readonly sequence: number;
  readonly delta: string;
}

export interface FinishTurnInput extends ScopedTurnInput {
  readonly status: TerminalStatus;
  readonly terminalAt: number;
}

export interface ReconcileInput extends ScopedConversationInput {
  readonly reason: SessionLossReason;
}

export type PersistenceOperation =
  | { readonly type: "open"; readonly path: string }
  | { readonly type: "create_project"; readonly input: CreateProjectInput }
  | { readonly type: "remove_project"; readonly projectId: string }
  | { readonly type: "set_native_thread"; readonly input: SetNativeThreadInput }
  | {
    readonly type: "mark_native_non_resumable";
    readonly input: MarkNativeNonResumableInput;
  }
  | { readonly type: "begin_turn"; readonly input: BeginTurnInput }
  | {
    readonly type: "mark_turn_accepted";
    readonly input: MarkTurnAcceptedInput;
  }
  | {
    readonly type: "append_assistant_delta";
    readonly input: AppendAssistantDeltaInput;
  }
  | { readonly type: "finish_turn"; readonly input: FinishTurnInput }
  | { readonly type: "reconcile"; readonly input: ReconcileInput }
  | {
    readonly type: "read_conversation";
    readonly input: ScopedConversationInput;
  }
  | { readonly type: "close" };

export interface PersistenceRequest {
  readonly id: number;
  readonly operation: PersistenceOperation;
}

export interface SerializedStorageError {
  readonly code: string;
  readonly message: string;
  readonly action: string;
}

export type PersistenceResponse =
  | {
    readonly id: number;
    readonly ok: true;
    readonly value?: unknown;
  }
  | {
    readonly id: number;
    readonly ok: false;
    readonly error: SerializedStorageError;
  };
