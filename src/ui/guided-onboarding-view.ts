import type {
  ProductConfigurationCommand,
  ProductSettings,
} from "../pkg/product-settings/contract";
import {
  externalConnectorChallengeAllowed,
  onboardingCompletedSteps,
  onboardingFacts,
  onboardingProgress,
  onboardingSteps,
} from "./guided-onboarding";
import {
  completedStepAction,
  connectionDraftChanged,
  firstIncompleteSetupStep,
  freshAppCheckNeedsRepair,
  GuidedConnectionUpdate,
  GuidedCredentialSave,
  GuidedFreshAppVerification,
  onboardingActionPrerequisite,
  onboardingPrerequisite,
  progressWithConnectionDraft,
  refreshApprovedFolderAccess,
} from "./guided-onboarding-actions";
import { folderAccessChecked, folderDisplayName } from "./folder-access-state";

export interface GuidedOnboardingPort {
  readonly mode: "embedded" | "external";
  readonly verificationCard: () => HTMLElement | null;
  readonly settings: () => ProductSettings | null;
  readonly buildId: () => string;
  readonly isActive: () => boolean;
  readonly configure: (
    command: ProductConfigurationCommand,
    message: string,
  ) => Promise<boolean>;
  readonly chooseFolder: () => Promise<string | null>;
  readonly pickFolder: (selectionId: string) => Promise<string | null>;
  readonly openSettings: () => void;
  readonly openDiagnostics: () => void;
  readonly render: () => void;
  readonly openChat: () => void;
  readonly returnToChat: () => void;
}
function element<T extends HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`ONBOARDING_ELEMENT_MISSING:${selector}`);
  return node;
}
const failureMessages = {
  busy: "Another connection change is already running.",
  prerequisite:
    "Check ChatGPT sign-in, saved folder access, and the current Connection before using local access.",
  "invalid-fields":
    "Enter a valid tunnel ID and runtime API key, not an admin key. The connection was not stopped.",
  "new-key-required":
    "Paste the runtime API key for this tunnel, or choose Keep saved credentials.",
  "inspect-existing-operation":
    "Check the previous result before trying again. Nothing is sent again automatically.",
  "state-changed":
    "The folder or connection changed during this action. Review the current settings before continuing.",
  "command-failed":
    "This action stopped. Check the message below; no step was retried.",
  "runtime-not-ready":
    "The tunnel has not reported ready. Check the message below before reconnecting.",
} as const;
type FolderAction = Readonly<{
  kind: "add" | "remove";
  ids: readonly string[];
  authority: string;
  connectionIdentity: string;
}>;

// Only navigation, unsubmitted input and last failed UI checks are transient.
// Folder evidence lives in the existing settings snapshot; no UI state grants
// access or substitutes for the exact backend connection receipt.
export class GuidedOnboardingView {
  private step = 4;
  private busy = false;
  private busyLabel = "Checking…";
  private tunnelEdited = false;
  private credentialsEditing: boolean | null = null;
  private signInOpened = false;
  private pendingFolder: FolderAction | null = null;
  private confirmNewCheck = false;
  private message = "";
  private feedbackStep: number | null = null;
  private readonly failedChecks = new Set<number>();
  private readonly backgroundFolderChecks = new Map<string, Promise<boolean>>();
  private backgroundFolderCheckTail: Promise<boolean> = Promise.resolve(true);
  private readonly connection = new GuidedConnectionUpdate();
  private readonly credentials = new GuidedCredentialSave();
  private readonly freshAppVerification = new GuidedFreshAppVerification();

