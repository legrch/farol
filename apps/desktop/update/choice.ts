import type { z } from "zod";
import type { AutomaticUpdatePreferences } from "./record";

// The records and views of the two durable update choices. Each builds or reads
// a value from what the caller holds: no file is read or written here, and the
// unconfirmed fences, the write order and the readback stay with the caller.

type Automatic = z.infer<typeof AutomaticUpdatePreferences>;
type Scope = "download-and-install" | undefined;

const AUTOMATIC_V1 = "farol.installed-automatic-update-preference/1";
const AUTOMATIC_V2 = "farol.installed-automatic-update-preference/2";

/** The automatic choice as the updater reads it for this update channel. */
export function automaticChoiceView(preference: Automatic, channel: string) {
  // The stable UI has one choice. A legacy download-only record cannot
  // leave hidden download/Quit effects enabled while that choice is OFF.
  if (channel === "github-stable" && preference.schema === AUTOMATIC_V1)
    return {
      status: "confirmed" as const,
      enabled: false,
      scope: "download-and-install" as const,
    };
  return {
    status: "confirmed" as const,
    enabled: preference.enabled,
    ...(preference.schema === AUTOMATIC_V2 ? { scope: preference.scope } : {}),
  };
}

/** The unvalidated automatic record a write request describes. */
export function automaticChoiceCandidate(enabled: boolean, scope: Scope) {
  return {
    schema: scope === "download-and-install" ? AUTOMATIC_V2 : AUTOMATIC_V1,
    enabled,
    ...(scope === undefined ? {} : { scope }),
  };
}

/** True when this channel or the prior record needs a scope the request lacks. */
export function automaticScopeRequired(
  channel: string,
  prior: Automatic,
  scope: Scope,
): boolean {
  return (
    (channel === "github-stable" || prior.schema === AUTOMATIC_V2) &&
    scope === undefined
  );
}

/** The write fence that precedes a download-and-install choice. */
export function automaticUnconfirmedRecord(enabled: boolean, scope: Scope) {
  return {
    schema: "farol.installed-automatic-update-unconfirmed/1",
    enabled,
    ...(scope === undefined ? {} : { scope }),
  };
}

/** The acknowledgement a confirmed automatic write reports. */
export function automaticConfirmation(enabled: boolean, scope: Scope) {
  return {
    status: "confirmed",
    enabled,
    ...(scope === undefined ? {} : { scope }),
  };
}

/** The unvalidated install-on-Quit record a write request describes. */
export function quitChoiceCandidate(enabled: boolean) {
  return {
    schema: "farol.installed-install-on-quit-preference/1",
    scope: "install-on-normal-quit",
    enabled,
  };
}

/** The write fence that precedes an install-on-Quit choice. */
export function quitUnconfirmedRecord(enabled: boolean) {
  return {
    schema: "farol.installed-install-on-quit-unconfirmed/1",
    enabled,
  };
}

/** The acknowledgement a confirmed install-on-Quit write reports. */
export function quitConfirmation(enabled: boolean) {
  return {
    status: "confirmed",
    scope: "install-on-normal-quit",
    enabled,
  };
}
