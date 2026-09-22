// Re-export only production modules used by the DEV Route B real-host E2E.
// The companion script bundles this entry because the repository's normal
// extensionless TypeScript imports are resolved by the build and Vitest, not
// by Node's native ESM loader.
export { createCodexContextController } from "../../src/apps/desktop/codex-context-runtime";
export { launchCodexAppServer } from "../../src/apps/desktop/codex-app-server-process";
export { startCodexCallerRelay } from "../../src/apps/desktop/codex-caller-relay";
export { runCodexChatGptHostRoute } from "../../src/apps/desktop/codex-chatgpt-host-route";
export { probeCodexHost } from "../../src/apps/desktop/codex-host-probe";
export { discoverExecutables } from "../../src/apps/desktop/executable-discovery";
export {
  ROUTE_B_CHECK_PROMPT,
  runRouteBHostCheck,
} from "../../src/apps/desktop/route-b-host-check";
export {
  ROUTE_B_MODEL,
  startRouteBRuntime,
} from "../../src/apps/desktop/route-b-runtime";
