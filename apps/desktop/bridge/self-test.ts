import { randomUUID } from "node:crypto";
import { BridgeError, type Client } from "./client.ts";
import {
  validate,
  type ComputerAuthorityPublication,
  type ComputerSelfTestReport,
  type Context,
  type Json,
} from "./wire.ts";

export type SelfTestSelection = Readonly<{
  operationId: string;
  workspaceId: string;
  computerGeneration: string;
  planVersion: "1" | "2";
}>;
export type SelfTestObservation = Readonly<{
  selection: SelfTestSelection;
  report?: Readonly<ComputerSelfTestReport>;
  state: "observed" | "unknown";
}>;

// An unresolved original retains its identity and is observed only through
// the read method, never dispatched again. A settled run permits a new request.
export class SelfTestBridge {
  private pending = false;
  private unresolved: SelfTestSelection | undefined;
  private readonly context: Readonly<Context>;
  constructor(
    private readonly client: Pick<Client, "request">,
    context: Context,
    prior: "none" | SelfTestSelection,
  ) {
    if (!validate("Context", context))
      throw new BridgeError("refused", "invalid_core_context");
    this.context = Object.freeze({ ...context });
    if (prior !== "none") {
      if (!validate("ComputerSelfTestObserve", prior))
        throw new BridgeError("refused", "invalid_self_test_observation");
      this.unresolved = Object.freeze({ ...prior });
    }
  }

  async start(
    publication: ComputerAuthorityPublication,
    workspaceId: string,
  ): Promise<SelfTestObservation> {
    if (this.pending || this.unresolved)
      throw new BridgeError("refused", "self_test_unresolved");
    const body = { publication: { ...publication }, workspaceId };
    if (!validate("ComputerSelfTestStart", body))
      throw new BridgeError("refused", "invalid_self_test_request");
    const selection = Object.freeze({
      operationId: randomUUID(),
      workspaceId,
      computerGeneration: publication.generation,
      planVersion: "2" as const,
    });
    this.pending = true;
    const result = await this.request(
      "computer.selftest.start",
      body as unknown as Json,
      selection,
    );
    this.pending = false;
    if (result.state === "unknown" || result.report?.status === "unknown")
      this.unresolved = selection;
    return result;
  }

  async observe(input: SelfTestSelection): Promise<SelfTestObservation> {
    const selection = Object.freeze({ ...input });
    if (!validate("ComputerSelfTestObserve", selection))
      throw new BridgeError("refused", "invalid_self_test_observation");
    const result = await this.request(
      "computer.selftest.observe",
      selection as unknown as Json,
      selection,
    );
    if (
      !this.pending &&
      this.unresolved &&
      Object.keys(selection).every(
        (key) =>
          selection[key as keyof SelfTestSelection] ===
          this.unresolved?.[key as keyof SelfTestSelection],
      ) &&
      result.state === "observed" &&
      result.report?.status !== "unknown"
    )
      this.unresolved = undefined;
    return result;
  }

