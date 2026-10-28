import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  BrowserWindow,
  screen,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type Rectangle,
} from "electron";
import {
  UpdatesIntentSchema,
  UpdatesDirectSettlementSchema,
  UpdatesProjectionSchema,
  UpdatesSettlementSchema,
  updatesChannels,
  updatesDocumentHash,
  type UpdatesProjection,
  type UpdatesState,
} from "./renderer/updates/contract";

export const UPDATES_PANEL_SIZE = { width: 480, height: 560 } as const;
type Sender = Pick<IpcMainEvent | IpcMainInvokeEvent, "sender" | "senderFrame">;
type Options = {
  owner: BrowserWindow;
  directory: string;
  mode: "default" | "hidden" | "secondary-visible";
  place(): Rectangle;
  admitted(): boolean;
};

/** Native view/relay only. The shell controller retains every command latch.
 * Owner transfer requires a normal close and confirmed settlement of all
 * original renderer commands. A crash, lost reply or unknown stays fenced.
 */
export class DesktopUpdatesPanel {
  private panel: BrowserWindow | null = null;
  private owner: BrowserWindow | null = null;
  private ownerLost = false;
  private options: Options | null = null;
  private projection: UpdatesProjection | null = null;
  private pending: number | null = null;
  private sequence = 0;
  private closeRequested = false;
  private hardOwnerLoss = false;
  private normalOwnerClosed = false;
  private direct = new Map<string, "in-flight" | "returned">();
  private directAmbiguous = false;

  constructor(private readonly hostCanTransfer: () => boolean = () => false) {}

