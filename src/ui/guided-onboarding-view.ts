import type {
  ProductConfigurationCommand,
  ProductSettings,
} from "../pkg/product-settings/contract";
import {
  defaultOnboardingFolderChoice,
  GuidedActivation,
  onboardingFacts,
  onboardingProgress,
  onboardingProgressForFolderChoice,
  onboardingSteps,
  selectedOnboardingWorkspace,
} from "./guided-onboarding";

export interface GuidedOnboardingPort {
  readonly settings: () => ProductSettings | null;
  readonly buildId: () => string;
  readonly isActive: () => boolean;
  readonly configure: (
    command: ProductConfigurationCommand,
    message: string,
  ) => Promise<boolean>;
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
  busy: "Another activation is already running.",
  prerequisite: "Complete sign-in and verify your folder before activating.",
  "invalid-fields":
    "Enter a valid tunnel ID and its runtime key (at least 20 printable characters).",
  "new-key-required":
    "Paste the key for this tunnel. A stored key cannot be reused for a different tunnel.",
  "inspect-existing-operation":
    "An existing operation needs attention. Inspect Advanced before trying again; Farol will not restart or repeat it automatically.",
  "state-changed":
    "Settings changed during activation. Review the current folder and connection before continuing.",
  "command-failed":
    "Activation stopped at the failed step. Nothing was retried; see the message below.",
  "runtime-not-ready":
    "The tunnel has not reported ready. Inspect Advanced before another attempt.",
} as const;

// Owns only transient navigation, input and busy state. All readiness is projected
// from the same configuration snapshot used by the rest of the application.
export class GuidedOnboardingView {
  private step = 0;
  private busy = false;
  private initialized = false;
  private tunnelEdited = false;
  private signInOpened = false;
  private folderChoice = "new";
  private folderChoiceInitialized = false;
  private message = "";
  private readonly activation = new GuidedActivation();

