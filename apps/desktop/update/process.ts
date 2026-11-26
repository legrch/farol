import { ProcessStart } from "./record";
import type { HelperObservation } from "./decision";

// What a retained update helper's process looks like to a fresh owner. The
// `ps` read itself stays with its launch owner and arrives as a port; this
// file only classifies what that read returned. Only a clean `ps` absence
// (exit 1, empty stdout and stderr) proves the helper ended, and a changed or
// unreadable start time never does.

export type ProcessRead = (
  pid: number,
) => Promise<Readonly<{ stdout: string; stderr: string }>>;

export type RetainedHelper = Readonly<{
  pid: number;
  processStart: string | null;
}> | null;

export async function observeHelper(
  helper: RetainedHelper | undefined,
  read: ProcessRead,
): Promise<HelperObservation> {
  if (!helper) return "unknown";
  try {
    const { stdout, stderr } = await read(helper.pid);
    if (
      helper.processStart === null ||
      stderr ||
      !ProcessStart.safeParse(stdout.trim()).success
    )
      return "unknown";
    // A retained helper may have recorded ps under a legacy locale or TZ.
    // Different text does not prove PID reuse or process termination.
    return stdout.trim() === helper.processStart ? "live" : "unknown";
  } catch (error) {
    // Only the existing clean ps absence classification establishes termination.
    const result = error as {
      code?: unknown;
      stdout?: unknown;
      stderr?: unknown;
    } | null;
    return result?.code === 1 && result.stdout === "" && result.stderr === ""
      ? "ended"
      : "unknown";
  }
}
