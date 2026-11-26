import { describe, expect, it } from "vitest";
import { applyRequest, restoreRequest } from "./request";

const d = (c: string) => c.repeat(64);
const source = { digest: d("a"), version: "1.2.3", buildId: d("b") };
const target = { digest: d("c"), version: "1.2.4", buildId: d("d") };
const operation = { operationId: "1".repeat(32), source, target };
const predecessor = {
  pid: 777,
  startedAt: "2026-01-01T00:00:00.000Z",
  quitDigest: d("e"),
  stateIdentity: { dev: "1", ino: "2" },
} as never;

describe("restoreRequest", () => {
  it("relaunches and names the operation, slot and drain pair", () => {
    expect(
      restoreRequest({
        action: "rollback",
        operation,
        installLocation: "shared",
        pid: 4242,
        processStart: "t0",
      }),
    ).toEqual({
      action: "rollback",
      ...operation,
      installLocation: "shared",
      drain: {
        status: "reconciled",
        acceptedSource: source.buildId,
        acceptedTarget: target.buildId,
      },
      pid: 4242,
      processStart: "t0",
      waitSeconds: 120,
      relaunch: true,
    });
  });
  it("adds the presentation only when one is given", () => {
    const input = {
      action: "recover" as const,
      operation,
      installLocation: "legacy" as const,
      pid: 1,
      processStart: "t0",
    };
    expect(restoreRequest(input)).not.toHaveProperty("relaunchPresentation");
    expect(
      restoreRequest({ ...input, presentation: "sidecar-only" }),
    ).toHaveProperty("relaunchPresentation", "sidecar-only");
  });
});

describe("applyRequest", () => {
  const input = {
    installLocation: "shared" as const,
    operationId: operation.operationId,
    source,
    target,
    quitApply: false,
    ownPid: 4242,
    processStart: "t0",
  };
  it("relaunches an ordinary restart by its own process", () => {
    expect(applyRequest(input)).toEqual({
      action: "apply",
      installLocation: "shared",
      operationId: operation.operationId,
      source,
      target,
      drain: {
        status: "reconciled",
        acceptedSource: source.buildId,
        acceptedTarget: target.buildId,
      },
      pid: 4242,
      processStart: "t0",
      waitSeconds: 120,
      relaunch: true,
    });
  });
  it("does not relaunch an install on Quit", () => {
    const request = applyRequest({
      ...input,
      quitApply: true,
      presentation: "sidecar-only",
    });
    expect(request.relaunch).toBe(false);
    expect(request).not.toHaveProperty("relaunchPresentation");
  });
  it("keeps the presentation for an ordinary restart", () => {
    expect(
      applyRequest({ ...input, presentation: "sidecar-only" }),
    ).toHaveProperty("relaunchPresentation", "sidecar-only");
  });
  it("names the closed predecessor and does not relaunch under supervision", () => {
    const request = applyRequest({
      ...input,
      supervisedPredecessor: predecessor,
      presentation: "sidecar-only",
    });
    expect(request).toMatchObject({
      pid: 777,
      relaunch: false,
      predecessor: {
        kind: "confirmed_closed",
        startedAt: "2026-01-01T00:00:00.000Z",
        lastQuitSha256: d("e"),
        stateIdentity: { dev: "1", ino: "2" },
      },
    });
    expect(request).not.toHaveProperty("relaunchPresentation");
  });
});
