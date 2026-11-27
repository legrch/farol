import type { OperationMetadata } from "../renderer/operations-contract";

// The host supplies an already authorized execution and exact backend context.
// ComputerBridge retains wire validation; Go owns policy and all operations.
export function operationTarget(input: {
  workspaceId?: string;
  relativePath?: string;
  relativeDirectory?: string;
  relativeCwd?: string;
  command?: string;
}): OperationMetadata["target"] {
  const command = input.command?.trim().split(/\s/u)[0];
  return {
    ...(input.workspaceId ? { workspace: input.workspaceId } : {}),
    ...((input.relativePath ?? input.relativeDirectory ?? input.relativeCwd)
      ? {
          relativePath:
            input.relativePath ?? input.relativeDirectory ?? input.relativeCwd,
        }
      : {}),
    ...(command && /^[A-Za-z0-9._-]{1,80}$/u.test(command) ? { command } : {}),
  };
}
