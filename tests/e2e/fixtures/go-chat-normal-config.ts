import path from "node:path";

const prefix = "--farol-go-chat-normal-config=";

function absoluteConfigPath(value: string): string {
  if (
    !value ||
    value.includes("\0") ||
    !path.isAbsolute(value) ||
    path.resolve(value) !== value
  )
    throw new Error("HARNESS_CONFIG_PATH_INVALID");
  return value;
}

export function configArgument(value: string): string {
  return prefix + absoluteConfigPath(value);
}

// Electron and its debugger insert flags before the entry script. A dedicated
// named option is the only config source; a positional flag is never read as a file.
export function configPath(arguments_: readonly string[]): string {
  const matches = arguments_.filter((value) => value.startsWith(prefix));
  if (matches.length !== 1 || arguments_.includes(prefix.slice(0, -1)))
    throw new Error("HARNESS_CONFIG_ARGUMENT_INVALID");
  return absoluteConfigPath(matches[0]!.slice(prefix.length));
}
