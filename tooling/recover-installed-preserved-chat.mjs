// Explicit owner maintenance only: empty Chat, unchanged Computer journal.
// Retained read-only process reservations remain unresolved and cannot be replayed.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInstalledRecovery } from "./recover-installed-empty-chat.mjs";

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await runInstalledRecovery(true);
  } catch {
    process.stderr.write("INSTALLED_PRESERVED_RECOVERY_REFUSED_OR_UNKNOWN\n");
    process.exitCode = 1;
  }
}