  constructor(private readonly port: GuidedOnboardingPort) {
    element<HTMLFormElement>("#onboarding-form").addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        void this.act();
      },
    );
    element<HTMLButtonElement>("#onboarding-back").addEventListener(
      "click",
      () => this.select(this.step - 1),
    );
    element<HTMLButtonElement>("#onboarding-return").addEventListener(
      "click",
      () => port.returnToChat(),
    );
    element<HTMLInputElement>("#onboarding-tunnel-id").addEventListener(
      "input",
      () => {
        this.tunnelEdited = true;
      },
    );
    element<HTMLSelectElement>("#onboarding-folder-choice").addEventListener(
      "change",
      (event) => {
        this.folderChoice = (event.currentTarget as HTMLSelectElement).value;
        this.message = "";
        this.port.render();
      },
    );
    document
      .querySelectorAll<HTMLButtonElement>("[data-onboarding-step]")
      .forEach((button, index) => {
        button.addEventListener("click", () => this.select(index));
      });
    element<HTMLButtonElement>("#onboarding-open-chatgpt").addEventListener(
      "click",
      () => port.openChat(),
    );
    element<HTMLButtonElement>("#onboarding-copy-check").addEventListener(
      "click",
      () => {
        void this.copyCheck();
      },
    );
  }

  private facts() {
    return onboardingFacts(this.port.settings(), this.port.buildId());
  }

  restart(): void {
    if (this.busy) return;
    const facts = this.facts();
    const settings = this.port.settings();
    const selectedFolder = settings
      ? selectedOnboardingWorkspace(settings, this.folderChoice)
      : null;
    const selectedFolderReady =
      selectedFolder !== null &&
      facts.folder === "ready" &&
      settings?.setup.computer.verified?.workspaceId ===
        selectedFolder.workspaceId;
    const first = onboardingProgressForFolderChoice(
      facts,
      selectedFolderReady,
    ).findIndex((complete) => !complete);
    this.select(first === -1 ? 4 : first);
  }

  signInReturned(): void {
    this.signInOpened = false;
    this.port.render();
  }

  private select(index: number): void {
    if (this.busy || index < 0 || index >= onboardingSteps.length) return;
    this.step = index;
    this.message = "";
    this.port.render();
  }

  render(enabled: boolean, feedback: string, feedbackError: boolean): void {
    const active = enabled && this.port.isActive();
    document.documentElement.dataset.guidedOnboarding = String(active);
    element("#guided-onboarding").hidden = !enabled;
    element("#onboarding-nav").hidden = !active;
    element("#nav").hidden = active;
    if (!enabled) return;
    const facts = this.facts();
    const progress = onboardingProgress(facts);
    const settings = this.port.settings();
    if (!this.initialized && settings) {
      this.initialized = true;
      element<HTMLDetailsElement>("#connection-diagnostics").open = false;
      const first = progress.findIndex((complete) => !complete);
      this.step = first === -1 ? 4 : first;
    }
    if (settings && !this.folderChoiceInitialized) {
      this.folderChoice = defaultOnboardingFolderChoice(
        settings,
        this.port.buildId(),
      );
      this.folderChoiceInitialized = true;
    }
    if (
      settings &&
      this.folderChoice !== "new" &&
      !selectedOnboardingWorkspace(settings, this.folderChoice)
    ) {
      this.folderChoice = "new";
    }
    const selectedFolder = settings
      ? selectedOnboardingWorkspace(settings, this.folderChoice)
      : null;
    const selectedFolderReady =
      selectedFolder !== null &&
      facts.folder === "ready" &&
      settings?.setup.computer.verified?.workspaceId ===
        selectedFolder.workspaceId;
    const visibleProgress = onboardingProgressForFolderChoice(
      facts,
      selectedFolderReady,
    );
    const folderChoice = element<HTMLSelectElement>(
      "#onboarding-folder-choice",
    );
    folderChoice.replaceChildren(
      new Option("Choose a new folder…", "new"),
      ...(settings?.computer.workspaces.map(
        (workspace) =>
          new Option(
            `${workspace.label} — ${workspace.root}`,
            workspace.workspaceId,
          ),
      ) ?? []),
    );
    folderChoice.value = this.folderChoice;
    folderChoice.disabled = this.busy;
    const step = onboardingSteps[this.step]!;
    document
      .querySelectorAll<HTMLButtonElement>("[data-onboarding-step]")
      .forEach((button, index) => {
        const current = index === this.step;
        button.disabled = this.busy;
        button.classList.toggle("active", current);
        button.classList.toggle("complete", visibleProgress[index] === true);
        if (current) button.setAttribute("aria-current", "step");
        else button.removeAttribute("aria-current");
        button.querySelector("span")!.textContent = visibleProgress[index]
          ? "✓"
          : String(index + 1);
        button.setAttribute(
          "aria-label",
          `${index + 1}. ${onboardingSteps[index]!.label}${visibleProgress[index] ? ", completed" : ""}`,
        );
      });
    element("#onboarding-counter").textContent =
      `STEP ${this.step + 1} OF ${onboardingSteps.length}`;
    element("#onboarding-title").textContent =
      this.step === 4 && !visibleProgress[4]
        ? "A few steps still need attention"
        : step.title;
    element("#onboarding-copy").textContent =
      this.step === 4 && !visibleProgress[4]
        ? "Use the steps on the left to finish connecting. Nothing becomes verified just by visiting a page."
        : this.step === 3 && !visibleProgress[2]
          ? "Activate the DEV tunnel first. Then add its app in ChatGPT and check that it can reach this computer."
          : step.copy;
    document
      .querySelectorAll<HTMLElement>("[data-onboarding-content]")
      .forEach((panel) => {
        panel.hidden = panel.dataset.onboardingContent !== step.id;
      });
    const primary = element<HTMLButtonElement>("#onboarding-primary");
    primary.disabled = this.busy || !facts.available;
    const stepComplete = visibleProgress[this.step];
    primary.textContent = this.busy
      ? "Working…"
      : stepComplete
        ? this.step === 4
          ? "Open ChatGPT"
          : "Continue"
        : this.step === 0
          ? this.signInOpened
            ? "Check sign-in"
            : "Sign in to ChatGPT"
          : this.step === 1
            ? selectedFolder
              ? "Verify folder"
              : "Choose a folder"
            : this.step === 2
              ? "Activate"
              : this.step === 3
                ? "Verify app"
                : "Review incomplete step";
    let prerequisite = "";
    if (this.step === 2 && (!visibleProgress[0] || !visibleProgress[1]))
      prerequisite = "Complete sign-in and choose a verified folder first.";
    if (this.step === 2 && facts.runtime !== "stopped" && !visibleProgress[2])
      prerequisite =
        "An existing tunnel needs attention. Inspect Advanced; do not start another one.";
    if (
      this.step === 3 &&
      (!visibleProgress[0] || !visibleProgress[1] || !visibleProgress[2])
    )
      prerequisite = "Complete sign-in, folder access and activation first.";
    if (facts.outcomeUnknown && this.step >= 2)
      prerequisite =
        "The previous connection outcome is unknown. Inspect Advanced before another action.";
    if (prerequisite) primary.disabled = true;
    primary.title = prerequisite;
    element<HTMLButtonElement>("#onboarding-back").disabled =
      this.busy || this.step === 0;
    const status = element("#onboarding-status");
    status.textContent =
      this.message ||
      prerequisite ||
      (stepComplete
        ? this.step === 2
          ? "Tunnel active. Next, add its app in ChatGPT."
          : "This step is complete."
        : "");
    const feedbackNode = element("#onboarding-feedback");
    feedbackNode.textContent = active ? feedback : "";
    feedbackNode.classList.toggle("error", feedbackError);
    element<HTMLDetailsElement>("#connection-diagnostics").inert = this.busy;
    element("#computer-feedback").hidden = active;
    element("#review-setup").textContent = "Return to guided setup";

    element("#onboarding-folder-name").textContent =
      selectedFolder?.label ?? "No folder chosen for this setup yet";
    const tunnel = element<HTMLInputElement>("#onboarding-tunnel-id");
    const key = element<HTMLInputElement>("#onboarding-runtime-key");
    if (!this.tunnelEdited && document.activeElement !== tunnel)
      tunnel.value = facts.tunnelId ?? "";
    tunnel.disabled =
      this.busy || !facts.available || facts.runtime !== "stopped";
    key.disabled = this.busy || !facts.available || facts.runtime !== "stopped";
    key.placeholder = facts.credentialStored
      ? "Stored privately; leave blank for this tunnel"
      : "Paste the key for this DEV tunnel";
    element("#onboarding-tunnel-fields").hidden = visibleProgress[2] === true;
    element("#onboarding-tunnel-note").textContent = visibleProgress[2]
      ? `Tunnel ${facts.tunnelId ?? ""} is active. No ChatGPT app attachment has been assumed.`
      : "Use a separate DEV tunnel. Do not reuse the tunnel running Legacy.";
    const connector = settings?.connectors.secureMcp;
    element("#onboarding-app-tunnel").textContent = facts.tunnelId
      ? `Your DEV tunnel: ${facts.tunnelId}`
      : "Activate your DEV tunnel first.";
    const challenge = connector?.challenge;
    const challengeCurrent =
      challenge &&
      connector?.runtime &&
      facts.runtimeCurrent &&
      challenge.buildId === this.port.buildId() &&
      challenge.computerGeneration === settings?.computer.generation &&
      challenge.runtimeGeneration === connector.runtime.runtimeGeneration;
    const verifiedWorkspace = settings?.computer.workspaces.find(
      (workspace) =>
        workspace.workspaceId === settings.setup.computer.verified?.workspaceId,
    );
    const request = element<HTMLTextAreaElement>("#onboarding-check-request");
    request.value =
      challengeCurrent && verifiedWorkspace
        ? `With @Farol Dev selected, call farol_next_connector_verify once with challenge "${challenge.value}" and workspaceId "${verifiedWorkspace.workspaceId}". Do not read file contents.`
        : visibleProgress[3]
          ? "Connection already verified. No new message is needed."
          : "A current connection check will appear after activation.";
    element<HTMLButtonElement>("#onboarding-copy-check").disabled =
      this.busy || !challengeCurrent || !verifiedWorkspace;
    element<HTMLButtonElement>("#onboarding-open-chatgpt").disabled =
      this.busy || !visibleProgress[0];
    element("#onboarding-finish-list").replaceChildren(
      ...onboardingSteps.slice(0, 4).map((item, index) => {
        const row = document.createElement("li");
        row.textContent = `${visibleProgress[index] ? "✓" : "○"} ${item.label}${visibleProgress[index] ? "" : " — not yet verified"}`;
        return row;
      }),
    );
  }

  private async copyCheck(): Promise<void> {
    const request = element<HTMLTextAreaElement>("#onboarding-check-request");
    try {
      await navigator.clipboard.writeText(request.value);
      this.message =
        "Copied. Select @Farol Dev in ChatGPT and send the check once.";
    } catch {
      request.focus();
      request.select();
      this.message = "Select the connection check above and copy it manually.";
    }
    this.port.render();
  }

  private async act(): Promise<void> {
    if (this.busy || element<HTMLButtonElement>("#onboarding-primary").disabled)
      return;
    const index = this.step;
    const facts = this.facts();
    const settings = this.port.settings();
    const selectedFolder = settings
      ? selectedOnboardingWorkspace(settings, this.folderChoice)
      : null;
    const selectedFolderReady =
      selectedFolder !== null &&
      facts.folder === "ready" &&
      settings?.setup.computer.verified?.workspaceId ===
        selectedFolder.workspaceId;
    const progress = onboardingProgressForFolderChoice(
      facts,
      selectedFolderReady,
    );
    if (progress[index] && index < 4) {
      this.select(index + 1);
      return;
    }
    if (index === 4 && !progress[4]) {
      this.restart();
      return;
    }
    this.busy = true;
    this.message = "";
    this.port.render();
    const stay = () => this.port.isActive() && this.step === index;
    try {
      if (index === 0) {
        const kind = this.signInOpened
          ? "chatgpt.verify"
          : "chatgpt.open-sign-in";
        const ok = await this.port.configure(
          { kind },
          kind === "chatgpt.verify"
            ? "Sign-in checked."
            : "Finish signing in, then choose Return to Setup in Farol.",
        );
        if (kind === "chatgpt.verify") this.signInOpened = false;
        else if (ok) this.signInOpened = true;
      } else if (index === 1) {
        const before = this.port.settings();
        let workspace = before
          ? selectedOnboardingWorkspace(before, this.folderChoice)
          : null;
        if (!workspace) {
          const oldIds = new Set(
            before?.computer.workspaces.map((entry) => entry.workspaceId),
          );
          if (
            !(await this.port.configure(
              { kind: "computer.add-workspace" },
              "Folder selected. Checking read-only access…",
            ))
          )
            return;
          const added =
            this.port
              .settings()
              ?.computer.workspaces.filter(
                (entry) => !oldIds.has(entry.workspaceId),
              ) ?? [];
          if (added.length !== 1) {
            this.message =
              "Folder selection changed. Review it before verifying.";
            return;
          }
          workspace = added[0]!;
          this.folderChoice = workspace.workspaceId;
        }
        if (workspace)
          await this.port.configure(
            {
              kind: "computer.verify-workspace",
              workspaceId: workspace.workspaceId,
            },
            "Read-only folder access checked.",
          );
      } else if (index === 2) {
        const tunnel = element<HTMLInputElement>("#onboarding-tunnel-id");
        const key = element<HTMLInputElement>("#onboarding-runtime-key");
        const result = await this.activation.run(
          {
            read: () => this.facts(),
            run: (command) => {
              if (command.kind === "connector.configure") key.value = "";
              return this.port.configure(
                command,
                command.kind === "connector.start"
                  ? "Tunnel active. Add its app in ChatGPT next."
                  : "Connection preparation completed.",
              );
            },
          },
          { tunnelId: tunnel.value, runtimeKey: key.value },
        );
        if (result.ok) {
          this.tunnelEdited = false;
          if (stay()) this.step = 3;
        } else this.message = failureMessages[result.reason];
      } else if (index === 3) {
        await this.port.configure(
          { kind: "connector.verify-app" },
          "Farol Dev verified through the selected ChatGPT app and Computer MCP receipt.",
        );
      } else if (index === 4) {
        const ok = await this.port.configure(
          { kind: "setup.progress", currentStep: "verify", dismissed: true },
          "Basic setup complete. Model and Agent tests remain separate.",
        );
        if (ok && stay() && onboardingProgress(this.facts())[4])
          this.port.openChat();
      }
    } catch {
      this.message =
        "The action did not return a confirmed result. Inspect the existing operation before repeating it.";
    } finally {
      this.busy = false;
      this.port.render();
    }
  }
}