  constructor(private readonly port: GuidedOnboardingPort) {
    element<HTMLFormElement>("#onboarding-form").addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        void this.act();
      },
    );
    this.click("#onboarding-back", () =>
      this.select(this.step === 0 ? 4 : this.step - 1),
    );
    this.click("#onboarding-return", () => port.returnToChat());
    this.click("#onboarding-add-folder", () =>
      this.requestFolderAction("add", []),
    );
    this.click("#onboarding-confirm-folder", () => {
      const pending = this.pendingFolder;
      this.pendingFolder = null;
      if (pending) void this.updateFolders(pending);
    });
    this.click("#onboarding-cancel-folder", () => {
      this.pendingFolder = null;
      this.message = "";
      port.render();
    });
    this.click("#onboarding-replace-credentials", () => {
      this.credentialsEditing = true;
      this.resetDraft();
      port.render();
      element<HTMLInputElement>("#onboarding-tunnel-id").focus();
    });
    this.click("#onboarding-keep-credentials", () => {
      this.credentialsEditing = false;
      this.resetDraft();
      port.render();
    });
    this.click("#onboarding-recheck", () => {
      void this.recheck();
    });
    this.click("#onboarding-reconnect", () => {
      void this.applyConnection(true);
    });
    this.click("#onboarding-open-account", () => {
      void this.openVerificationChat();
    });
    this.click("#onboarding-open-chatgpt", () => {
      void this.openVerificationChat();
    });
    this.click("#onboarding-verify-again", () => {
      this.confirmNewCheck = true;
      port.render();
    });
    this.click("#onboarding-cancel-new-check", () => {
      this.confirmNewCheck = false;
      port.render();
    });
    this.click("#onboarding-confirm-new-check", () => {
      this.confirmNewCheck = false;
      void this.verifyApp(true);
    });
    this.click("#onboarding-check-result", () => {
      void this.checkAttachment();
    });
    this.click("#onboarding-stop", () => {
      void this.stopConnection();
    });
    this.click("#onboarding-diagnostics", () => port.openDiagnostics());
    this.click("#onboarding-copy-tunnel", () => {
      void this.perform("Copying tunnel ID…", async () => {
        const id = this.facts().tunnelId;
        if (id) {
          await navigator.clipboard.writeText(id);
          this.message = "Tunnel ID copied.";
        }
      });
    });
    element<HTMLInputElement>("#onboarding-tunnel-id").addEventListener(
      "input",
      () => {
        this.tunnelEdited = true;
        this.message = "";
        port.render();
      },
    );
    element<HTMLInputElement>("#onboarding-runtime-key").addEventListener(
      "input",
      () => {
        this.message = "";
        port.render();
      },
    );
    document
      .querySelectorAll<HTMLButtonElement>("[data-onboarding-step]")
      .forEach((button) => {
        button.addEventListener("click", () =>
          this.select(
            onboardingSteps.findIndex(
              (item) => item.id === button.dataset.onboardingStep,
            ),
          ),
        );
      });
    document
      .querySelectorAll<HTMLButtonElement>("[data-onboarding-help]")
      .forEach((button) => {
        button.addEventListener("click", () => {
          const destination = button.dataset.onboardingHelp;
          if (
            destination !== "tunnels" &&
            destination !== "api-keys" &&
            destination !== "chatgpt" &&
            destination !== "setup-guide"
          )
            return;
          void this.perform("Opening your browser…", async () => {
            if (
              await port.configure(
                { kind: "onboarding.open-help", destination },
                "Page opened in your browser.",
              )
            )
              this.message = "Opened in your browser. Return here when done.";
          });
        });
      });
  }

  private click(selector: string, action: () => void): void {
    element<HTMLButtonElement>(selector).addEventListener("click", () => {
      if (!this.busy) action();
    });
  }
  private facts() {
    return onboardingFacts(this.port.settings(), this.port.buildId());
  }
  private draft() {
    return {
      tunnelId: element<HTMLInputElement>("#onboarding-tunnel-id").value,
      runtimeKey: element<HTMLInputElement>("#onboarding-runtime-key").value,
    };
  }
  private resetDraft(): void {
    this.tunnelEdited = false;
    element<HTMLInputElement>("#onboarding-tunnel-id").value =
      this.facts().tunnelId ?? "";
    element<HTMLInputElement>("#onboarding-runtime-key").value = "";
    this.message = "";
    this.feedbackStep = null;
  }
  private progress(): readonly boolean[] {
    const facts = this.facts();
    const progress = [...onboardingProgress(facts, this.port.mode)];
    for (const index of this.failedChecks) {
      // A folder check can fail without undoing the owner's optional choice.
      // The folder card reports the access problem; connection stays unready.
      if (index === 1 || (index === 0 && this.port.mode === "external"))
        continue;
      progress[index] = false;
      if (index < 3) progress[3] = false;
    }
    progress[4] = progress.slice(0, 4).every(Boolean);
    return progressWithConnectionDraft(
      progress,
      this.credentialsEditing === true &&
        connectionDraftChanged(facts, this.draft()),
    );
  }
  private hasCurrentFolderWitness(): boolean {
    const settings = this.port.settings();
    const witness = settings?.setup.computer.verified;
    return (
      settings !== null &&
      witness !== undefined &&
      witness !== null &&
      witness.buildId === this.port.buildId() &&
      witness.configRevision === settings.computer.generation &&
      settings.computer.workspaces.some(
        (item) =>
          item.workspaceId === witness.workspaceId &&
          item.rootIdentity !== undefined,
      )
    );
  }
  restart(): void {
    this.select(4);
  }
  signInReturned(): void {
    this.signInOpened = false;
    // A fresh page observation replaces the last failed local check. The
    // persisted evidence still decides whether the step is complete.
    this.failedChecks.delete(0);
    this.port.render();
  }
  private select(index: number): void {
    if (this.busy || index < 0 || index >= onboardingSteps.length) return;
    this.step = index;
    this.message = "";
    this.feedbackStep = null;
    this.pendingFolder = null;
    this.confirmNewCheck = false;
    this.port.render();
    element("#onboarding-scroll").scrollTop = 0;
  }

  render(enabled: boolean, feedback: string, feedbackError: boolean): void {
    const active = enabled && this.port.isActive();
    document.documentElement.dataset.guidedOnboarding = String(active);
    element("#guided-onboarding").hidden = !enabled;
    element("#onboarding-nav").hidden = !active;
    element("#nav").hidden = active;
    if (!enabled) return;
    const external = this.port.mode === "external";
    document
      .querySelectorAll<HTMLElement>("[data-onboarding-verification]")
      .forEach((node) => {
        node.hidden = node.dataset.onboardingVerification !== this.port.mode;
      });
    const challenge =
      external && externalConnectorChallengeAllowed(this.facts())
        ? this.port.verificationCard()
        : null;
    element("#onboarding-external-challenge").replaceChildren(
      ...(challenge ? [challenge] : []),
    );
    const facts = this.facts();
    const settings = this.port.settings();
    if (active && settings && !this.busy) {
      for (const folder of settings.computer.workspaces) {
        if (
          folder.accessCheck == null ||
          folderAccessChecked(settings, folder, this.port.buildId())
        )
          continue;
        const key = `${this.port.buildId()}:${settings.computer.generation}:${folder.workspaceId}`;
        if (this.backgroundFolderChecks.has(key)) continue;
        const check = this.backgroundFolderCheckTail
          .then(() =>
            this.port.configure(
              {
                kind: "computer.check-folder",
                workspaceId: folder.workspaceId,
              },
              "Saved folder access refreshed.",
            ),
          )
          .catch(() => false);
        this.backgroundFolderChecks.set(key, check);
        this.backgroundFolderCheckTail = check;
      }
    }
    const saved = facts.credentialStored && facts.tunnelId !== null;
    if (this.credentialsEditing === null && settings)
      this.credentialsEditing = !saved;
    const editing = this.credentialsEditing === true || !saved;
    const tunnel = element<HTMLInputElement>("#onboarding-tunnel-id");
    const key = element<HTMLInputElement>("#onboarding-runtime-key");
    if (!this.tunnelEdited && document.activeElement !== tunnel)
      tunnel.value = facts.tunnelId ?? "";
    const changed = editing && connectionDraftChanged(facts, this.draft());
    const currentProgress = this.progress();
    const completed = onboardingCompletedSteps(settings, this.port.mode);
    const progress = currentProgress.map(
      (ready, index) => ready || completed[index],
    );
    const savedCompletion = progress[4] === true && currentProgress[4] !== true;
    const localAccessOff = !facts.hasFolder;
    const step = onboardingSteps[this.step]!;
    const complete = progress[this.step] === true;
    const prerequisite = onboardingPrerequisite(this.step, currentProgress);
    const actionPrerequisite =
      this.step === 3 && complete
        ? null
        : onboardingActionPrerequisite(this.step, currentProgress, completed);
    const completedAction = completedStepAction(
      this.step,
      currentProgress,
      completed,
    );
    const unknown = facts.outcomeUnknown && this.step >= 2 && this.step < 4;
    if (active)
      element("#window-mode").textContent = currentProgress[4]
        ? "Setup complete · connection verified"
        : savedCompletion
          ? "Setup complete · connection check needed"
          : `Setup · ${progress.slice(0, 4).filter(Boolean).length} of 4 checks complete`;
    element<HTMLFormElement>("#onboarding-form").setAttribute(
      "aria-busy",
      String(this.busy),
    );
    document
      .querySelectorAll<HTMLButtonElement>("[data-onboarding-step]")
      .forEach((button) => {
        const index = onboardingSteps.findIndex(
          (item) => item.id === button.dataset.onboardingStep,
        );
        button.disabled = this.busy;
        button.classList.toggle("active", index === this.step);
        button.classList.toggle("complete", progress[index] === true);
        if (index === this.step) button.setAttribute("aria-current", "step");
        else button.removeAttribute("aria-current");
        button.querySelector("span")!.textContent = progress[index]
          ? "✓"
          : index === 4
            ? "◫"
            : String(index + 1);
        button.querySelector("b")!.textContent =
          external && index === 0
            ? "Sign in (optional)"
            : onboardingSteps[index]!.label;
        button.setAttribute(
          "aria-label",
          `${index === 4 ? "" : `${index + 1}. `}${onboardingSteps[index]!.label}${progress[index] ? ", completed" : ""}`,
        );
      });
    element("#onboarding-counter").textContent =
      this.step === 4 ? "SETUP OVERVIEW" : `STEP ${this.step + 1} OF 4`;
    element("#onboarding-title").textContent =
      this.step === 4 && savedCompletion
        ? "Your setup is saved"
        : this.step === 4 && complete
          ? "You're connected"
          : this.step === 4 && localAccessOff && progress[0]
            ? external
              ? "Computer access is off"
              : "ChatGPT is ready"
            : external && this.step === 0
              ? "Embedded ChatGPT is optional"
              : external && this.step === 3
                ? "Connect Farol in your ChatGPT conversation"
                : step.title;
    element("#onboarding-copy").textContent =
      this.step === 4 && savedCompletion
        ? external
          ? "Your setup is saved. Check the current NEW connection before using this computer from ChatGPT."
          : "You completed setup before this update. ChatGPT is available; check the connection again before using this computer from ChatGPT."
        : this.step === 4 && complete
          ? "Your connection is verified. Review a step any time to check it again or change your settings."
          : this.step === 4 && localAccessOff && progress[0]
            ? "No folders are shared, so local Computer access is off. Add a folder later if you want to connect this computer to ChatGPT."
            : external && this.step === 0
              ? "Computer works from your ordinary ChatGPT conversation through the new connector. Sign-in inside Farol is optional and grants no workspace access."
              : external && this.step === 3
                ? "Select the separate NEW connector in ordinary ChatGPT, run the current one-time challenge below, then check its local receipt. Farol does not send a message for this check."
                : step.copy;
    document
      .querySelectorAll<HTMLElement>("[data-onboarding-content]")
      .forEach((panel) => {
        panel.hidden = panel.dataset.onboardingContent !== step.id;
      });
    const primary = element<HTMLButtonElement>("#onboarding-primary");
    primary.disabled = this.busy || !facts.available;
    primary.dataset.complete = String(complete && this.step !== 4);
    primary.textContent = this.busy
      ? this.busyLabel
      : this.step === 4
        ? complete || (localAccessOff && progress[0])
          ? "Open ChatGPT"
          : "Continue setup"
        : unknown
          ? facts.runtime === "ready"
            ? "Check previous result"
            : "Stop connection"
          : localAccessOff && (this.step === 2 || this.step === 3)
            ? "Continue without local access"
            : this.step === 2 && editing
              ? "Save credentials"
              : actionPrerequisite !== null
                ? `Go to ${onboardingSteps[actionPrerequisite]!.label}`
                : completedAction === "reconnect-and-continue"
                  ? this.step === 3
                    ? "Restore connection for check"
                    : "Reconnect and continue"
                  : completedAction === "continue"
                    ? this.step === 3
                      ? "View overview"
                      : "Continue"
                    : this.step === 0
                      ? this.signInOpened
                        ? "Check sign-in"
                        : "Sign in to ChatGPT"
                      : this.step === 1
                        ? "Add folder…"
                        : this.step === 2
                          ? facts.runtime === "stopped"
                            ? "Activate and check"
                            : "Reconnect and check"
                          : external
                            ? "Check attachment"
                            : "Run end-to-end check";
    const back = element<HTMLButtonElement>("#onboarding-back");
    back.disabled = this.busy;
    back.hidden = this.step === 4;
    back.textContent = this.step === 0 ? "Overview" : "Back";
    const status = element("#onboarding-status");
    const localError = this.feedbackStep === this.step && feedbackError;
    status.dataset.state =
      complete && !this.busy && !localError && !(changed && this.step === 2)
        ? "ready"
        : unknown || localError || (changed && this.step === 2)
          ? "attention"
          : "pending";
    const successes = [
      external
        ? "✓ Embedded sign-in is optional for Computer"
        : "✓ Signed in to ChatGPT",
      localAccessOff
        ? "✓ No folders shared (optional)"
        : "✓ Folder choice saved. Farol checks access in the background.",
      "✓ Tunnel connection verified",
      external
        ? "✓ Attachment receipt verified for this connector"
        : "✓ End-to-end check passed through Farol Dev",
      "✓ All four setup checks complete",
    ];
    status.hidden =
      this.step === 3 &&
      !complete &&
      !localAccessOff &&
      !this.busy &&
      !this.message &&
      !unknown &&
      !localError &&
      completedAction !== "reconnect-and-continue";
    status.textContent = this.busy
      ? this.busyLabel
      : this.message ||
        (localAccessOff && (this.step === 2 || this.step === 3)
          ? "Local Computer access is off. Add a folder later to enable this connection."
          : this.step === 2 && editing && changed
            ? "Your saved connection stays in use until you save the replacement."
            : this.step === 2 && editing && !saved
              ? "First, save your tunnel credentials below."
              : complete
                ? !currentProgress[this.step]
                  ? "✓ Completed earlier. Check the current connection before using this computer."
                  : successes[this.step]!
                : unknown
                  ? "Check the previous result. It will not be sent again automatically."
                  : completedAction === "reconnect-and-continue"
                    ? "This connection worked before, but needs a fresh local check on this version. Farol will check your saved folders and reconnect if needed."
                    : actionPrerequisite !== null
                      ? `Next: finish ${onboardingSteps[actionPrerequisite]!.label}. The button below takes you there.`
                      : this.step === 2 && saved
                        ? "Credentials saved. Activate the tunnel to check that it works."
                        : this.step === 4
                          ? `${progress.slice(0, 4).filter(Boolean).length} of 4 checks complete. Open a step to continue or change it.`
                          : this.step === 1
                            ? "Add a folder to continue. Farol checks it automatically."
                            : "Not checked yet");
    const feedbackNode = element("#onboarding-feedback");
    feedbackNode.textContent =
      active && this.feedbackStep === this.step && feedbackError
        ? feedback
        : "";
    feedbackNode.classList.toggle("error", feedbackError);
    element("#computer-feedback").hidden = active;
    element("#review-setup").textContent = "Open setup overview";
    element("#onboarding-chat-copy").textContent = external
      ? "Embedded sign-in is optional. Computer uses the separate connector selected in your ordinary ChatGPT conversation."
      : progress[0]
        ? "Your sign-in is verified. Check it again, or open ChatGPT to review or change your account."
        : "Sign in inside Farol, then choose Return to Setup. Your everyday browser and Codex remain unchanged.";

    this.renderFolders(settings);
    element("#onboarding-credentials-saved").hidden =
      localAccessOff || !saved || editing;
    element("#onboarding-tunnel-fields").hidden = localAccessOff || !editing;
    element("#onboarding-connection-guide").hidden =
      localAccessOff || (saved && !editing);
    element("#onboarding-connection-help").hidden =
      localAccessOff || (saved && !editing);
    tunnel.disabled = this.busy || !facts.available;
    key.disabled = this.busy || !facts.available;
    element<HTMLButtonElement>("#onboarding-replace-credentials").disabled =
      this.busy;
    element<HTMLButtonElement>("#onboarding-keep-credentials").hidden =
      !editing || !saved;
    element<HTMLButtonElement>("#onboarding-keep-credentials").disabled =
      this.busy;
    element("#onboarding-key-status").hidden = !editing;
    element("#onboarding-key-status").textContent =
      "The key is secret. Paste a runtime API key with Tunnels Read + Use. Farol never loads a saved key into this form.";
    element("#onboarding-tunnel-note").textContent = localAccessOff
      ? "Local Computer access is off. Add a folder later to activate this connection."
      : editing && facts.runtime !== "stopped"
        ? "Saving a replacement pauses this connection. Activate it again after saving; cancellation changes nothing."
        : facts.runtimeCurrent
          ? "The tunnel is ready. Check connection probes it without restarting or sending a ChatGPT message."
          : saved
            ? "Your credentials are stored. The connection still needs to be activated or checked."
            : "Use a separate tunnel for this Farol, not the one running another Farol installation.";
    element<HTMLButtonElement>("#onboarding-copy-tunnel").disabled =
      this.busy || !saved;
    element("#onboarding-app-tunnel").textContent = facts.tunnelId
      ? `Tunnel to select: ${facts.tunnelId}`
      : "Save your tunnel on the Connection step first.";
    element<HTMLButtonElement>("#onboarding-open-chatgpt").disabled = this.busy;
    const recheck = element<HTMLButtonElement>("#onboarding-recheck");
    recheck.hidden =
      this.step === 4 ||
      this.step === 1 ||
      (this.step === 2 && (editing || !facts.runtimeCurrent)) ||
      unknown;
    recheck.disabled = this.busy || !facts.available || prerequisite !== null;
    recheck.textContent =
      this.step === 0
        ? "Check sign-in"
        : this.step === 1
          ? "Add folder…"
          : this.step === 2
            ? "Check connection"
            : "Check previous result";
    element<HTMLButtonElement>("#onboarding-open-account").hidden =
      this.step !== 0;
    element<HTMLButtonElement>("#onboarding-open-account").disabled = this.busy;
    element<HTMLButtonElement>("#onboarding-reconnect").hidden =
      this.step !== 2 ||
      editing ||
      !saved ||
      facts.runtime === "stopped" ||
      unknown;
    element<HTMLButtonElement>("#onboarding-reconnect").disabled =
      this.busy || prerequisite !== null;
    element<HTMLButtonElement>("#onboarding-verify-again").hidden =
      external || !progress[3] || unknown;
    element<HTMLButtonElement>("#onboarding-verify-again").disabled = this.busy;
    element("#onboarding-new-check-confirmation").hidden =
      external || !this.confirmNewCheck;
    element("#onboarding-recovery").hidden = !(
      unknown ||
      (this.step >= 2 && this.step < 4 && facts.runtime === "unreachable")
    );
    element("#onboarding-recovery-copy").textContent = unknown
      ? "Check the existing result or open ChatGPT. Stopping the connection does not cancel a message already sent to ChatGPT."
      : "The tunnel did not report ready. Reconnect once using your saved credentials, or open connection details for the cause.";
    element<HTMLButtonElement>("#onboarding-check-result").disabled =
      this.busy || facts.runtime !== "ready";
    element<HTMLButtonElement>("#onboarding-stop").disabled = this.busy;
    document
      .querySelectorAll<HTMLButtonElement>("[data-onboarding-help]")
      .forEach((button) => {
        button.disabled = this.busy;
      });
    element("#onboarding-finish-list").replaceChildren(
      ...onboardingSteps.slice(0, 4).map((item, index) => {
        const row = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.disabled = this.busy;
        button.className = progress[index]
          ? "onboarding-overview-row complete"
          : "onboarding-overview-row";
        const name = document.createElement("strong");
        name.textContent = `${progress[index] ? "✓" : index + 1}  ${item.label}`;
        const detail = document.createElement("span");
        detail.textContent =
          index === 1
            ? localAccessOff
              ? "Optional · no folders shared"
              : `${settings?.computer.workspaces.length ?? 0} folders added · access checked separately`
            : localAccessOff && index === 2
              ? "Local Computer access off"
              : localAccessOff && index === 3
                ? "Available after local access"
                : index === 2 && changed
                  ? "Unsaved replacement"
                  : progress[index]
                    ? currentProgress[index]
                      ? "Verified · review or check again"
                      : "Completed before update · check current connection"
                    : index === 2 && saved
                      ? "Credentials saved · check connection"
                      : "Needs setup or verification";
        button.append(name, detail);
        button.addEventListener("click", () => this.select(index));
        row.append(button);
        return row;
      }),
    );
  }

  private renderFolders(settings: ProductSettings | null): void {
    const folders = settings?.computer.workspaces ?? [];
    element("#onboarding-folder-empty").hidden = folders.length > 0;
    element<HTMLButtonElement>("#onboarding-add-folder").disabled =
      this.busy || !settings;
    element("#onboarding-folder-scope").textContent = folders.length
      ? `${folders.length} ${folders.length === 1 ? "folder" : "folders"} available to Farol. Add more or remove one at any time.`
      : "No folders shared. Add one any time if you want local Computer access.";
    element("#onboarding-folder-list").replaceChildren(
      ...folders.map((folder) => {
        const checked =
          settings !== null &&
          folderAccessChecked(settings, folder, this.port.buildId());
        const priorCheck = folder.accessCheck;
        const checkedBeforeUpdate =
          !checked &&
          settings !== null &&
          priorCheck != null &&
          folder.rootIdentity !== undefined &&
          priorCheck.computerGeneration === settings.computer.generation &&
          priorCheck.rootIdentity.device === folder.rootIdentity.device &&
          priorCheck.rootIdentity.inode === folder.rootIdentity.inode;
        const row = document.createElement("li");
        row.className = "onboarding-folder-card";
        row.dataset.state =
          checked || checkedBeforeUpdate ? "ready" : "pending";
        const copy = document.createElement("div");
        copy.className = "onboarding-folder-copy";
        const title = document.createElement("strong");
        title.textContent = folderDisplayName(folder);
        const path = document.createElement("span");
        path.className = "onboarding-folder-path";
        path.textContent = folder.root;
        path.title = folder.root;
        const state = document.createElement("small");
        state.textContent = `${checked ? "✓ Ready to use" : checkedBeforeUpdate ? "✓ Added · check on this version before use" : "Access needs attention"} · ${folder.access === "write" ? "Read and write" : "Read only"}`;
        copy.append(title, path, state);
        const actions = document.createElement("div");
        actions.className = "onboarding-folder-actions";
        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "Remove";
        remove.disabled = this.busy;
        remove.setAttribute(
          "aria-label",
          `Remove ${folderDisplayName(folder)} from Farol`,
        );
        remove.addEventListener("click", () =>
          this.requestFolderAction("remove", [folder.workspaceId]),
        );
        actions.append(remove);
        row.append(copy, actions);
        return row;
      }),
    );
    const pending = this.pendingFolder;
    element("#onboarding-folder-confirmation").hidden = pending === null;
    if (pending) {
      const paused = this.facts().runtime !== "stopped";
      const target = folders.find(
        (folder) => folder.workspaceId === pending.ids[0],
      );
      element("#onboarding-folder-confirmation-copy").textContent =
        pending.kind === "remove"
          ? `Remove ${target ? folderDisplayName(target) : "this folder"} from Farol? Your files will not be deleted.${paused ? " The connection will pause while access changes." : ""}`
          : "Farol will update folder access and reconnect if the connection was running.";
      element<HTMLButtonElement>("#onboarding-confirm-folder").textContent =
        pending.kind === "remove"
          ? paused
            ? "Pause and remove"
            : "Remove folder"
          : "Add folder…";
    }
  }

  private async perform(
    label: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.busyLabel = label;
    this.message = "";
    this.feedbackStep = this.step;
    this.port.render();
    try {
      await operation();
    } catch {
      this.message =
        "No confirmed result was received. Check the existing operation before repeating it.";
    } finally {
      this.busy = false;
      this.port.render();
    }
  }
  private async openVerificationChat(): Promise<void> {
    await this.perform("Opening ChatGPT…", async () => {
      if (
        await this.port.configure(
          { kind: "chatgpt.open-sign-in" },
          "ChatGPT opened inside Farol. Return to Setup when done.",
        )
      )
        this.signInOpened = true;
    });
  }
  private requestFolderAction(
    kind: FolderAction["kind"],
    ids: readonly string[],
  ): void {
    if (this.busy) return;
    const facts = this.facts();
    if (facts.outcomeUnknown) {
      this.message =
        "Check the previous connection result before changing folder access.";
      this.port.render();
      return;
    }
    const action = {
      kind,
      ids: [...ids],
      authority: facts.authority,
      connectionIdentity: facts.connectionIdentity,
    };
    if (kind === "remove") {
      this.pendingFolder = action;
      this.port.render();
      return;
    }
    void this.updateFolders(action);
  }
  private async updateFolders(action: FolderAction): Promise<void> {
    await this.perform(
      action.kind === "add" ? "Adding a folder…" : "Removing access…",
      async () => {
        const initial = this.facts();
        if (
          initial.outcomeUnknown ||
          initial.authority !== action.authority ||
          initial.connectionIdentity !== action.connectionIdentity
        ) {
          this.message = failureMessages["state-changed"];
          return;
        }
        const selectionId =
          action.kind === "add" ? await this.port.chooseFolder() : null;
        if (action.kind === "add" && !selectionId) {
          this.message = "No folder added. Your connection is unchanged.";
          return;
        }
        const afterPicker = this.facts();
        if (
          afterPicker.outcomeUnknown ||
          afterPicker.authority !== initial.authority ||
          afterPicker.connectionIdentity !== initial.connectionIdentity ||
          afterPicker.runtime !== initial.runtime
        ) {
          this.message = failureMessages["state-changed"];
          return;
        }
        if (initial.runtime !== "stopped") {
          if (
            !(await this.port.configure(
              { kind: "connector.stop" },
              "Connection paused for the folder change.",
            ))
          )
            return;
          const stopped = this.facts();
          if (
            stopped.runtime !== "stopped" ||
            stopped.outcomeUnknown ||
            stopped.authority !== initial.authority ||
            stopped.connectionIdentity !== initial.connectionIdentity
          ) {
            this.message = failureMessages["state-changed"];
            return;
          }
        }
        let first = action.ids[0];
        if (action.kind === "add") {
          const selected = await this.port.pickFolder(selectionId!);
          if (!selected) {
            this.message =
              "The folder change was not confirmed. Review the current folder list before reconnecting.";
            return;
          }
          first = selected;
        } else if (action.kind === "remove") {
          if (
            !first ||
            !(await this.port.configure(
              { kind: "computer.remove-workspace", workspaceId: first },
              "Folder removed from Farol. Files were not deleted.",
            ))
          )
            return;
          if (
            this.port
              .settings()
              ?.computer.workspaces.some((item) => item.workspaceId === first)
          ) {
            this.message = "Removal was not confirmed. Review the folder list.";
            return;
          }
          first = undefined;
        }
        const all =
          this.port
            .settings()
            ?.computer.workspaces.map((item) => item.workspaceId) ?? [];
        const ids = all;
        if (ids.length === 0) {
          this.failedChecks.delete(1);
          this.message =
            "No folders shared. You can continue and add one later.";
          return;
        }
        // The witness is an internal connection proof, never a hidden selection
        // that limits or expands the list. Every requested folder is checked.
        if (!this.hasCurrentFolderWitness()) {
          const witness = first ?? ids[0];
          if (
            !witness ||
            !(await this.port.configure(
              { kind: "computer.verify-workspace", workspaceId: witness },
              "Folder access checked.",
            ))
          ) {
            this.failedChecks.add(1);
            return;
          }
        }
        for (const id of ids) {
          const settings = this.port.settings();
          const folder = settings?.computer.workspaces.find(
            (item) => item.workspaceId === id,
          );
          if (!folder) {
            this.message = failureMessages["state-changed"];
            this.failedChecks.add(1);
            return;
          }
          const command: ProductConfigurationCommand = folder.rootIdentity
            ? { kind: "computer.check-folder", workspaceId: id }
            : { kind: "computer.verify-workspace", workspaceId: id };
          if (
            !(await this.port.configure(
              command,
              "Folder access checked without reading file contents.",
            ))
          ) {
            this.failedChecks.add(1);
            return;
          }
        }
        this.failedChecks.delete(1);
        if (initial.runtime === "ready" && this.facts().runtime === "stopped") {
          if (
            !(await this.port.configure(
              { kind: "connector.start" },
              "Connection restarted after the folder change.",
            ))
          ) {
            this.message =
              "Folder access is ready. The connection needs attention before ChatGPT can use it.";
            return;
          }
        }
        this.message =
          action.kind === "remove"
            ? "Folder removed. Your files were not deleted."
            : "Folder added and ready to use.";
      },
    );
  }
  private async saveCredentials(): Promise<void> {
    await this.perform("Saving credentials…", async () => {
      const result = await this.credentials.run(
        {
          read: () => this.facts(),
          run: (command) => {
            return this.port.configure(command, "Credentials saved privately.");
          },
        },
        this.draft(),
      );
      if (result.ok) {
        this.credentialsEditing = false;
        this.resetDraft();
        this.message = this.facts().runtimeCurrent
          ? "✓ Saved credentials kept. The connection remains active."
          : "✓ Credentials saved. Activate the tunnel to check the connection.";
        this.failedChecks.delete(2);
      } else this.message = failureMessages[result.reason];
    });
  }
  private async applyConnection(
    reconnect = false,
    continueOnReady = false,
  ): Promise<void> {
    let ready = false;
    await this.perform(
      reconnect
        ? "Checking saved folders and reconnecting…"
        : "Checking saved folders and activating…",
      async () => {
        const settings = this.port.settings();
        if (settings) {
          const prefix = `${this.port.buildId()}:${settings.computer.generation}:`;
          await Promise.all(
            [...this.backgroundFolderChecks]
              .filter(([key]) => key.startsWith(prefix))
              .map(([, check]) => check),
          );
        }
        const folder = await refreshApprovedFolderAccess({
          settings: () => this.port.settings(),
          buildId: () => this.port.buildId(),
          check: (workspaceId) =>
            this.port.configure(
              { kind: "computer.check-folder", workspaceId },
              "Saved folder access checked.",
            ),
        });
        if (folder !== "ready") {
          this.failedChecks.add(2);
          this.message =
            folder === "failed"
              ? "Farol could not open one of your saved folders. Open Folders to review it; no ChatGPT message was sent."
              : folder === "changed"
                ? "The saved folder changed while checking access. Review Folders before continuing."
                : "No folder is available for local access. Add one in Folders, or continue without local access.";
          return;
        }
        const facts = this.facts();
        const connector = this.port.settings()?.connectors.secureMcp;
        const challenge = connector?.challenge;
        const runtime = connector?.runtime;
        if (
          facts.runtimeCurrent &&
          facts.runtime === "ready" &&
          !facts.outcomeUnknown &&
          challenge !== null &&
          challenge !== undefined &&
          challenge.runtimeGeneration === runtime?.runtimeGeneration &&
          challenge.buildId === this.port.buildId()
        ) {
          ready = true;
          this.failedChecks.delete(2);
          this.message = "✓ Saved folders and current connection are ready.";
          return;
        }
        const result = await this.connection.run(
          {
            read: () => this.facts(),
            run: (command) =>
              this.port.configure(command, "Connection action confirmed."),
          },
          { tunnelId: facts.tunnelId ?? "", runtimeKey: "" },
          reconnect,
          this.port.mode,
        );
        if (result.ok) {
          ready = true;
          this.failedChecks.delete(2);
          this.message =
            "✓ Tunnel connection verified. Check the ChatGPT app next.";
        } else {
          this.message = failureMessages[result.reason];
          if (
            ![
              "invalid-fields",
              "new-key-required",
              "prerequisite",
              "busy",
            ].includes(result.reason)
          )
            this.failedChecks.add(2);
        }
      },
    );
    if (ready && continueOnReady) this.select(3);
  }
  private async checkAttachment(): Promise<void> {
    await this.perform("Checking the previous result…", async () => {
      if (
        await this.port.configure(
          { kind: "connector.check-attachment" },
          "Existing connection result checked.",
        )
      ) {
        this.failedChecks.delete(3);
        this.message =
          "✓ Previous connection result confirmed. No new message was sent.";
      } else this.failedChecks.add(3);
    });
  }
  private async verifyApp(fresh: boolean): Promise<void> {
    if (this.port.mode === "external") {
      await this.checkAttachment();
      return;
    }
    await this.perform("Checking through ChatGPT…", async () => {
      if (this.facts().outcomeUnknown) {
        this.message = failureMessages["inspect-existing-operation"];
        return;
      }
      if (fresh) {
        const folder = await refreshApprovedFolderAccess({
          settings: () => this.port.settings(),
          buildId: () => this.port.buildId(),
          check: (workspaceId) =>
            this.port.configure(
              { kind: "computer.check-folder", workspaceId },
              "Saved folder access checked.",
            ),
        });
        if (folder !== "ready") {
          this.message =
            folder === "missing"
              ? "No folder is shared, so the local connector cannot be checked. Add a folder if you want local access."
              : "Saved folder access needs attention. Review Folders before running another check.";
          return;
        }
        const before = this.facts();
        if (
          before.runtime !== "ready" ||
          !before.runtimeCurrent ||
          before.verificationIdentity === null
        ) {
          const reconnected = await this.connection.run(
            {
              read: () => this.facts(),
              run: (command) =>
                this.port.configure(command, "Connection action confirmed."),
            },
            { tunnelId: before.tunnelId ?? "", runtimeKey: "" },
            true,
          );
          if (!reconnected.ok) {
            this.message = failureMessages[reconnected.reason];
            return;
          }
        }
      }
      const ready = this.facts();
      if (
        !ready.available ||
        ready.chat !== "ready" ||
        ready.folder !== "ready" ||
        !ready.hasFolder ||
        !ready.client ||
        !ready.credentialStored ||
        ready.runtime !== "ready" ||
        !ready.runtimeCurrent ||
        ready.verificationIdentity === null
      ) {
        this.message =
          "The current connector is not ready for a ChatGPT check. Review Connection; no message was sent.";
        return;
      }
      if (
        !(await this.port.configure(
          { kind: "chatgpt.open-sign-in" },
          "ChatGPT opened for the connection check.",
        ))
      )
        return;
      const freshResult =
        fresh && freshAppCheckNeedsRepair(ready)
          ? await this.freshAppVerification.run({
              read: () => this.facts(),
              run: (command) =>
                this.port.configure(command, "Connection check completed."),
            })
          : null;
      const ok =
        freshResult !== null
          ? freshResult.ok
          : await this.port.configure(
              { kind: "connector.verify-app" },
              "Farol Dev connection verified.",
            );
      if (ok) {
        this.failedChecks.delete(3);
        this.message =
          "✓ End-to-end check passed. Read the ChatGPT reply, then return to Setup.";
      } else {
        this.failedChecks.add(3);
        if (freshResult !== null && !freshResult.ok)
          this.message = failureMessages[freshResult.reason];
      }
    });
  }
  private async stopConnection(): Promise<void> {
    await this.perform("Stopping the connection…", async () => {
      if (
        await this.port.configure(
          { kind: "connector.stop" },
          "Connection stopped.",
        )
      )
        this.message =
          "Connection stopped. Your credentials are saved. A message already sent to ChatGPT is not cancelled or repeated.";
    });
  }
  private async recheck(): Promise<void> {
    if (this.step === 3) {
      await this.checkAttachment();
      return;
    }
    await this.perform(
      this.step === 0 ? "Checking sign-in…" : "Checking the tunnel…",
      async () => {
        const command: ProductConfigurationCommand =
          this.step === 0
            ? { kind: "chatgpt.verify" }
            : { kind: "connector.check-health" };
        if (
          await this.port.configure(
            command,
            "Check completed without sending a message.",
          )
        ) {
          if (this.step === 0 && !onboardingProgress(this.facts())[0]) {
            this.failedChecks.add(0);
            this.message =
              "Sign-in is not complete yet. Finish the ChatGPT login, then check again.";
          } else {
            this.failedChecks.delete(this.step);
            this.message =
              this.step === 0
                ? "✓ Signed in to ChatGPT. No message was sent."
                : "✓ Tunnel client is ready. No restart or ChatGPT message was needed.";
          }
        } else this.failedChecks.add(this.step);
      },
    );
  }
  private async act(): Promise<void> {
    if (this.busy || element<HTMLButtonElement>("#onboarding-primary").disabled)
      return;
    const progress = this.progress();
    if (this.step === 4) {
      if (!this.facts().hasFolder && progress[0]) {
        this.port.openChat();
        return;
      }
      if (onboardingCompletedSteps(this.port.settings(), this.port.mode)[4]) {
        this.port.openChat();
        return;
      }
      const first = firstIncompleteSetupStep(progress);
      if (first !== null) {
        this.select(first);
        return;
      }
      await this.perform("Opening ChatGPT…", async () => {
        if (
          (await this.port.configure(
            { kind: "setup.progress", currentStep: "verify", dismissed: true },
            "Basic setup complete.",
          )) &&
          this.port.isActive() &&
          this.progress()[4]
        )
          this.port.openChat();
      });
      return;
    }
    if (this.step >= 2 && this.facts().outcomeUnknown) {
      if (this.facts().runtime === "ready") await this.checkAttachment();
      else await this.stopConnection();
      return;
    }
    if ((this.step === 2 || this.step === 3) && !this.facts().hasFolder) {
      this.select(4);
      return;
    }
    if (
      this.step === 2 &&
      (this.credentialsEditing || !this.facts().credentialStored)
    ) {
      await this.saveCredentials();
      return;
    }
    const completed = onboardingCompletedSteps(
      this.port.settings(),
      this.port.mode,
    );
    const completedAction = completedStepAction(this.step, progress, completed);
    if (this.step === 3 && completedAction === "continue") {
      this.select(4);
      return;
    }
    const actionPrerequisite = onboardingActionPrerequisite(
      this.step,
      progress,
      completed,
    );
    if (actionPrerequisite !== null) {
      this.select(actionPrerequisite);
      return;
    }
    if (completedAction === "reconnect-and-continue") {
      await this.applyConnection(true, this.step === 2);
      return;
    }
    if (completedAction === "continue") {
      this.select(this.step + 1);
      return;
    }
    if (this.step === 0) {
      if (this.signInOpened) await this.recheck();
      else await this.openVerificationChat();
    } else if (this.step === 1) this.requestFolderAction("add", []);
    else if (this.step === 2) await this.applyConnection();
    else await this.verifyApp(false);
  }
}
