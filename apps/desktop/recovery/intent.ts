import type { ProfileLaunchBinding } from "../bridge/profile";

// Go's private value codec materializes omitted zero-valued identity fields.
// Only those four DTO defaults are added; every supplied value remains exact.
// This is wire comparison, not mutation settlement or recovery authority.
const DEFAULTS: Readonly<Record<string, unknown>> = {
  SessionID: "",
  TaskID: "",
  TaskEpoch: 0,
  ParticipantID: "",
};

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw Error("EMPTY_CHAT_RECOVERY_SELECTION_INVALID");
  return value as Record<string, unknown>;
}

function defaultIdentity(identity: Record<string, unknown>): void {
  for (const [key, zero] of Object.entries(DEFAULTS)) {
    if (!Object.hasOwn(identity, key)) identity[key] = zero;
    else if (
      typeof identity[key] !== typeof zero ||
      (key === "TaskEpoch" &&
        (!Number.isSafeInteger(identity[key]) || Number(identity[key]) < 0))
    )
      throw Error("EMPTY_CHAT_RECOVERY_SELECTION_INVALID");
  }
}

export function emptyRecoveryIntent(
  selectionInput: {
    readonly Mutations: readonly unknown[];
    readonly Preserved?: readonly unknown[];
  },
  profile: ProfileLaunchBinding,
): unknown {
  const selected = structuredClone(selectionInput);
  if (!Array.isArray(selected.Mutations))
    throw Error("EMPTY_CHAT_RECOVERY_SELECTION_INVALID");
  const mutations = selected.Mutations.map((value) => {
    const mutation = record(value);
    defaultIdentity(record(record(mutation.Binding).Identity));
    return mutation;
  });
  return {
    ...selected,
    Mutations: mutations,
    ...(selected.Preserved === undefined
      ? {}
      : {
          Preserved: selected.Preserved.map((value) => {
            const retained = record(value);
            defaultIdentity(record(retained.Identity));
            return retained;
          }),
        }),
    Profile: {
      ProfileID: profile.profileId,
      Root: profile.root,
      Device: Number(profile.device),
      Inode: Number(profile.inode),
    },
  };
}
