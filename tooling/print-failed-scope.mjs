// Print every non-passing suite of the scope reports under a directory, with
// the tail of its output, so a hosted failure is readable from the job log.
import fs from "node:fs";
import path from "node:path";

const root = process.argv[2];
const tail = (file, lines = 80) =>
  fs.existsSync(file)
    ? fs.readFileSync(file, "utf8").split("\n").slice(-lines).join("\n")
    : "(no output)";
for (const run of fs.existsSync(root) ? fs.readdirSync(root) : []) {
  const directory = path.join(root, run);
  const reportPath = path.join(directory, "report.json");
  if (!fs.existsSync(reportPath)) continue;
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  console.log(
    `${run}: ${report.status}` +
      (report.prerequisiteError ? ` (${report.prerequisiteError})` : "") +
      (report.scopeErrors?.length ? ` ${report.scopeErrors.join(", ")}` : ""),
  );
  for (const result of report.results ?? []) {
    if (result.status === "PASS") continue;
    console.log(`::group::${result.id} ${result.status}`);
    console.log(
      JSON.stringify({
        counts: result.counts,
        terminal: result.terminal,
        error: result.error,
      }),
    );
    for (const stream of ["stdout", "stderr"])
      console.log(
        `--- ${stream}\n` +
          tail(path.join(directory, `${result.id}.${stream}.log`)),
      );
    console.log("::endgroup::");
  }
}
