import type { ConnectorVerificationBridge } from "./connector-verification.ts";

// A thin projection of an existing authenticated Go observation. This adds no
// health cache, authority owner, verification attempt, or workspace operation.
// Only trusted MCP composition supplies exposure; it is not caller input.
export async function observeConnectionStatus(
  verification: Pick<ConnectorVerificationBridge, "observe">,
  exposure: Readonly<{ workspaceMutations: boolean; processes: boolean }>,
  checkId?: string,
) {
  // Capture registration metadata before awaiting IO. Registration is not proof
  // of current command permission or of a successful exercise of that command.
  const capabilities = Object.freeze({
    fileReads: "registered_not_tested" as const,
    fileMutations:
      exposure.workspaceMutations === true
        ? ("registered_not_tested" as const)
        : ("not_registered" as const),
    shell:
      exposure.processes === true
        ? ("registered_not_tested" as const)
        : ("not_registered" as const),
    // The inspected Go MCP has no Task registration. Change this together with
    // the real Task producer/catalogue when that separate slice is integrated.
    tasks: "not_registered" as const,
  });
  // The real bridge validates exact context, binding, receipt digest and origin.
  // Let its original refusal/UNKNOWN propagate through the existing MCP run().
  // Go decides whether this call acknowledges an armed owner check. A call
  // without checkId (ChatGPT's cached schema) counts only after that check's
  // own Send was durably recorded.
  const state = await verification.observe(checkId);
  return Object.freeze({
    connection: "responding" as const,
    attachment:
      state.receipt || state.catalogueReceipt
        ? ("verified" as const)
        : ("not_checked" as const),
    verification: state,
    capabilities,
    newFileOrCommandTests: false as const,
  });
}
