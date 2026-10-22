// Use the existing bounded runner and Cloud prerequisite inventory.
import { runScope } from "./test-scopes.mjs";

process.exitCode = await runScope(["--scope=native", ...process.argv.slice(2)]);
