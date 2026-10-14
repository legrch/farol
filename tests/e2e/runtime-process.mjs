import { execFileSync } from "node:child_process";

// Exact test-owned direct children, never an application-name cleanup selector.
export function selectRuntimeProcesses(table, mainPid, utilityPids = []) {
  if (
    !Number.isSafeInteger(mainPid) ||
    mainPid < 2 ||
    typeof table !== "string"
  )
    throw new Error("E2E_RUNTIME_PROCESS_INPUT_INVALID");
  const rows = table
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const match =
        /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/u.exec(
          line,
        );
      if (!match) throw new Error("E2E_RUNTIME_PROCESS_TABLE_INVALID");
      return {
        pid: Number(match[1]),
        parentPid: Number(match[2]),
        rssKiB: Number(match[3]),
        processStart: match[4],
        command: match[5],
      };
    });
  const primary = rows.filter((row) => row.pid === mainPid);
  if (primary.length !== 1) throw new Error("E2E_RUNTIME_PRIMARY_UNCONFIRMED");
  return rows
    .filter(
      (row) =>
        row.parentPid === mainPid &&
        (row.command.endsWith("/runtime.cjs") || utilityPids.includes(row.pid)),
    )
    .map((row) => ({
      ...row,
      mainPid,
      mainStart: primary[0].processStart,
      kind: row.command.endsWith("/runtime.cjs")
        ? "node-ipc"
        : "historical-utility",
    }));
}

function table() {
  return execFileSync(
    "/bin/ps",
    ["-ww", "-axo", "pid=,ppid=,rss=,lstart=,command="],
    {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 5000,
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    },
  );
}

export function readRuntimeProcessSnapshots(mainPid, utilityPids = []) {
  return selectRuntimeProcesses(table(), mainPid, utilityPids);
}

export async function runtimeProcessSnapshots(application) {
  const context = await application.evaluate(({ app }) => ({
    mainPid: process.pid,
    utilityPids: app
      .getAppMetrics()
      .filter(
        (metric) =>
          metric.type === "Utility" &&
          ["Farol Next Runtime", "Farol Dev Runtime"].includes(metric.name) &&
          metric.serviceName === "node.mojom.NodeService",
      )
      .map((metric) => metric.pid),
  }));
  if (context.mainPid !== application.process().pid)
    throw new Error("E2E_RUNTIME_PRIMARY_CHANGED");
  return readRuntimeProcessSnapshots(context.mainPid, context.utilityPids);
}

export async function runtimeProcessId(application) {
  const selected = await runtimeProcessSnapshots(application);
  if (selected.length !== 1)
    throw new Error(`E2E_RUNTIME_PROCESS_IDENTITY_INVALID:${selected.length}`);
  return selected[0].pid;
}

// Recheck the original parent, start stamp and command before fault injection.
// This is a bounded process witness, not arbitrary descendant cleanup proof.
export function killRuntimeProcess(snapshot) {
  const current = selectRuntimeProcesses(
    table(),
    snapshot.mainPid,
    snapshot.kind === "historical-utility" ? [snapshot.pid] : [],
  );
  const selected = current.find((row) => row.pid === snapshot.pid);
  if (
    !selected ||
    selected.processStart !== snapshot.processStart ||
    selected.mainStart !== snapshot.mainStart ||
    selected.command !== snapshot.command
  )
    throw new Error("E2E_RUNTIME_PROCESS_CHANGED");
  process.kill(snapshot.pid, "SIGKILL");
}
