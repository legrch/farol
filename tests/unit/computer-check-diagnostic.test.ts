import { describe, expect, it, vi } from "vitest";
import {
  computerCheckDiagnostic,
  reportComputerCheckDiagnostic,
  refuseComputerSettingsList,
} from "../../src/apps/desktop/computer-check-diagnostic";

describe("content-free Computer check diagnostics", () => {
  it("captures the list refusal before diagnostics and ignores a throwing code getter", () => {
    const error = Object.defineProperty(
      new Error("private diagnostic"),
      "code",
      {
        get() {
          throw new Error("getter must not run");
        },
      },
    );
    expect(refuseComputerSettingsList(error, vi.fn(), "owned-action")).toEqual({
      ok: false,
      code: "WORKSPACE_READ_FAILED",
    });
  });
  it("diagnostic proxy traps and sinks cannot change the captured list outcome", () => {
    const failure = { code: "WORKSPACE_PATH_REFUSED", cause: null };
    const error = new Proxy(failure, {
      getOwnPropertyDescriptor(target, property) {
        if (property === "cause") target.code = "WORKSPACE_NOT_FOUND";
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    const result = refuseComputerSettingsList(
      error,
      () => {
        failure.code = "AUTHORITY_PATH_DENIED";
        throw new Error("sink failed");
      },
      "owned-action",
    );
    expect(result).toEqual({ ok: false, code: "WORKSPACE_PATH_REFUSED" });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(
      refuseComputerSettingsList(revoked.proxy, vi.fn(), "owned-action"),
    ).toEqual({ ok: false, code: "WORKSPACE_READ_FAILED" });
  });
  it.each([
    "computer_publication_unavailable",
    "WORKSPACE_RACE_DETECTED",
    "AUTHORITY_PATH_DENIED",
    "WORKSPACE_ROOT_CHANGED",
  ])("retains the classified Go cause %s", (code) => {
    expect(
      computerCheckDiagnostic("go-settings-list", {
        code,
        message: "private payload",
      }),
    ).toEqual({ stage: "go-settings-list", cause: code });
  });
  it("keeps begin/confirm stop distinct and retains only a classified native errno", () => {
    const failure = new Error("COMPUTER_MCP_LIFECYCLE_UNVERIFIED", {
      cause: { code: "EPERM", path: "/private/file", message: "secret" },
    });
    expect(computerCheckDiagnostic("confirm-stop", failure)).toEqual({
      stage: "confirm-stop",
      cause: "COMPUTER_MCP_LIFECYCLE_UNVERIFIED",
      nativeCode: "EPERM",
    });
    expect(computerCheckDiagnostic("begin-stop", failure).stage).toBe(
      "begin-stop",
    );
  });
  it.each([
    new Error("credential/path/raw exception"),
    { code: "PRIVATE_CREDENTIAL" },
    null,
    "secret",
  ])("does not disclose unclassified data", (error) => {
    expect(computerCheckDiagnostic("go-settings-list", error)).toEqual({
      stage: "go-settings-list",
      cause: "UNCLASSIFIED_FAILURE",
    });
  });
  it("never executes error getters and tolerates revoked proxies", () => {
    const getter = vi.fn(() => {
      throw new Error("must not execute");
    });
    const error = Object.defineProperties(
      {},
      {
        code: { get: getter },
        message: { get: getter },
        cause: { get: getter },
      },
    );
    expect(computerCheckDiagnostic("confirm-stop", error).cause).toBe(
      "UNCLASSIFIED_FAILURE",
    );
    expect(getter).not.toHaveBeenCalled();
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(
      computerCheckDiagnostic("go-settings-list", revoked.proxy).cause,
    ).toBe("UNCLASSIFIED_FAILURE");
  });
  it("bounds cyclic causes and ignores an unclassified native code", () => {
    const error: { code: string; cause?: unknown } = { code: "secret" };
    error.cause = error;
    expect(computerCheckDiagnostic("confirm-stop", error)).toEqual({
      stage: "confirm-stop",
      cause: "UNCLASSIFIED_FAILURE",
    });
  });
  it("ties the diagnostic to the original action without changing a refusal if the sink throws", () => {
    const sink = vi.fn();
    reportComputerCheckDiagnostic(
      sink,
      "settings:computer.check-folder:owned-workspace",
      "go-settings-list",
      { code: "AUTHORITY_PATH_DENIED" },
    );
    expect(JSON.parse(sink.mock.calls[0]![1])).toEqual({
      action: "settings:computer.check-folder:owned-workspace",
      stage: "go-settings-list",
      cause: "AUTHORITY_PATH_DENIED",
    });
    expect(() =>
      reportComputerCheckDiagnostic(
        () => {
          throw new Error("sink unavailable");
        },
        "computer.verify-workspace",
        "confirm-stop",
        null,
      ),
    ).not.toThrow();
  });
});