  private async request(
    method: "computer.selftest.start" | "computer.selftest.observe",
    body: Json,
    selection: SelfTestSelection,
  ): Promise<SelfTestObservation> {
    const id = randomUUID();
    const unknown = (): SelfTestObservation =>
      Object.freeze({ selection, state: "unknown" });
    try {
      const out = await this.client.request(method, body, {
        id,
        timeoutMs: 30000,
        ...(method === "computer.selftest.start"
          ? { operationId: selection.operationId }
          : {}),
      });
      if (
        !validate("Outcome", out) ||
        out.status !== "ok" ||
        out.requestId !== id ||
        out.context.profileId !== this.context.profileId ||
        out.context.backendGeneration !== this.context.backendGeneration ||
        (method === "computer.selftest.start"
          ? out.operationId !== selection.operationId
          : out.operationId !== undefined) ||
        out.code !== undefined ||
        !validate("ComputerSelfTestReport", out.data)
      )
        return unknown();
      const report = out.data as unknown as ComputerSelfTestReport;
      if (
        report.operationId !== selection.operationId ||
        report.workspaceId !== selection.workspaceId ||
        report.computerGeneration !== selection.computerGeneration ||
        (report.planVersion ?? "1") !== selection.planVersion
      )
        return unknown();
      if (report.status === "partial" && selection.planVersion === "2") {
        const names = [
          "scratch",
          "write",
          "edit",
          "mutation read",
          "catalogue",
          "bootstrap",
          "list",
          "read",
          "search",
          "cleanup",
          "shell",
          "shell cancel",
          ...(report.steps.length === 14 ? ["directory search"] : []),
          "git and hooks",
        ];
        const id = selection.operationId;
        const operations = [
          id,
          id + "-st2-write",
          id + "-st2-edit",
          id + "-st2-edit",
          id + "-st2-catalogue",
          id + "-st2-bootstrap",
          id + "-st2-list",
          id + "-st2-read",
          id + "-st2-search",
          id,
          id + "-st2-quick",
          id + "-st2-cancel",
        ];
        if (
          report.steps.length !== names.length ||
          report.steps.some(
            (step, index) =>
              step.name !== names[index] ||
              step.status !== (index < 12 ? "pass" : "not_tested") ||
              step.operationId !== operations[index],
          )
        )
          return unknown();
      }
      if (report.status === "partial" && selection.planVersion === "1") {
        const id = selection.operationId;
        const names = [
          "scratch",
          "write",
          "edit",
          "mutation read",
          "cleanup",
          "shell",
          "shell cancel",
          "workspace reads",
          "git and hooks",
        ];
        const operations = [
          id,
          id + "-st1-write",
          id + "-st1-edit",
          id + "-st1-edit",
          id,
          id + "-st1-quick",
          id + "-st1-cancel",
        ];
        if (
          report.steps.length !== names.length ||
          report.steps.some(
            (step, index) =>
              step.name !== names[index] ||
              step.status !== (index < 7 ? "pass" : "not_tested") ||
              step.operationId !== operations[index],
          )
        )
          return unknown();
      }
      if (report.status === "fail" && !validFailedReport(report, selection))
        return unknown();
      const copy = Object.freeze({
        ...report,
        steps: Object.freeze(
          report.steps.map((step) => Object.freeze({ ...step })),
        ),
      });
      return Object.freeze({ selection, report: copy, state: "observed" });
    } catch {
      return unknown();
    }
  }
}

function validFailedReport(
  report: ComputerSelfTestReport,
  selection: SelfTestSelection,
): boolean {
  const id = selection.operationId;
  const v2 = selection.planVersion === "2";
  const names = v2
    ? [
        "scratch",
        "write",
        "edit",
        "mutation read",
        "catalogue",
        "bootstrap",
        "list",
        "read",
        "search",
        "cleanup",
        "shell",
        "shell cancel",
      ]
    : [
        "scratch",
        "write",
        "edit",
        "mutation read",
        "cleanup",
        "shell",
        "shell cancel",
      ];
  const suffixes = v2
    ? [
        "",
        "-st2-write",
        "-st2-edit",
        "-st2-edit",
        "-st2-catalogue",
        "-st2-bootstrap",
        "-st2-list",
        "-st2-read",
        "-st2-search",
        "",
        "-st2-quick",
        "-st2-cancel",
      ]
    : [
        "",
        "-st1-write",
        "-st1-edit",
        "-st1-edit",
        "",
        "-st1-quick",
        "-st1-cancel",
      ];
  if (
    report.steps.length === 0 ||
    report.steps.length > names.length ||
    report.steps.some(
      (step, index) =>
        step.name !== names[index] || step.operationId !== id + suffixes[index],
    )
  )
    return false;
  const failure = report.steps.findIndex((step) => step.status === "fail");
  if (
    failure < 0 ||
    report.steps.slice(0, failure).some((step) => step.status !== "pass")
  )
    return false;
  if (failure === report.steps.length - 1) return true;
  return (
    v2 &&
    failure >= 4 &&
    failure <= 8 &&
    report.steps.length === 10 &&
    report.steps
      .slice(failure + 1, 9)
      .every((step) => step.status === "not_tested") &&
    ["pass", "fail"].includes(report.steps[9]?.status ?? "")
  );
}
