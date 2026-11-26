import type { ProductSettings } from "../../../src/pkg/product-settings/contract";

// The pure settings transforms for this Mac as a whole: its name, the command
// authority the owner grants Computer, and the file-permission policy. They are
// machine-wide, not per folder, so they live apart from the approved-folder
// transforms. Each maps the current settings to the next value from an input
// the service has already validated; each predicate answers from settings alone
// whether the owner's choice already holds. None reads or writes a store, the
// delivery store or Go authority. The service keeps its single serialized
// writer: it parses the input, short-circuits an unchanged choice before any
// write, and runs the transform inside `mutate` or `commit`, which own
// revision admission, the Computer approval generation and persistence.
//
// Every change here moves `computer.generation` and withdraws the verification
// it was made under, so the owner re-checks Computer under the new authority.

export type ComputerCommands = ProductSettings["computer"]["commands"];
export type ComputerFilePolicy = "" | "approved-roots-v1";

// Naming This Mac asks for a fresh read check, or for a first folder.
export function withComputerRenamed(
  settings: ProductSettings,
  name: string,
): ProductSettings {
  return {
    ...settings,
    revision: settings.revision + 1,
    computer: {
      ...settings.computer,
      generation: settings.computer.generation + 1,
      name,
    },
    setup: {
      ...settings.setup,
      computer: {
        ...settings.setup.computer,
        reachable: "unknown",
        verified: null,
        needsAction:
          settings.computer.workspaces.length > 0
            ? "Verify read access after changing This Mac."
            : "Add a read-only workspace.",
        outcomeUnknown: false,
      },
    },
  };
}

export function computerCommandsUnchanged(
  settings: ProductSettings,
  commands: ComputerCommands,
): boolean {
  return settings.computer.commands === commands;
}

// A change of command authority withdraws every folder's Git history approval,
// which was granted under the previous authority.
export function withComputerCommands(
  settings: ProductSettings,
  commands: ComputerCommands,
): ProductSettings {
  const configured = settings.computer.workspaces.length > 0;
  return {
    ...settings,
    revision: settings.revision + 1,
    computer: {
      ...settings.computer,
      generation: settings.computer.generation + 1,
      commands,
      workspaces: settings.computer.workspaces.map((workspace) => ({
        ...workspace,
        gitHistoryApproved: false,
      })),
    },
    setup: {
      ...settings.setup,
      computer: {
        ...settings.setup.computer,
        configured,
        reachable: "unknown" as const,
        verified: null,
        needsAction: configured
          ? "Verify workspace access after changing command authority."
          : "Add a read-only workspace.",
        unavailable: null,
        outcomeUnknown: false,
      },
    },
  };
}

// A profile saved before the policy existed has none; that reads as "".
export function computerFilePolicyUnchanged(
  settings: ProductSettings,
  filePolicy: ComputerFilePolicy,
): boolean {
  return (settings.computer.filePolicy ?? "") === filePolicy;
}

// Existing profiles, restrictions and in-flight receipts are never rewritten.
export function withComputerFilePolicy(
  settings: ProductSettings,
  filePolicy: ComputerFilePolicy,
): ProductSettings {
  const configured = settings.computer.workspaces.length > 0;
  return {
    ...settings,
    revision: settings.revision + 1,
    computer: {
      ...settings.computer,
      generation: settings.computer.generation + 1,
      filePolicy,
    },
    setup: {
      ...settings.setup,
      computer: {
        ...settings.setup.computer,
        configured,
        reachable: "unknown" as const,
        verified: null,
        needsAction: configured
          ? "Verify folder access after changing file permissions."
          : "Add a folder.",
        unavailable: null,
        outcomeUnknown: false,
      },
    },
  };
}
