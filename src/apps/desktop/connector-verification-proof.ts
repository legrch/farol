import type { ComputerConnectorVerificationState } from "../../../apps/desktop/bridge/wire";

// The Go bridge validates identity, challenge and digest before this projection.
// Keep the two proof variants distinct from absent or ambiguous evidence.
export function connectorVerificationProof(
  state: ComputerConnectorVerificationState,
) {
  if (state.catalogueReceipt !== undefined && state.receipt !== undefined)
    return null;
  if (state.catalogueReceipt !== undefined)
    return { receipt: state.catalogueReceipt, workspaceId: null };
  return state.receipt === undefined
    ? null
    : { receipt: state.receipt, workspaceId: state.receipt.workspaceId };
}
