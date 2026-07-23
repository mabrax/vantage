import { type TransportError, transportError } from "./diagnostics.ts";

export type DarwinProcessRecord = {
  pid: number;
  parentPid: number;
  processGroupId: number;
  auditSessionId: number;
  state: string;
  command: string;
};

export type OwnedProcessIdentity = {
  rootPid: number;
  processGroupId: number;
  sessionId: number;
};

export type LineageEvent = {
  kind: "snapshot-observed";
  pid: number;
  parentPid: number;
  processGroupId: number;
  auditSessionId: number;
};

export type ContainmentCapabilityEvidence = {
  facility: "snapshot-only";
  available: boolean;
  armedBeforeChildExecution: boolean;
  continuouslyTracked: boolean;
  creationEventsCovered: boolean;
  sessionEscapeCovered: boolean;
  reparentingCovered: boolean;
  lossDetected: boolean;
  overflowed: boolean;
  unavailableReason: string;
};

export type ContainmentBlockerCode =
  | "TRACKER_UNAVAILABLE"
  | "TRACKER_LOST"
  | "TRACKER_OVERFLOWED"
  | "CONTAINMENT_UNPROVEN";

export type ProcessTreeObservation = {
  root: DarwinProcessRecord | undefined;
  descendants: DarwinProcessRecord[];
  groupMembers: DarwinProcessRecord[];
  observedPids: number[];
  remainingPids: number[];
  lineageEvents: LineageEvent[];
  noObservedDescendantsRemain: boolean;
  capability: ContainmentCapabilityEvidence;
  escapedDescendantContainmentProven: false;
};

export type ProcessSnapshotProvider = () => Promise<DarwinProcessRecord[]>;

const TRACKER_UNAVAILABLE_REASON =
  "Deno on macOS exposes no pre-exec, lossless process-lineage facility; " +
  "process-table snapshots and process-group signals cannot account for an " +
  "immediate setsid/reparent escape";

export const SNAPSHOT_ONLY_CAPABILITY: ContainmentCapabilityEvidence = Object
  .freeze({
    facility: "snapshot-only",
    available: false,
    armedBeforeChildExecution: false,
    continuouslyTracked: false,
    creationEventsCovered: false,
    sessionEscapeCovered: false,
    reparentingCovered: false,
    lossDetected: false,
    overflowed: false,
    unavailableReason: TRACKER_UNAVAILABLE_REASON,
  });

export function containmentBlockerCode(
  capability: ContainmentCapabilityEvidence,
): ContainmentBlockerCode {
  if (!capability.available) return "TRACKER_UNAVAILABLE";
  if (capability.lossDetected) return "TRACKER_LOST";
  if (capability.overflowed) return "TRACKER_OVERFLOWED";
  if (
    !capability.armedBeforeChildExecution ||
    !capability.continuouslyTracked ||
    !capability.creationEventsCovered ||
    !capability.sessionEscapeCovered ||
    !capability.reparentingCovered
  ) {
    return "CONTAINMENT_UNPROVEN";
  }
  // No proof-producing implementation exists in this environment, so even a
  // structurally complete claim remains unproven until final tracked-PID
  // termination is accounted for by a real facility.
  return "CONTAINMENT_UNPROVEN";
}

export function requireDarwinArm64(
  platform = { os: Deno.build.os, arch: Deno.build.arch },
): void {
  if (platform.os !== "darwin" || platform.arch !== "aarch64") {
    throw transportError({
      code: "PLATFORM_UNSUPPORTED",
      stage: "shutdown.platform",
      expected: { os: "darwin", arch: "aarch64" },
      observed: platform,
      nextAction:
        "run this shutdown proof only on the manifest-selected darwin/aarch64 target",
    });
  }
}

export async function readDarwinProcessSnapshot(): Promise<
  DarwinProcessRecord[]
