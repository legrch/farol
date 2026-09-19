// Re-export surface for the esbuild bundle step in
// farol-model-codex-exec.e2e.mjs. Kept to plain re-exports so the bundled
// module is exactly the three production files under test, nothing else.
export { FarolModelRuntimeState } from "../../src/apps/desktop/farol-model-runtime-state";
export { FarolModelEndpoint } from "../../src/apps/desktop/farol-model-endpoint";
export { applyFarolModelConfigBlock } from "../../src/apps/desktop/farol-model-config-block";
