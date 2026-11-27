import path from "node:path";

import type { ComputerApproval } from "../../domain/execution-authority";
import { DEFAULT_DENIED_PATHS } from "./native-readonly-workspace";

type Workspace = ComputerApproval["workspaces"][number];
export type EffectiveWorkspace = Readonly<{
  root: string;
  access: "read" | "write";
  gitMetadata: Workspace["gitMetadata"];
  gitHistoryApproved: boolean;
}>;

/** Pure profile compilation from already-authorized, identity-checked scopes.
 * This function grants nothing by itself; dispatch still validates live authority.
 */
export function buildWorkspaceShellProfile(
  workspaces: readonly EffectiveWorkspace[],
  exclusions: readonly Readonly<{ path: string }>[],
  scratch: string,
  write: boolean,
  gitSettings: readonly string[],
): Readonly<{ source: string; parameters: string[] }> {
  const parameters: string[] = [];
  const reads: string[] = [];
  const writes: string[] = [];
  const denies: string[] = [];
  const parents = new Set<string>();
  const add = (label: string, value: string, collection: string[]) => {
    const key = `${label}_${collection.length}`;
    parameters.push("-D", `${key}=${value}`);
    collection.push(`(subpath (param "${key}"))`);
    for (
      let ancestor = path.dirname(value);
      ancestor !== "/";
      ancestor = path.dirname(ancestor)
    ) {
      parents.add(ancestor);
    }
  };
  for (const effective of workspaces) {
    add("ROOT", effective.root, reads);
    if (write && effective.access === "write")
      add("WRITE", effective.root, writes);
    if (effective.gitMetadata) {
      add("GIT_READ", effective.gitMetadata.gitDirectory, reads);
      add("GIT_READ", effective.gitMetadata.commonDirectory, reads);
      if (write && effective.access === "write") {
        add("GIT_WRITE", effective.gitMetadata.gitDirectory, writes);
        add("GIT_WRITE", effective.gitMetadata.commonDirectory, writes);
      }
    }
  }
  for (const setting of gitSettings) add("GIT_SETTINGS", setting, reads);
  for (const exclusion of exclusions ?? []) {
    // A command may cross effective task roots, but never an excluded path.
    add("DENY", exclusion.path, denies);
  }
  for (const workspace of workspaces) {
    for (const relative of DEFAULT_DENIED_PATHS) {
      if (relative === ".git" && workspace.gitHistoryApproved) continue;
      add("DENY", path.join(workspace.root, relative), denies);
    }
  }
  add("SCRATCH", scratch, reads);
  add("SCRATCH", scratch, writes);
  const parentRules = [...parents]
    .map((parent, index) => {
      const key = `PARENT_${index}`;
      parameters.push("-D", `${key}=${parent}`);
      return `(allow file-read-metadata (literal (param "${key}")))`;
    })
    .join("\n");
  const source = `(version 1)
(import "dyld-support.sb")
(deny default)
(allow process-exec)
(allow process-fork)
(allow signal (target self))
(allow sysctl-read)
(allow file-read*
  (subpath "/System")
  (subpath "/usr/lib")
  (subpath "/usr/bin")
  (subpath "/bin")
  (subpath "/usr/sbin")
  (subpath "/sbin")
  (subpath "/private/etc")
  (subpath "/opt/homebrew/bin")
  (subpath "/opt/homebrew/Cellar")
  (subpath "/opt/homebrew/lib")
  (subpath "/opt/homebrew/opt")
  (subpath "/usr/local/bin")
  (subpath "/usr/local/Cellar")
  (subpath "/usr/local/lib")
  (subpath "/usr/local/opt")
  (subpath "/Library/Developer/CommandLineTools")
  (subpath "/Applications/Xcode.app/Contents/Developer")
  (literal "/dev/null")
  (literal "/dev/urandom")
  ${reads.join("\n  ")})
(allow file-read-metadata (subpath "/dev"))
(allow file-write*
  (literal "/dev/null")
  (literal "/dev/stdout")
  (literal "/dev/stderr")
  (regex #"^/dev/fd/[0-9]+$")
  ${writes.join("\n  ")})
${denies.length ? `(deny file-read* file-write* ${denies.join(" ")})` : ""}
(deny file-read* file-write*
  (regex #"/(\\.env|\\.ssh|\\.aws|\\.gnupg|\\.git-credentials|\\.netrc|\\.pypirc)(/|$)"))
${workspaces.some((workspace) => !workspace.gitHistoryApproved) ? '(deny file-read* file-write* (regex #"/\\.git(/|$)"))' : ""}
${parentRules}
(deny network*)`;
  return { source, parameters };
}

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

export function buildShellEnvironment(
  gitSettings: readonly string[],
  homeDirectory: string,
  scratch: string,
  write: boolean,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    HOME: gitSettings.length > 0 ? homeDirectory : scratch,
    TMPDIR: scratch,
    PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: write ? "1" : "0",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
  };
  if (gitSettings.length > 0) {
    environment.XDG_CONFIG_HOME = path.join(homeDirectory, ".config");
  } else {
    environment.GIT_CONFIG_GLOBAL = "/dev/null";
  }
  return environment;
}

export function sandboxCommandArgs(
  sandbox: Readonly<{ source: string; parameters: string[] }>,
  command: string,
): string[] {
  return [
    ...sandbox.parameters,
    "-p",
    sandbox.source,
    "/bin/zsh",
    "-c",
    command,
  ];
}
