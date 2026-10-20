// Stronger event accounting for the bounded Go prototype, not execution authority.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { goCounts } from "../test-scopes.mjs";

const policy = JSON.parse(
  fs.readFileSync(
    new URL("./affected-go-policy.json", import.meta.url),
    "utf8",
  ),
);

export function focusedGoCounts(output, requiredPackages) {
  const admitted = new Map(policy.packages.map((row) => [row.path, row]));
  if (
    !Array.isArray(requiredPackages) ||
    !requiredPackages.length ||
    new Set(requiredPackages).size !== requiredPackages.length ||
    requiredPackages.some((name) => !admitted.has(name))
  )
    throw Error("FOCUSED_GO_PACKAGES_UNQUALIFIED");
  if (!output.endsWith("\n")) throw Error("FOCUSED_GO_STREAM_INCOMPLETE");
  const packages = new Map(
    requiredPackages.map((name) => [
      name,
      {
        started: false,
        terminal: false,
        runs: new Set(),
        terminals: new Map(),
      },
    ]),
  );
  for (const line of output.split("\n").filter(Boolean)) {
    const event = JSON.parse(line);
    const state = packages.get(event?.Package);
    if (!state || state.terminal)
      throw Error("FOCUSED_GO_UNEXPECTED_OR_LATE_EVENT");
    if (event.Action === "start" && !Object.hasOwn(event, "Test")) {
      if (state.started) throw Error("FOCUSED_GO_PACKAGE_START_DUPLICATE");
      state.started = true;
      continue;
    }
    if (!state.started) throw Error("FOCUSED_GO_PACKAGE_START_REQUIRED");
    if (Object.hasOwn(event, "Test")) {
      if (
        typeof event.Test !== "string" ||
        !event.Test ||
        state.terminals.has(event.Test)
      )
        throw Error("FOCUSED_GO_CASE_INVALID_OR_LATE");
      if (event.Action === "run") {
        if (state.runs.has(event.Test))
          throw Error("FOCUSED_GO_CASE_RUN_DUPLICATE");
        if (
          event.Test.includes("/") &&
          (!state.runs.has(event.Test.split("/")[0]) ||
            state.terminals.has(event.Test.split("/")[0]))
        )
          throw Error("FOCUSED_GO_PARENT_RUN_REQUIRED");
        state.runs.add(event.Test);
      } else {
        if (!state.runs.has(event.Test))
          throw Error("FOCUSED_GO_CASE_RUN_REQUIRED");
        if (["pass", "fail", "skip"].includes(event.Action))
          state.terminals.set(event.Test, event.Action);
        else if (!["output", "pause", "cont"].includes(event.Action))
          throw Error("FOCUSED_GO_CASE_ACTION_UNQUALIFIED");
      }
    } else if (["pass", "fail", "skip"].includes(event.Action)) {
      if (state.runs.size !== state.terminals.size)
        throw Error("FOCUSED_GO_CASE_TERMINAL_REQUIRED");
      const top = [...state.runs].filter((name) => !name.includes("/")).sort();
      if (
        JSON.stringify(top) !==
        JSON.stringify(admitted.get(event.Package).topLevelTests)
      )
        throw Error("FOCUSED_GO_TOP_LEVEL_MEMBERSHIP_MISMATCH");
      state.terminal = true;
    } else if (event.Action !== "output")
      throw Error("FOCUSED_GO_PACKAGE_ACTION_UNQUALIFIED");
  }
  if ([...packages.values()].some((state) => !state.terminal))
    throw Error("FOCUSED_GO_PACKAGE_TERMINAL_REQUIRED");
  const counts = goCounts(output, requiredPackages);
  return {
    ...counts,
    topLevelTests: requiredPackages.reduce(
      (n, name) => n + admitted.get(name).topLevelTests.length,
      0,
    ),
    reportedSuccess:
      counts.reportedSuccess && counts.failed === 0 && counts.skipped === 0,
    caseMembership: requiredPackages.flatMap((name) =>
      [...packages.get(name).terminals].map(([test, status]) => ({
        package: name,
        test,
        status,
      })),
    ),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const [mode, expected, ...extra] = process.argv.slice(2);
  if (mode !== "validate-go" || extra.length || !expected)
    throw Error("FOCUSED_GO_ARGUMENT_INVALID");
  const directory = "/workspace/_output/affected-iteration";
  const counts = focusedGoCounts(
    fs.readFileSync(directory + "/focused-go.stdout.log", "utf8"),
    JSON.parse(expected),
  );
  if (!counts.reportedSuccess) throw Error("FOCUSED_GO_INCOMPLETE_OR_FAILED");
  fs.writeFileSync(
    directory + "/focused-go.counts.json",
    JSON.stringify(counts),
    { flag: "wx", mode: 0o600 },
  );
}
