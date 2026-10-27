import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { guardDiagnosticPipes } from "../../src/apps/desktop/diagnostic-pipes";

it("does not crash when either diagnostic pipe closes", () => {
  const stdout = new PassThrough(),
    stderr = new PassThrough();
  guardDiagnosticPipes([stdout, stderr]);
  expect(() =>
    stdout.emit("error", Object.assign(new Error("closed"), { code: "EPIPE" })),
  ).not.toThrow();
  expect(() =>
    stderr.emit("error", Object.assign(new Error("closed"), { code: "EPIPE" })),
  ).not.toThrow();
});

it("does not hide other stream failures", () => {
  const stream = new PassThrough();
  guardDiagnosticPipes([stream]);
  const error = Object.assign(new Error("failure"), { code: "EIO" });
  expect(() => stream.emit("error", error)).toThrow(error);
});