  bindOwner(owner: BrowserWindow, directory: string): void {
    if (this.owner === owner) return;
    if (this.ownerLost) {
      if (
        !this.normalOwnerClosed ||
        this.hardOwnerLoss ||
        this.pending !== null ||
        this.direct.size !== 0 ||
        this.directAmbiguous ||
        !this.projection ||
        this.projection.outcome === "pending" ||
        this.projection.outcome === "unknown" ||
        (this.panel !== null && !this.panel.isDestroyed()) ||
        !this.hostCanTransfer()
      )
        return;
      this.owner = null;
      this.ownerLost = false;
      this.normalOwnerClosed = false;
      this.closeRequested = false;
      this.projection = null;
      this.options = null;
    }
    if (this.owner) {
      this.loseOwner();
      return;
    }
    this.owner = owner;
    this.ownerURL = pathToFileURL(path.join(directory, "shell.html")).href;
    owner.on("close", () => {
      if (this.owner === owner) this.closeRequested = true;
    });
    owner.once("closed", () => {
      if (this.owner !== owner) return;
      this.normalOwnerClosed = this.closeRequested && !this.hardOwnerLoss;
      this.loseOwner();
    });
    owner.webContents.on("render-process-gone", () => {
      if (this.owner !== owner) return;
      this.hardOwnerLoss = true;
      this.loseOwner();
    });
    owner.webContents.once("destroyed", () => {
      if (this.owner !== owner) return;
      if (!this.closeRequested) this.hardOwnerLoss = true;
      this.loseOwner();
    });
    owner.webContents.on(
      "did-start-navigation",
      (_event, _url, _inPlace, mainFrame) => {
        if (this.owner === owner && mainFrame) {
          this.hardOwnerLoss = true;
          this.loseOwner();
        }
      },
    );
  }
  private ownerURL = "";
  private panelURL = "";
  private trusted(
    event: Sender,
    target: BrowserWindow | null,
    url: string,
  ): boolean {
    return (
      !!target &&
      !target.isDestroyed() &&
      !target.webContents.isDestroyed() &&
      event.sender === target.webContents &&
      event.senderFrame === target.webContents.mainFrame &&
      event.senderFrame?.url === url &&
      target.webContents.getURL() === url
    );
  }
  isOwner(event: Sender): boolean {
    return !this.ownerLost && this.trusted(event, this.owner, this.ownerURL);
  }
  isPanel(event: Sender): boolean {
    return this.trusted(event, this.panel, this.panelURL);
  }
  publish(event: Sender, value: unknown): void {
    if (!this.isOwner(event)) return;
    const parsed = UpdatesProjectionSchema.safeParse(value);
    // Malformed projection withdraws authority, without clearing a pending relay.
    this.projection = parsed.success ? parsed.data : null;
    this.broadcast();
  }
  beginDirect(event: Sender, operationId: unknown): void {
    const parsed = UpdatesDirectSettlementSchema.safeParse({
      operationId,
      outcome: "applied",
    });
    if (
      !this.isOwner(event) ||
      !parsed.success ||
      this.direct.has(parsed.data.operationId)
    ) {
      this.directAmbiguous = true;
      return;
    }
    this.direct.set(parsed.data.operationId, "in-flight");
  }
  endDirect(event: Sender, operationId: unknown, returned: boolean): void {
    if (
      typeof operationId !== "string" ||
      this.direct.get(operationId) !== "in-flight" ||
      !returned ||
      !this.isOwner(event)
    ) {
      this.directAmbiguous = true;
      return;
    }
    this.direct.set(operationId, "returned");
  }
  settleDirect(event: Sender, value: unknown): void {
    const parsed = UpdatesDirectSettlementSchema.safeParse(value);
    if (
      !this.isOwner(event) ||
      !parsed.success ||
      this.direct.get(parsed.data.operationId) !== "returned"
    )
      return;
    if (parsed.data.outcome === "unknown") {
      this.directAmbiguous = true;
      return;
    }
    this.direct.delete(parsed.data.operationId);
  }
  settle(event: Sender, value: unknown): void {
    const parsed = UpdatesSettlementSchema.safeParse(value);
    if (
      !this.isOwner(event) ||
      !parsed.success ||
      parsed.data.sequence !== this.pending
    )
      return;
    this.pending = null;
    this.broadcast();
  }
  state(): UpdatesState {
    return !this.ownerLost &&
      this.owner &&
      !this.owner.isDestroyed() &&
      !this.owner.webContents.isDestroyed() &&
      this.owner.webContents.getURL() === this.ownerURL &&
      this.projection
      ? {
          status: "ready",
          projection: this.projection,
          pending: this.pending !== null,
        }
      : { status: "unavailable" };
  }
  relay(event: Sender, value: unknown): void {
    const intent = UpdatesIntentSchema.safeParse(value);
    if (
      !this.isPanel(event) ||
      !intent.success ||
      this.ownerLost ||
      this.pending !== null ||
      !this.options?.admitted() ||
      !this.owner ||
      this.owner.isDestroyed() ||
      !this.isOwner({
        sender: this.owner.webContents,
        senderFrame: this.owner.webContents.mainFrame,
      }) ||
      !this.projection?.allowed[intent.data.kind]
    )
      return;
    if (
      intent.data.kind === "restart-confirmed" &&
      (this.projection.update.phase !== "ready" ||
        this.projection.update.version !== intent.data.version)
    )
      return;
    this.pending = ++this.sequence;
    this.broadcast();
    try {
      this.owner.webContents.send(updatesChannels.command, {
        sequence: this.pending,
        intent: intent.data,
      });
    } catch {
      // Delivery may have happened. Retain pending until this exact owner's ack.
    }
  }
  close(event: Sender): void {
    if (this.isPanel(event)) this.panel?.close();
  }
  async open(options: Options): Promise<void> {
    if (this.ownerLost || this.owner !== options.owner || !options.admitted())
      return;
    this.options = options;
    if (this.panel && !this.panel.isDestroyed()) {
      this.reconcile();
      return;
    }
    this.panelURL = this.ownerURL + updatesDocumentHash;
    const panel = new BrowserWindow({
      ...this.placement(options),
      title: "Farol Updates",
      parent: options.owner,
      modal: false,
      show: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      titleBarStyle: "hiddenInset",
      backgroundColor: "#faf9fc",
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        devTools: false,
        preload: path.join(options.directory, "preload.cjs"),
        additionalArguments: ["--farol-updates"],
      },
    });
    this.panel = panel;
    panel.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    panel.webContents.on("will-navigate", (event) => event.preventDefault());
    panel.webContents.on("will-attach-webview", (event) =>
      event.preventDefault(),
    );
    panel.webContents.on("before-input-event", (event, input) => {
      if (
        input.type === "keyDown" &&
        (input.key === "Escape" ||
          ((input.meta || input.control) && input.key.toLowerCase() === "w"))
      ) {
        event.preventDefault();
        panel.close();
      }
    });
    panel.once("closed", () => {
      if (this.panel === panel) this.panel = null;
    });
    try {
      await panel.loadURL(this.panelURL);
      if (this.panel === panel && !panel.isDestroyed()) this.reconcile();
    } catch (error) {
      if (!panel.isDestroyed()) panel.destroy();
      throw error;
    }
  }
  reconcile(): void {
    if (!this.panel || this.panel.isDestroyed() || !this.options) return;
    if (
      this.ownerLost ||
      !this.options.admitted() ||
      this.options.mode === "hidden"
    ) {
      this.panel.hide();
      return;
    }
    try {
      this.panel.setBounds(this.placement(this.options));
      if (this.options.mode === "secondary-visible") this.panel.showInactive();
      else this.panel.show();
    } catch {
      this.panel.hide();
    }
  }
  private placement(options: Options): Rectangle {
    if (options.mode === "secondary-visible") return options.place();
    const area = screen.getDisplayMatching(options.owner.getBounds()).workArea;
    return {
      x: Math.round(area.x + (area.width - UPDATES_PANEL_SIZE.width) / 2),
      y: Math.round(area.y + (area.height - UPDATES_PANEL_SIZE.height) / 2),
      ...UPDATES_PANEL_SIZE,
    };
  }
  private broadcast(): void {
    if (this.panel && !this.panel.isDestroyed()) {
      try {
        this.panel.webContents.send(updatesChannels.state, this.state());
      } catch {
        /* View delivery cannot settle or repeat an effect. */
      }
    }
  }
  private loseOwner(): void {
    this.ownerLost = true;
    this.broadcast();
    // Do not clear projection or pending, rebind a new shell, or replay a relay.
  }
}
