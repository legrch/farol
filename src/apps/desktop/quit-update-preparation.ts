import {
  NormalQuitApplyContextSchema,
  type NormalQuitUpdateReceipt,
  type NormalQuitUpdateRequest,
} from "../../modules/release/contract/installed-update";
import type { QuitPreparationContext } from "./quit-drain";

type QuitUpdateOwner = Readonly<{
  applyOnNormalQuit(
    request: NormalQuitUpdateRequest,
  ): Promise<NormalQuitUpdateReceipt>;
}>;

/** Joins the host's original Quit fence to the existing Release owner. */
export function createQuitUpdatePreparation(
  current: () => QuitUpdateOwner | null,
) {
  let active: QuitPreparationContext | null = null;
  return {
    async prepare(
      context: QuitPreparationContext,
    ): Promise<NormalQuitUpdateReceipt> {
      if (active !== null)
        return { status: "unknown", code: "UPDATE_QUIT_PREPARATION_PENDING" };
      if (!context.canStartEffect())
        return { status: "skipped", code: "UPDATE_QUIT_DEADLINE_EXPIRED" };
      active = context;
      try {
        const owner = current();
        if (!owner)
          return { status: "skipped", code: "UPDATE_QUIT_OWNER_UNAVAILABLE" };
        return await owner.applyOnNormalQuit({
          kind: "ordinary-quit",
          deadlineAt: context.deadlineAt,
        });
      } catch {
        // A failed reply cannot establish whether the original owner dispatched.
        return { status: "unknown", code: "UPDATE_QUIT_PREPARATION_UNKNOWN" };
      } finally {
        active = null;
      }
    },
    admissionAllowed(value: unknown): boolean {
      const request = NormalQuitApplyContextSchema.safeParse(value);
      return (
        request.success &&
        active !== null &&
        request.data.deadlineAt === active.deadlineAt &&
        active.canStartEffect()
      );
    },
    effectAllowed(): boolean {
      return active !== null && active.canStartEffect();
    },
  };
}
