// Re-export surface for the esbuild bundle step in
// farol-model-codex-exec.e2e.mjs. Kept to plain re-exports so the bundled
// module is exactly the production files under test, nothing else. The
// Route B model constant is re-exported from its owner so the E2E asserts
// the very literal production uses, never a copy of it.
export { FarolModelRuntimeState } from "../../src/apps/desktop/farol-model-runtime-state";
export { FarolModelEndpoint } from "../../src/apps/desktop/farol-model-endpoint";
export {
  FAROL_MODEL_HOST_TUNING,
  applyFarolModelConfigBlock,
  applyFarolModelProviderSelection,
} from "../../src/apps/desktop/farol-model-config-block";
export { ROUTE_B_MODEL } from "../../src/apps/desktop/route-b-runtime";
