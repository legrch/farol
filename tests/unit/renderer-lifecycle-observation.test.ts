import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { describe, expect, it } from "vitest";
import { observeRendererLifecycle } from "../../apps/desktop/renderer-lifecycle-observation";

const buildId = "a".repeat(64);
function fixture() {
  const emitter = new EventEmitter();
  const contents = emitter as EventEmitter &
    Pick<WebContents, "on" | "getOSProcessId">;
  contents.getOSProcessId = () => 123;
  const lines: string[] = [];
  observeRendererLifecycle(contents, buildId, (line) => lines.push(line));
  return {
    emitter,
    contents,
    lines,
    records: () =>
      lines.map((line) =>
        JSON.parse(line.slice("FAROL_RENDERER_OBSERVATION:".length)),
      ),
  };
}
describe("desktop renderer diagnostic boundary", () => {
  it("distinguishes a loaded renderer from a terminated one without asserting product readiness", () => {
    const f = fixture();
    f.emitter.emit("did-finish-load");
    f.emitter.emit(
      "render-process-gone",
      {},
      { reason: "crashed", exitCode: 134 },
    );
    expect(f.records()).toEqual([
      { schema: 1, buildId, event: "load-finished", rendererPid: 123 },
      {
        schema: 1,
        buildId,
        event: "process-gone",
        rendererPid: 123,
        reason: "crashed",
        exitCode: 134,
      },
    ]);
  });
  it("never discloses navigation URLs, preload paths, error messages or unrelated payload fields", () => {
    const f = fixture();
    const secret = "synthetic-secret-do-not-log";
    f.emitter.emit(
      "did-fail-load",
      {},
      -3,
      secret,
      `https://example.invalid/${secret}`,
      true,
    );
    f.emitter.emit(
      "preload-error",
      {},
      `/private/${secret}`,
      new Error(secret),
    );
    f.emitter.emit(
      "render-process-gone",
      { secret },
      { reason: secret, exitCode: 1, secret },
    );
    expect(f.lines.join("")).not.toContain(secret);
    expect(f.records()).toEqual([
      {
        schema: 1,
        buildId,
        event: "load-failed",
        rendererPid: 123,
        errorCode: -3,
        mainFrame: true,
      },
      { schema: 1, buildId, event: "preload-failed", rendererPid: 123 },
      {
        schema: 1,
        buildId,
        event: "process-gone",
        rendererPid: 123,
        reason: "unclassified",
        exitCode: 1,
      },
    ]);
  });
  it("does not invent an exit code or PID after observation loss", () => {
    const f = fixture();
    f.contents.getOSProcessId = () => {
      throw new Error("destroyed");
    };
    f.emitter.emit(
      "render-process-gone",
      {},
      { reason: "launch-failed", exitCode: NaN },
    );
    expect(f.records()).toEqual([
      {
        schema: 1,
        buildId,
        event: "process-gone",
        rendererPid: null,
        reason: "launch-failed",
        exitCode: null,
      },
    ]);
  });
  it("keeps diagnostics sink failure outside startup and process decisions", () => {
    const emitter = new EventEmitter() as EventEmitter &
      Pick<WebContents, "on" | "getOSProcessId">;
    emitter.getOSProcessId = () => 0;
    observeRendererLifecycle(emitter, buildId, () => {
      throw new Error("sink unavailable");
    });
    expect(() => emitter.emit("did-finish-load")).not.toThrow();
  });
  it("suppresses invalid diagnostic identity without changing startup or attaching observation", () => {
    const f = fixture();
    const before = f.emitter
      .eventNames()
      .map((event) => f.emitter.listenerCount(event));
    expect(() =>
      observeRendererLifecycle(f.contents, "not-a-build", () => {}),
    ).not.toThrow();
    expect(
      f.emitter.eventNames().map((event) => f.emitter.listenerCount(event)),
    ).toEqual(before);
  });
});
