import type {
  ProductConfigurationCommand,
  ProductSettings,
} from "../pkg/product-settings/contract";
import {
  onboardingFacts,
  onboardingProgress,
  onboardingSteps,
} from "./guided-onboarding";
import {
  connectionDraftChanged,
  firstIncompleteSetupStep,
  GuidedConnectionUpdate,
  GuidedCredentialSave,
  GuidedFreshAppVerification,
  onboardingPrerequisite,
  progressWithConnectionDraft,
} from "./guided-onboarding-actions";
import { folderAccessChecked, folderDisplayName } from "./folder-access-state";

export interface GuidedOnboardingPort {
  readonly settings: () => ProductSettings | null;
  readonly buildId: () => string;
  readonly isActive: () => boolean;
  readonly configure: (
    command: ProductConfigurationCommand,
    message: string,
  ) => Promise<boolean>;
  readonly pickFolder: () => Promise<string | null>;
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
  prerequisite: "Check your sign-in and folders before connecting.",
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
  kind: "add" | "remove" | "check";
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
    const progress = [...onboardingProgress(facts)];
    for (const index of this.failedChecks) {
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
    const facts = this.facts();
    const settings = this.port.settings();
    const saved = facts.credentialStored && facts.tunnelId !== null;
    if (this.credentialsEditing === null && settings)
      this.credentialsEditing = !saved;
    const editing = this.credentialsEditing === true || !saved;
    const tunnel = element<HTMLInputElement>("#onboarding-tunnel-id");
    const key = element<HTMLInputElement>("#onboarding-runtime-key");
    if (!this.tunnelEdited && document.activeElement !== tunnel)
      tunnel.value = facts.tunnelId ?? "";
    const changed = editing && connectionDraftChanged(facts, this.draft());
    const progress = this.progress();
    const step = onboardingSteps[this.step]!;
    const complete = progress[this.step] === true;
    const prerequisite = onboardingPrerequisite(this.step, progress);
    const unknown = facts.outcomeUnknown && this.step >= 2 && this.step < 4;
    if (active)
      element("#window-mode").textContent = progress[4]
        ? "Setup complete · connection verified"
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
        button.querySelector("b")!.textContent = onboardingSteps[index]!.label;
        button.setAttribute(
          "aria-label",
          `${index === 4 ? "" : `${index + 1}. `}${onboardingSteps[index]!.label}${progress[index] ? ", completed" : ""}`,
        );
      });
    element("#onboarding-counter").textContent =
      this.step === 4 ? "SETUP OVERVIEW" : `STEP ${this.step + 1} OF 4`;
    element("#onboarding-title").textContent =
      this.step === 4 && complete ? "You're connected" : step.title;
    element("#onboarding-copy").textContent =
      this.step === 4 && complete
        ? "Your connection is verified. Review a step any time to check it again or change your settings."
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
        ? complete
          ? "Open ChatGPT"
          : "Continue setup"
        : unknown
          ? facts.runtime === "ready"
            ? "Check previous result"
            : "Stop connection"
          : this.step === 2 && editing
            ? "Save credentials"
            : prerequisite !== null
              ? `Go to ${onboardingSteps[prerequisite]!.label}`
              : complete
                ? "Continue"
                : this.step === 0
                  ? this.signInOpened
                    ? "Check sign-in"
                    : "Sign in to ChatGPT"
                  : this.step === 1
                    ? facts.hasFolder
                      ? "Check folders"
                      : "Add folder…"
                    : this.step === 2
                      ? facts.runtime === "stopped"
                        ? "Activate and check"
                        : "Reconnect and check"
                      : "Verify app";
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
      "✓ Signed in to ChatGPT",
      "✓ Folders ready",
      "✓ Tunnel connection verified",
      "✓ Farol Dev connection verified",
      "✓ All four setup checks complete",
    ];
    status.textContent = this.busy
      ? this.busyLabel
      : this.message ||
        (this.step === 2 && editing && changed
          ? "Your saved connection stays in use until you save the replacement."
          : this.step === 2 && editing && !saved
            ? "First, save your tunnel credentials below."
            : complete
              ? successes[this.step]!
              : unknown
                ? "Check the previous result. It will not be sent again automatically."
                : prerequisite !== null
                  ? `Next: finish ${onboardingSteps[prerequisite]!.label}. The button below takes you there.`
                  : this.step === 2 && saved
                    ? "Credentials saved. Activate the tunnel to check that it works."
                    : this.step === 4
                      ? `${progress.slice(0, 4).filter(Boolean).length} of 4 checks complete. Open a step to continue or change it.`
                      : "Not checked yet");
    const feedbackNode = element("#onboarding-feedback");
    feedbackNode.textContent =
      active && this.feedbackStep === this.step && feedbackError
        ? feedback
        : "";
    feedbackNode.classList.toggle("error", feedbackError);
    element("#computer-feedback").hidden = active;
    element("#review-setup").textContent = "Open setup overview";
    element("#onboarding-chat-copy").textContent = progress[0]
      ? "Your sign-in is verified. Check it again, or open ChatGPT to review or change your account."
      : "Sign in inside Farol, then choose Return to Setup. Your everyday browser and Codex remain unchanged.";

    this.renderFolders(settings);
    element("#onboarding-credentials-saved").hidden = !saved || editing;
    element("#onboarding-tunnel-fields").hidden = !editing;
    element("#onboarding-connection-guide").hidden = saved && !editing;
    element("#onboarding-connection-help").hidden = saved && !editing;
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
    element("#onboarding-tunnel-note").textContent =
      editing && facts.runtime !== "stopped"
        ? "Saving a replacement pauses this connection. Activate it again after saving; cancellation changes nothing."
        : facts.runtimeCurrent
          ? "The tunnel is ready. Check connection probes it without restarting or sending a ChatGPT message."
          : saved
            ? "Your credentials are stored. The connection still needs to be activated or checked."
            : "Use a separate Farol Dev tunnel, not the one running another Farol installation.";
    element<HTMLButtonElement>("#onboarding-copy-tunnel").disabled =
      this.busy || !saved;
    element("#onboarding-app-tunnel").textContent = facts.tunnelId
      ? `Tunnel to select: ${facts.tunnelId}`
      : "Save your tunnel on the Connection step first.";
    element<HTMLButtonElement>("#onboarding-open-chatgpt").disabled = this.busy;
    const recheck = element<HTMLButtonElement>("#onboarding-recheck");
    recheck.hidden =
      this.step === 4 ||
      (this.step === 1 && !facts.hasFolder) ||
      (this.step === 2 && (editing || !facts.runtimeCurrent)) ||
      unknown;
    recheck.disabled = this.busy || !facts.available || prerequisite !== null;
    recheck.textContent =
      this.step === 0
        ? "Check sign-in"
        : this.step === 1
          ? "Verify access again"
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
      !progress[3] || unknown;
    element<HTMLButtonElement>("#onboarding-verify-again").disabled = this.busy;
    element("#onboarding-new-check-confirmation").hidden =
      !this.confirmNewCheck;
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
            ? `${settings?.computer.workspaces.length ?? 0} folders · ${progress[1] ? "Checked" : "Add or check access"}`
            : index === 2 && changed
              ? "Unsaved replacement"
              : progress[index]
                ? "Verified · review or check again"
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
      ? `${folders.length} ${folders.length === 1 ? "folder is" : "folders are"} available to Farol. This list shows every approved folder.`
      : "Add one or several folders. Farol checks access locally, without reading file contents.";
    element("#onboarding-folder-list").replaceChildren(
      ...folders.map((folder) => {
        const checked =
          settings !== null &&
          folderAccessChecked(settings, folder, this.port.buildId());
        const row = document.createElement("li");
        row.className = "onboarding-folder-card";
        row.dataset.state = checked ? "ready" : "pending";
        const copy = document.createElement("div");
        copy.className = "onboarding-folder-copy";
        const title = document.createElement("strong");
        title.textContent = folderDisplayName(folder);
        const path = document.createElement("span");
        path.className = "onboarding-folder-path";
        path.textContent = folder.root;
        path.title = folder.root;
        const state = document.createElement("small");
        state.textContent = `${checked ? "✓ Access checked" : "Added · needs checking"} · ${folder.access === "write" ? "Read and write" : "Read only"}`;
        copy.append(title, path, state);
        const actions = document.createElement("div");
        actions.className = "onboarding-folder-actions";
        const check = document.createElement("button");
        check.type = "button";
        check.textContent = "Retry access check";
        check.disabled = this.busy;
        check.setAttribute("aria-label", `Check ${folderDisplayName(folder)}`);
        check.addEventListener("click", () =>
          this.requestFolderAction("check", [folder.workspaceId]),
        );
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
        if (!checked) actions.append(check);
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
          : "The connection must pause to update folder access. Your saved credentials stay in place; reconnect afterwards.";
      element<HTMLButtonElement>("#onboarding-confirm-folder").textContent =
        pending.kind === "remove"
          ? paused
            ? "Pause and remove"
            : "Remove folder"
          : pending.kind === "add"
            ? "Pause and add folder…"
            : "Pause and check folders";
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
    const bindingNeeded =
      !this.hasCurrentFolderWitness() ||
      ids.some(
        (id) =>
          !this.port
            .settings()
            ?.computer.workspaces.find((item) => item.workspaceId === id)
            ?.rootIdentity,
      );
    if (
      kind === "remove" ||
      (facts.runtime !== "stopped" && (kind !== "check" || bindingNeeded))
    ) {
      this.pendingFolder = action;
      this.port.render();
      return;
    }
    void this.updateFolders(action);
  }
  private async updateFolders(action: FolderAction): Promise<void> {
    await this.perform(
      action.kind === "add"
        ? "Choosing a folder…"
        : action.kind === "remove"
          ? "Removing access…"
          : "Checking folders…",
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
        const bindingNeeded =
          !this.hasCurrentFolderWitness() ||
          action.ids.some(
            (id) =>
              !this.port
                .settings()
                ?.computer.workspaces.find((item) => item.workspaceId === id)
                ?.rootIdentity,
          );
        if (
          initial.runtime !== "stopped" &&
          (action.kind !== "check" || bindingNeeded)
        ) {
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
          const selected = await this.port.pickFolder();
          if (!selected) {
            this.message =
              this.facts().runtime === "stopped" &&
              initial.runtime !== "stopped"
                ? "No folder added. Your folders are unchanged; reconnect the paused connection when ready."
                : "No folder added. Your folders are unchanged.";
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
        const ids = action.kind === "check" ? action.ids : all;
        if (ids.length === 0) {
          this.failedChecks.delete(1);
          this.message = "No folders are shared. Add a folder to continue.";
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
        this.message =
          action.kind === "remove"
            ? "Folder removed. Remaining folder access checked; your files were not deleted."
            : action.kind === "add"
              ? "Folder added. Folder access checked."
              : "Folder access checked. No file contents were read.";
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
  private async applyConnection(reconnect = false): Promise<void> {
    await this.perform(
      reconnect ? "Reconnecting and checking…" : "Activating and checking…",
      async () => {
        const facts = this.facts();
        const result = await this.connection.run(
          {
            read: () => this.facts(),
            run: (command) =>
              this.port.configure(command, "Connection action confirmed."),
          },
          { tunnelId: facts.tunnelId ?? "", runtimeKey: "" },
          reconnect,
        );
        if (result.ok) {
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
    await this.perform("Checking through ChatGPT…", async () => {
      if (this.facts().outcomeUnknown) {
        this.message = failureMessages["inspect-existing-operation"];
        return;
      }
      if (
        !(await this.port.configure(
          { kind: "chatgpt.open-sign-in" },
          "ChatGPT opened for the connection check.",
        ))
      )
        return;
      const freshResult = fresh
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
        // The app check has finished. Return to the Setup result with one
        // click; this command only closes the embedded check surface.
        await this.port.configure(
          { kind: "chatgpt.verification-return" },
          "Returned to Setup.",
        );
        this.failedChecks.delete(3);
        this.message = "✓ ChatGPT reached this computer. Connection verified.";
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
    if (this.step === 1) {
      this.requestFolderAction(
        "check",
        this.port
          .settings()
          ?.computer.workspaces.map((item) => item.workspaceId) ?? [],
      );
      return;
    }
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
    if (
      this.step === 2 &&
      (this.credentialsEditing || !this.facts().credentialStored)
    ) {
      await this.saveCredentials();
      return;
    }
    const prerequisite = onboardingPrerequisite(this.step, progress);
    if (prerequisite !== null) {
      this.select(prerequisite);
      return;
    }
    if (progress[this.step]) {
      this.select(this.step + 1);
      return;
    }
    if (this.step === 0) {
      if (this.signInOpened) await this.recheck();
      else await this.openVerificationChat();
    } else if (this.step === 1)
      this.requestFolderAction(
        this.facts().hasFolder ? "check" : "add",
        this.port
          .settings()
          ?.computer.workspaces.map((item) => item.workspaceId) ?? [],
      );
    else if (this.step === 2) await this.applyConnection();
    else await this.verifyApp(false);
  }
}
