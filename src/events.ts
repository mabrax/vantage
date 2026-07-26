export type TurnTerminalStatus = "completed" | "interrupted" | "failed";

export type SessionEvent =
  | {
    readonly type: "repository_ready";
    readonly repository: string;
  }
  | {
    readonly type: "turn_pending";
    readonly prompt: string;
  }
  | {
    readonly type: "turn_accepted";
  }
  | {
    readonly type: "turn_interrupting";
  }
  | {
    readonly type: "assistant_delta";
    readonly delta: string;
  }
  | {
    readonly type: "turn_terminal";
    readonly status: TurnTerminalStatus;
    readonly message?: string;
    readonly action?: string;
    readonly canContinue: boolean;
  }
  | {
    readonly type: "turn_unresolved";
    readonly recoveryLabel: string;
    readonly action: string;
  }
  | {
    readonly type: "session_failed";
    readonly code: string;
    readonly message: string;
    readonly action: string;
    readonly canRetry?: boolean;
  };

export type EventSink = (event: SessionEvent) => void | Promise<void>;
