import { desktopIdentity } from "../../src/apps/desktop/desktop-environment.ts";
import { execFileSync } from "node:child_process";

function parseProcessTable(table, mainPid) {
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
  const seen = new Set();
  for (const row of rows) {
    if (
      !Number.isSafeInteger(row.pid) ||
      row.pid < 2 ||
      !Number.isSafeInteger(row.parentPid) ||
      !Number.isSafeInteger(row.rssKiB) ||
      seen.has(row.pid)
    )
      throw new Error("E2E_RUNTIME_PROCESS_TABLE_INVALID");
    seen.add(row.pid);
  }
  return rows;
}

// Exact test-owned direct children, never an application-name cleanup selector.
export function selectRuntimeProcesses(table, mainPid, utilityPids = []) {
  const rows = parseProcessTable(table, mainPid);
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

const processOptions = {
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
  timeout: 5000,
  env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
};
function noMatch(error) {
  return (
    error?.status === 1 &&
    error.signal === null &&
    error.stdout != null &&
    error.stderr != null &&
    String(error.stdout).trim() === "" &&
    String(error.stderr).trim() === ""
  );
}

// A parent-filtered PID query followed by exact-PID metadata only. No global
// table or application-name fallback. execute is a test-only observation seam;
// native callers use execFileSync. A negative sample is not a child Wait receipt.
function table(mainPid, execute = execFileSync) {
  if (!Number.isSafeInteger(mainPid) || mainPid < 2 || mainPid > 2147483647)
    throw new Error("E2E_RUNTIME_PROCESS_INPUT_INVALID");
  let listed;
  try {
    listed = execute("/usr/bin/pgrep", ["-P", String(mainPid)], processOptions);
  } catch (error) {
    if (!noMatch(error))
      throw new Error("E2E_RUNTIME_PROCESS_OBSERVATION_UNKNOWN", {
        cause: error,
      });
    listed = null;
  }
  const children = listed === null ? [] : String(listed).trim().split("\n");
  if (
    children.length > 256 ||
    children.some(
      (pid) =>
        !/^[1-9][0-9]*$/u.test(pid) ||
        !Number.isSafeInteger(Number(pid)) ||
        Number(pid) < 2 ||
        Number(pid) > 2147483647 ||
        Number(pid) === mainPid,
    ) ||
    new Set(children).size !== children.length
  )
    throw new Error("E2E_RUNTIME_PROCESS_TABLE_INVALID");
  const selected = [mainPid, ...children.map(Number)];
  let observed;
  try {
    observed = execute(
      "/bin/ps",
      [
        "-ww",
        "-p",
        selected.join(","),
        "-o",
        "pid=,ppid=,rss=,lstart=,command=",
      ],
      processOptions,
    );
  } catch (error) {
    if (noMatch(error)) return "";
    throw new Error("E2E_RUNTIME_PROCESS_OBSERVATION_UNKNOWN", {
      cause: error,
    });
  }
  const rows = parseProcessTable(observed, mainPid);
  if (rows.length === 0 || rows.some((row) => !selected.includes(row.pid)))
    throw new Error("E2E_RUNTIME_PROCESS_TABLE_INVALID");
  return observed;
}

export function readOwnedChildProcesses(mainPid, execute = execFileSync) {
  const rows = parseProcessTable(table(mainPid, execute), mainPid);
  const children = rows.filter((row) => row.parentPid === mainPid);
  if (children.length && !rows.some((row) => row.pid === mainPid))
    throw new Error("E2E_RUNTIME_PRIMARY_UNCONFIRMED");
  return children;
}

export function readRuntimeProcessSnapshots(mainPid, utilityPids = []) {
  return selectRuntimeProcesses(table(mainPid), mainPid, utilityPids);
}

export async function runtimeProcessSnapshots(application) {
  const context = await application.evaluate(
    ({ app }, runtimeNames) => ({
      mainPid: process.pid,
      utilityPids: app
        .getAppMetrics()
        .filter(
          (metric) =>
            metric.type === "Utility" &&
            runtimeNames.includes(metric.name) &&
            metric.serviceName === "node.mojom.NodeService",
        )
        .map((metric) => metric.pid),
    }),
    ["preview", "dev", "owner-preview"].map(
      (environment) => desktopIdentity(environment, "/").runtimeServiceName,
    ),
  );
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
    table(snapshot.mainPid),
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
