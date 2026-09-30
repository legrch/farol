import { activationObligations } from "./promotion-obligations.mjs";
const [userData, pid] = process.argv.slice(2);
if (!userData || !/^[1-9][0-9]*$/u.test(pid ?? "") || process.argv.length !== 4)
  throw new Error("UPDATE_OBLIGATION_ARGUMENTS_INVALID");
const report = await activationObligations(userData);
// Only this exact running app is expected. Every other existing obligation
// remains blocking; the caller holds the same admission lease through Quit.
const obligations = report.obligations.filter(
  (item) => item !== `APP_RUNNING:${pid}`,
);
process.stdout.write(
  JSON.stringify({
    drained:
      !obligations.length &&
      !report.unreadable.length &&
      !report.changed.length,
    obligationCount: obligations.length,
    unreadableCount: report.unreadable.length,
    changedCount: report.changed.length,
  }),
);
