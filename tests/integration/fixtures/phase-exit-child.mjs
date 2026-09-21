// A lane process whose only outstanding work is an await that will never
// settle, and whose only timer is the unref'd budget guarding it.
//
// Node exits when nothing referenced remains, so the budget never fires and
// the wrapper never rejects: the process simply ends. That is the path a
// fake scheduler cannot prove anything about, and the one where the receipts
// still have to be truthful. Run by tests/integration/await-phases-exit.test.mjs.
import { openEvidenceAttempt } from "../../../tooling/evidence-attempt.mjs";
import { createPhaseRecorder } from "../../e2e/await-phases.mjs";

const [laneRoot, mode] = process.argv.slice(2);
const attempt = await openEvidenceAttempt(laneRoot, {
  lane: "development-build",
  input: { runner: { pid: process.pid } },
});
attempt.installProcessHandlers();
const recorder = createPhaseRecorder({
  sink: (line) => process.stdout.write(`${line}\n`),
});
attempt.trackPhases(() => recorder.snapshot());
process.stdout.write(`CHILD_ATTEMPT ${attempt.attemptId}\n`);

// One boundary that really completes, so the receipt has a last-completed to
// report and a finished step is shown not to hold the process open either.
await recorder.step("launch[demo/hidden].electron.launch", 600_000, () => true);

if (mode === "stalled") {
  // Never settles and references nothing: no socket, no timer, no handle.
  void recorder.step(
    "launch[demo/hidden].firstWindow",
    600_000,
    () => new Promise(() => {}),
  );
}
// Nothing else is scheduled. The process is expected to exit on its own.
