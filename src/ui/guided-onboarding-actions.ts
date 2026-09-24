import { ProductConfigurationCommandSchema } from "../pkg/product-settings/contract";
import {
  GuidedActivation,
  type ActivationPort,
  type ActivationResult,
  type OnboardingFacts,
} from "./guided-onboarding";

export interface ConnectionDraft {
  readonly tunnelId: string;
  // A new value only. Never load a stored credential into the renderer.
  readonly runtimeKey: string;
}

export function connectionDraftChanged(
  facts: OnboardingFacts,
  draft: ConnectionDraft,
): boolean {
  return (
    draft.tunnelId.trim() !== (facts.tunnelId ?? "") || draft.runtimeKey !== ""
  );
}

export function firstIncompleteSetupStep(
  progress: readonly boolean[],
): number | null {
  const index = progress.slice(0, 4).findIndex((complete) => !complete);
  return index < 0 ? null : index;
}

export function onboardingPrerequisite(
  step: number,
  progress: readonly boolean[],
): number | null {
  // Pages remain open for inspection and editing. Their primary action takes
  // the owner to a missing prerequisite instead of becoming a disabled dead end.
  const prerequisites = step === 2 ? [0, 1] : step === 3 ? [0, 1, 2] : [];
  return prerequisites.find((index) => progress[index] !== true) ?? null;
}

// Share the remembered-step decision between the button label and its click.
export function completedStepAction(
  step: number,
  current: readonly boolean[],
  remembered: readonly boolean[],
): "continue" | "reconnect-and-continue" | null {
  if (step < 0 || step >= 4) return null;
  if (step === 2 && remembered[2] && !current[2] && !remembered[3])
    return "reconnect-and-continue";
  return current[step] || remembered[step] ? "continue" : null;
}

export function progressWithConnectionDraft(
  progress: readonly boolean[],
  changed: boolean,
): readonly boolean[] {
  return changed
    ? [progress[0] === true, progress[1] === true, false, false, false]
    : progress;
}

// Save is deliberately separate from Activate: a stored key is not evidence
// that the tunnel or ChatGPT can reach this computer. Invalid input never
// interrupts a working connection, and cancelling an editor calls no command.
export class GuidedCredentialSave {
  private active = false;

  async run(
    port: ActivationPort,
    values: ConnectionDraft,
  ): Promise<ActivationResult> {
    if (this.active) return { ok: false, reason: "busy" };
    this.active = true;
    try {
      const initial = port.read();
      if (!initial.available) return { ok: false, reason: "prerequisite" };
      if (initial.outcomeUnknown || initial.runtime === "outcome_unknown")
        return { ok: false, reason: "inspect-existing-operation" };
      const tunnelId = values.tunnelId.trim();
      // A replacement requires a new runtime key. Do not accidentally reuse a
      // credential for a different route or accept the displayed mask.
      if (
        values.runtimeKey === "" &&
        (!initial.credentialStored || tunnelId !== initial.tunnelId)
      )
        return { ok: false, reason: "new-key-required" };
      const parsed = ProductConfigurationCommandSchema.safeParse({
        kind: "connector.configure",
        tunnelId,
        runtimeKey: values.runtimeKey || null,
      });
      if (!parsed.success || values.runtimeKey.startsWith("sk-admin-"))
        return { ok: false, reason: "invalid-fields" };
      // Blank means keep the credential already stored for this exact tunnel.
      // No configuration write or interruption is needed for that choice.
      if (values.runtimeKey === "") return { ok: true };
      if (initial.runtime !== "stopped") {
        if (!(await port.run({ kind: "connector.stop" })))
          return { ok: false, reason: "command-failed" };
        const stopped = port.read();
        if (
          !stopped.available ||
          stopped.authority !== initial.authority ||
          stopped.connectionIdentity !== initial.connectionIdentity ||
          stopped.runtime !== "stopped" ||
          stopped.outcomeUnknown
        )
          return { ok: false, reason: "state-changed" };
      }
      if (!(await port.run(parsed.data)))
        return { ok: false, reason: "command-failed" };
      const saved = port.read();
      return saved.available &&
        saved.authority === initial.authority &&
        saved.runtime === "stopped" &&
        !saved.outcomeUnknown &&
        saved.tunnelId === tunnelId &&
        saved.credentialStored
        ? { ok: true }
        : { ok: false, reason: "state-changed" };
    } catch {
      return { ok: false, reason: "inspect-existing-operation" };
    } finally {
      this.active = false;
    }
  }
}