> {
  requireDarwinArm64();
  const output = await new Deno.Command("/bin/ps", {
    args: ["-axo", "pid=,ppid=,pgid=,sess=,stat=,comm="],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    throw transportError({
      code: "STREAM_FAILED",
      stage: "shutdown.snapshot",
      observed: { exitCode: output.code },
      stderr: new TextDecoder().decode(output.stderr),
      nextAction: "restore scoped access to /bin/ps and retry shutdown",
    });
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(output.stdout);
  return text.split("\n").flatMap((line) => {
    const match = line.match(
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/,
    );
    if (!match) return [];
    return [{
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      processGroupId: Number(match[3]),
      // Darwin ps(1) `sess` is the audit session identifier, not getsid(2).
      // POSIX session leadership is instead verified from the lowercase `s`
      // state flag together with pgid === pid.
      auditSessionId: Number(match[4]),
      state: match[5],
      command: match[6],
    }];
  });
}

export async function captureOwnedProcessIdentity(
  rootPid: number,
  snapshotProvider: ProcessSnapshotProvider = readDarwinProcessSnapshot,
): Promise<OwnedProcessIdentity> {
  requirePositivePid(rootPid, "rootPid");
  const root = (await snapshotProvider()).find((process) =>
    process.pid === rootPid
  );
  if (
    !root ||
    root.processGroupId !== rootPid ||
    !isSessionLeader(root)
  ) {
    throw unsafeGroupError("shutdown.identity.capture", {
      rootPid,
      observed: root,
    });
  }
  return {
    rootPid,
    processGroupId: root.processGroupId,
    sessionId: rootPid,
  };
}

export async function verifyOwnedProcessGroup(
  identity: OwnedProcessIdentity,
  snapshotProvider: ProcessSnapshotProvider = readDarwinProcessSnapshot,
): Promise<DarwinProcessRecord> {
  validateIdentity(identity);
  const root = (await snapshotProvider()).find((process) =>
    process.pid === identity.rootPid
  );
  if (
    !root ||
    root.pid !== identity.rootPid ||
    root.processGroupId !== identity.processGroupId ||
    root.processGroupId !== root.pid ||
    !isSessionLeader(root)
  ) {
    throw unsafeGroupError("shutdown.signal.verify", {
      identity,
      observed: root,
    });
  }
  return root;
}

export async function signalVerifiedProcessGroup(
  identity: OwnedProcessIdentity,
  signal: Deno.Signal,
  snapshotProvider: ProcessSnapshotProvider = readDarwinProcessSnapshot,
  kill?: (
    pid: number,
    signal: Deno.Signal,
  ) => void | Promise<void>,
): Promise<void> {
  await verifyOwnedProcessGroup(identity, snapshotProvider);
  // The negative target is used only after the immediately preceding positive
  // root/session/group re-read matched every owned identity component.
  if (kill) {
    await kill(-identity.processGroupId, signal);
    return;
  }
  const output = await new Deno.Command("/bin/kill", {
    args: [
      `-${signal.replace(/^SIG/, "")}`,
      "--",
      String(-identity.processGroupId),
    ],
    stdin: "null",
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!output.success) {
    throw transportError({
      code: "CLOSE_FAILED",
      stage: "shutdown.signal.deliver",
      expected: { identity, signal },
      observed: { exitCode: output.code },
      stderr: new TextDecoder().decode(output.stderr),
      nextAction:
        "inspect the verified group and retain the compatibility blocker",
    });
  }
}

export class DarwinSnapshotProcessTree {
  readonly capability = SNAPSHOT_ONLY_CAPABILITY;
  readonly lineageEvents: LineageEvent[] = [];
  readonly observedPids = new Set<number>();
  #lastSnapshot: DarwinProcessRecord[] = [];

  constructor(
    readonly identity: OwnedProcessIdentity,
    private readonly snapshotProvider: ProcessSnapshotProvider =
      readDarwinProcessSnapshot,
  ) {
    validateIdentity(identity);
    this.observedPids.add(identity.rootPid);
  }

  async observe(): Promise<ProcessTreeObservation> {
    const snapshot = await this.snapshotProvider();
    this.#lastSnapshot = snapshot;
    const byPid = new Map(snapshot.map((process) => [process.pid, process]));
    const descendants = transitiveDescendants(
      snapshot,
      this.identity.rootPid,
    );
    const groupMembers = snapshot.filter((process) =>
      process.processGroupId === this.identity.processGroupId
    );
    for (const process of [...descendants, ...groupMembers]) {
      if (process.pid === this.identity.rootPid) continue;
      if (!this.observedPids.has(process.pid)) {
        this.lineageEvents.push({
          kind: "snapshot-observed",
          pid: process.pid,
          parentPid: process.parentPid,
          processGroupId: process.processGroupId,
          auditSessionId: process.auditSessionId,
        });
      }
      this.observedPids.add(process.pid);
    }
    const remainingPids = [...this.observedPids]
      .filter((pid) => pid !== this.identity.rootPid && byPid.has(pid))
      .sort((left, right) => left - right);
    const root = byPid.get(this.identity.rootPid);
    if (root) remainingPids.unshift(root.pid);
    return {
      root,
      descendants,
      groupMembers,
      observedPids: [...this.observedPids].sort((left, right) => left - right),
      remainingPids: [...new Set(remainingPids)],
      lineageEvents: this.lineageEvents.map((event) => ({ ...event })),
      noObservedDescendantsRemain: remainingPids.length === 0,
      capability: this.capability,
      escapedDescendantContainmentProven: false,
    };
  }

  async signalGroup(signal: Deno.Signal): Promise<void> {
    await signalVerifiedProcessGroup(
      this.identity,
      signal,
      this.snapshotProvider,
    );
  }

  get lastSnapshot(): readonly DarwinProcessRecord[] {
    return this.#lastSnapshot;
  }
}

function isSessionLeader(process: DarwinProcessRecord): boolean {
  return process.state.includes("s");
}

function transitiveDescendants(
  snapshot: readonly DarwinProcessRecord[],
  rootPid: number,
): DarwinProcessRecord[] {
  const descendants: DarwinProcessRecord[] = [];
  const ancestorPids = new Set([rootPid]);
  let added = true;
  while (added) {
    added = false;
    for (const process of snapshot) {
      if (
        process.pid !== rootPid &&
        ancestorPids.has(process.parentPid) &&
        !ancestorPids.has(process.pid)
      ) {
        ancestorPids.add(process.pid);
        descendants.push(process);
        added = true;
      }
    }
  }
  return descendants;
}

function requirePositivePid(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

function validateIdentity(identity: OwnedProcessIdentity): void {
  requirePositivePid(identity.rootPid, "rootPid");
  requirePositivePid(identity.processGroupId, "processGroupId");
  requirePositivePid(identity.sessionId, "sessionId");
  if (
    identity.rootPid !== identity.processGroupId ||
    identity.rootPid !== identity.sessionId
  ) {
    throw unsafeGroupError("shutdown.identity.validate", { identity });
  }
}

function unsafeGroupError(
  stage: string,
  observed: Record<string, unknown>,
): TransportError {
  return transportError({
    code: "UNSAFE_PROCESS_GROUP",
    stage,
    expected:
      "a live positive root PID matching its owned process group and session",
    observed,
    nextAction:
      "do not send a negative-PID signal; retain the compatibility blocker and inspect the remaining processes",
  });
}
