import { SelfTestCommandSchema } from "./renderer/self-test-contract.ts";
import type { DesktopGoCore } from "./go-core-host.ts";

// The IPC boundary does not create authority or interpret an unavailable
// observation as an empty history. It never retries an effect.
export async function runSelfTestCommand(
  core: () => DesktopGoCore | null,
  accepting: () => boolean,
  value: unknown,
): Promise<unknown> {
  const parsed = SelfTestCommandSchema.safeParse(value);
  if (
    !parsed.success ||
    (parsed.data.kind === "observe" &&
      parsed.data.workspaceId !== parsed.data.selection.workspaceId)
  )
    return { ok: false, code: "SELF_TEST_INVALID_REQUEST" };
  const selected = core();
  if (!selected || !accepting())
    return { ok: false, code: "SELF_TEST_UNAVAILABLE" };
  const input = parsed.data;
  try {
    if (input.kind === "history") {
      const history = await selected.selfTestHistory(input.workspaceId);
      if (core() !== selected || !accepting())
        return { ok: false, code: "SELF_TEST_UNAVAILABLE" };
      return { ok: true, kind: "history", history };
    }
    if (input.kind === "observe") {
      const observation = await selected.observeSelfTest(
        input.workspaceId,
        input.selection,
      );
      if (core() !== selected || !accepting())
        return {
          ok: true,
          kind: "observe",
          observation: { selection: input.selection, state: "unknown" },
        };
      return { ok: true, kind: "observe", observation };
    }
    const observation = await selected.startSelfTest(input.workspaceId);
    if (core() !== selected || !accepting())
      return {
        ok: true,
        kind: "start",
        observation: { selection: observation.selection, state: "unknown" },
      };
    return { ok: true, kind: "start", observation };
  } catch {
    if (input.kind === "observe")
      return {
        ok: true,
        kind: "observe",
        observation: { selection: input.selection, state: "unknown" },
      };
    if (input.kind === "start")
      return {
        ok: false,
        code: "SELF_TEST_START_UNCONFIRMED",
        selection: selected.pendingSelfTest(input.workspaceId),
      };
    return { ok: false, code: "SELF_TEST_UNAVAILABLE" };
  }
}