// An explicit Save and reconnect / Reconnect action. Typing in a field never
// calls this coordinator. Validation precedes stopping a working connection;
// each admitted command must return and its resulting state must be observed.
// A lost result ends the chain. There is no model send, implicit retry, or
// clearing of an unknown remote submission here.
export class GuidedConnectionUpdate {
  private active = false;
  private readonly activation = new GuidedActivation();

  async run(
    port: ActivationPort,
    values: ConnectionDraft,
    reconnect = false,
  ): Promise<ActivationResult> {
    if (this.active) return { ok: false, reason: "busy" };
    this.active = true;
    try {
      const initial = port.read();
      if (initial.outcomeUnknown || initial.runtime === "outcome_unknown")
        return { ok: false, reason: "inspect-existing-operation" };
      if (
        !initial.available ||
        initial.chat !== "ready" ||
        initial.folder !== "ready" ||
        !initial.hasFolder
      )
        return { ok: false, reason: "prerequisite" };
      const tunnelId = values.tunnelId.trim();
      if (
        values.runtimeKey === "" &&
        (!initial.credentialStored || tunnelId !== initial.tunnelId)
      )
        return { ok: false, reason: "new-key-required" };
      const parsed = ProductConfigurationCommandSchema.safeParse({
        kind: "connector.configure",
        tunnelId,
        runtimeKey: values.runtimeKey || null,
      });
      if (!parsed.success) return { ok: false, reason: "invalid-fields" };
      const changed = connectionDraftChanged(initial, values);
      if (
        !changed &&
        !reconnect &&
        initial.runtime === "ready" &&
        initial.runtimeCurrent
      )
        return { ok: true };
      if (initial.runtime !== "stopped") {
        if (!(await port.run({ kind: "connector.stop" })))
          return { ok: false, reason: "command-failed" };
        const stopped = port.read();
        if (
          !stopped.available ||
          stopped.authority !== initial.authority ||
          stopped.connectionIdentity !== initial.connectionIdentity ||
          stopped.tunnelId !== initial.tunnelId ||
          stopped.credentialStored !== initial.credentialStored ||
          stopped.chat !== "ready" ||
          stopped.folder !== "ready" ||
          stopped.runtime !== "stopped" ||
          stopped.outcomeUnknown
        )
          return { ok: false, reason: "state-changed" };
      }
      return await this.activation.run(port, {
        tunnelId,
        runtimeKey: values.runtimeKey,
      });
    } catch {
      return { ok: false, reason: "inspect-existing-operation" };
    } finally {
      this.active = false;
    }
  }
}

// A fresh remote check has its own owner click. Repair starts a new runtime
// and challenge; the old successful receipt is never reused or resent.
export class GuidedFreshAppVerification {
  private active = false;

  async run(port: ActivationPort): Promise<ActivationResult> {
    if (this.active) return { ok: false, reason: "busy" };
    this.active = true;
    try {
      const initial = port.read();
      if (initial.outcomeUnknown || initial.runtime === "outcome_unknown")
        return { ok: false, reason: "inspect-existing-operation" };
      if (
        !initial.available ||
        initial.chat !== "ready" ||
        initial.folder !== "ready" ||
        !initial.hasFolder ||
        !initial.client ||
        !initial.tunnelId ||
        !initial.credentialStored ||
        initial.runtime !== "ready" ||
        !initial.runtimeCurrent ||
        !initial.attachmentCurrent ||
        initial.verificationIdentity === null
      )
        return { ok: false, reason: "prerequisite" };

      if (!(await port.run({ kind: "connector.repair" })))
        return { ok: false, reason: "command-failed" };
      const prepared = port.read();
      if (
        !prepared.available ||
        prepared.authority !== initial.authority ||
        prepared.connectionIdentity !== initial.connectionIdentity ||
        prepared.chat !== "ready" ||
        prepared.folder !== "ready" ||
        prepared.runtime !== "ready" ||
        !prepared.runtimeCurrent ||
        prepared.outcomeUnknown ||
        prepared.attachmentCurrent ||
        prepared.verificationIdentity === null ||
        prepared.verificationIdentity === initial.verificationIdentity
      )
        return { ok: false, reason: "state-changed" };

      if (!(await port.run({ kind: "connector.verify-app" })))
        return { ok: false, reason: "command-failed" };
      const attached = port.read();
      return attached.available &&
        attached.authority === initial.authority &&
        attached.connectionIdentity === initial.connectionIdentity &&
        attached.verificationIdentity === prepared.verificationIdentity &&
        attached.runtime === "ready" &&
        attached.runtimeCurrent &&
        attached.attachmentCurrent &&
        !attached.outcomeUnknown
        ? { ok: true }
        : { ok: false, reason: "state-changed" };
    } catch {
      return { ok: false, reason: "inspect-existing-operation" };
    } finally {
      this.active = false;
    }
  }
}
