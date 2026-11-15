export type DesktopWork =
  "chatgpt-task" | "connector-task" | "codex-host-task" | "workspace-mutation";

export type DesktopReservation = Readonly<{ release(): void }>;
export type ConnectorPurpose = "manual-diagnostic" | null;

export type DesktopPendingWork = Readonly<{
  chatGptReadonlyTask(): boolean;
  directChatStart(): boolean;
  chatGptAttachmentTask(): boolean;
  workspaceEdit(): boolean;
  computer(): boolean;
  codexAgent(): boolean;
  hostCheck(): boolean;
  connectorStart(): boolean;
}>;

export class DesktopAdmission {
  private quitting = false;
  private update: DesktopReservation | null = null;
  private requests = 0;
  private readonly work = new Map<DesktopWork, DesktopReservation>();
  private purpose: ConnectorPurpose = null;

  constructor(private readonly pending: DesktopPendingWork) {}

  closed(): boolean {
    return this.quitting || this.update !== null;
  }

  beginQuit(): void {
    this.quitting = true;
  }

  get quitInProgress(): boolean {
    return this.quitting;
  }

  get installedUpdateAdmission(): boolean {
    return this.update !== null;
  }

  get configurationRequests(): number {
    return this.requests;
  }

  get connectorTaskAdmissionPurpose(): ConnectorPurpose {
    return this.purpose;
  }

  occupied(kind: DesktopWork): boolean {
    return this.work.has(kind);
  }

  // Existing caller admission owns cross-kind policy and authority. This local
  // reservation neither grants authority nor reopens a closed desktop.
  acquire(
    kind: DesktopWork,
    purpose: ConnectorPurpose = null,
  ): DesktopReservation | null {
    if (this.closed() || this.work.has(kind)) return null;
    return this.reserveAdmitted(kind, purpose);
  }

  // The caller has already selected its operation-specific admission/refusal
  // order. In particular combined Setup reserves dispatch before its existing
  // closed-desktop check. Holding dispatch grants no effect authority.
  reserveAdmitted(
    kind: DesktopWork,
    purpose: ConnectorPurpose = null,
  ): DesktopReservation {
    if (this.work.has(kind)) throw new Error("DESKTOP_WORK_ALREADY_RESERVED");
    const reservation = {
      release: () => {
        if (this.work.get(kind) !== reservation) return;
        this.work.delete(kind);
        if (kind === "connector-task") this.purpose = null;
      },
    };
    this.work.set(kind, reservation);
    if (kind === "connector-task") this.purpose = purpose;
    return reservation;
  }

  // Normal-Quit update preparation may enter while Quit is latched, but only
  // after its existing owner has checked the original preparation context.
  enterUpdate(): DesktopReservation | null {
    if (this.update !== null) return null;
    const reservation = {
      release: () => {
        if (this.update === reservation) this.update = null;
      },
    };
    this.update = reservation;
    return reservation;
  }

  async withConfigurationRequest<T>(request: () => Promise<T>): Promise<T> {
    this.requests += 1;
    try {
      return await request();
    } finally {
      this.requests -= 1;
    }
  }

  updateBlocker(
    admissionCurrent: boolean,
  ): "UPDATE_WORK_PENDING" | "UPDATE_CONNECTOR_ACTIVE" | null {
    if (
      this.update !== null ||
      !admissionCurrent ||
      this.requests > 0 ||
      this.occupied("chatgpt-task") ||
      this.pending.chatGptReadonlyTask() ||
      this.pending.directChatStart() ||
      this.pending.chatGptAttachmentTask() ||
      this.pending.workspaceEdit() ||
      this.occupied("workspace-mutation") ||
      this.pending.computer() ||
      this.occupied("codex-host-task") ||
      this.pending.codexAgent() ||
      this.pending.hostCheck()
    )
      return "UPDATE_WORK_PENDING";
    if (this.occupied("connector-task") || this.pending.connectorStart())
      return "UPDATE_CONNECTOR_ACTIVE";
    return null;
  }
}
