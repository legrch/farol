import { productName } from "./harness-identity.ts";
const supportedNode = new Set(["24.20.0", "26.7.0"]);
const requiredNpm = "11.19.0";
const npmAgent = process.env.npm_config_user_agent ?? "";
const npmVersion = /^npm\/([^ ]+)/u.exec(npmAgent)?.[1] ?? null;

if (!supportedNode.has(process.versions.node) || npmVersion !== requiredNpm) {
  process.stderr.write(
    `${productName} toolchain mismatch: Node ${process.versions.node}, npm ${npmVersion ?? "unknown"}; ` +
      `expected Node ${[...supportedNode].join(" or ")} with npm ${requiredNpm}.\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `${productName} toolchain: Node ${process.versions.node}, npm ${npmVersion}.\n`,
  );
}
