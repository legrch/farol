import path from "node:path";
import { TUNNEL_CLIENT } from "../apps/desktop/tunnel-client-contract.ts";
import {
  prepareTunnelClientInput,
  provisionTunnelClientInput,
} from "./tunnel-client-artifact.mjs";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--download") {
  await provisionTunnelClientInput(process.cwd());
} else if (args.length === 1 && args[0].startsWith("--source=")) {
  await prepareTunnelClientInput(
    process.cwd(),
    path.resolve(args[0].slice("--source=".length)),
  );
} else throw new Error("TUNNEL_CLIENT_INPUT_SOURCE_REQUIRED");
process.stdout.write(
  `Reviewed tunnel-client ${TUNNEL_CLIENT.version} input prepared.\n`,
);
