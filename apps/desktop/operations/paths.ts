import path from "node:path";

/** Profile-local adapter storage shared by Desktop and its Go MCP process. */
export function operationsDirectory(userData: string): string {
  return path.join(userData, "farol-state", "operations");
}

/** The admitted Desktop lifecycle lives at
 * <userData>/farol-private/secure-mcp-connector/computer-authority.
 * Derive from that existing launch field; never accept a second store path. */
export function operationsDirectoryFromLifecycleRoot(
  lifecycleRoot: string,
): string {
  return operationsDirectory(
    path.dirname(path.dirname(path.dirname(lifecycleRoot))),
  );
}
