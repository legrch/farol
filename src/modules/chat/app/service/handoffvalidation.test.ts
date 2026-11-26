import { describe, expect, it } from "vitest";
import type {
  HandoffMessage,
  HandoffRequest,
  HandoffWorkspace,
} from "../port/handoff";
import {
  identifier,
  object,
  samePhysicalWorkspace,
  sameWorkspace,
  validMessage,
  validRequest,
  validWorkspace,
} from "./handoffvalidation";

const KEY = "5f7c2b0e-3a1d-4e8b-9c6a-0d4f1e2b3a45";
const DISPATCH = "6a7c2b0e-3a1d-4e8b-8c6a-0d4f1e2b3a46";

const request = (overrides: Partial<HandoffRequest> = {}): HandoffRequest => ({
  key: KEY,
  workspaceId: "workspace_1",
  projectId: "project-1",
  message: "hello",
  model: "gpt-5.1/codex",
  ...overrides,
});

const message = (overrides: Partial<HandoffMessage> = {}): HandoffMessage => ({
  key: KEY,
  dispatchId: DISPATCH,
  workspaceId: "workspace_1",
  projectId: "project-1",
  message: "hello",
  model: "gpt-5.1",
  ...overrides,
});

const workspace = (
  overrides: Partial<HandoffWorkspace> = {},
): HandoffWorkspace => ({
  root: "/work/root",
  device: "1",
  inode: "2",
  gitCommonDirectory: "/work/root/.git",
  project: {
    root: "/work/root/app",
    device: "1",
    inode: "3",
    gitCommonDirectory: "/work/root/.git",
  },
  execution: { sandbox: "workspace-write", approvalPolicy: "on-request" },
  ...overrides,
});

describe("object and identifier", () => {
  it("accepts only plain objects", () => {
    expect(object({ a: 1 })).toEqual({ a: 1 });
    expect(object(null)).toBeNull();
    expect(object([])).toBeNull();
    expect(object("x")).toBeNull();
  });

  it("bounds identifier shape and length", () => {
    expect(identifier("abc_DEF-1")).toBe(true);
    expect(identifier("a".repeat(120))).toBe(true);
    expect(identifier("a".repeat(121))).toBe(false);
    expect(identifier("")).toBe(false);
    expect(identifier("a/b")).toBe(false);
    expect(identifier(7)).toBe(false);
  });
});

describe("validRequest", () => {
  it("accepts a well-formed request", () => {
    expect(validRequest(request())).toBe(true);
    expect(validRequest(request({ reasoningEffort: "high" }))).toBe(true);
  });

  it("refuses a malformed key, identifier, message, model or effort", () => {
    expect(validRequest(request({ key: "nope" }))).toBe(false);
    expect(validRequest(request({ workspaceId: "a b" }))).toBe(false);
    expect(validRequest(request({ projectId: "" }))).toBe(false);
    expect(validRequest(request({ message: "" }))).toBe(false);
    expect(validRequest(request({ message: "a\0b" }))).toBe(false);
    expect(validRequest(request({ message: "x".repeat(8_193) }))).toBe(false);
    expect(validRequest(request({ message: "é".repeat(4_097) }))).toBe(false);
    expect(validRequest(request({ model: "bad model" }))).toBe(false);
    expect(validRequest(request({ reasoningEffort: "a b" }))).toBe(false);
  });

  it("requires a model binding to agree with the request", () => {
    const binding = {
      selection: {
        harness: "codex",
        modelAlias: "sol-high",
        model: "gpt-5.1/codex",
        effort: "high",
      },
      configSha256: "a".repeat(64),
    };
    const bound = request({ reasoningEffort: "high", modelBinding: binding });
    expect(validRequest(bound)).toBe(true);
    expect(
      validRequest({
        ...bound,
        modelBinding: {
          ...binding,
          selection: { ...binding.selection, harness: "claude" },
        },
      }),
    ).toBe(false);
    expect(
      validRequest({
        ...bound,
        modelBinding: {
          ...binding,
          selection: { ...binding.selection, modelAlias: "Bad Alias" },
        },
      }),
    ).toBe(false);
    expect(
      validRequest({
        ...bound,
        modelBinding: {
          ...binding,
          selection: { ...binding.selection, model: "other" },
        },
      }),
    ).toBe(false);
    expect(validRequest({ ...bound, reasoningEffort: "low" })).toBe(false);
    expect(
      validRequest({
        ...bound,
        modelBinding: { ...binding, configSha256: "xyz" },
      }),
    ).toBe(false);
  });
});

describe("validMessage", () => {
  it("accepts a well-formed message and refuses a bad dispatch id", () => {
    expect(validMessage(message())).toBe(true);
    expect(validMessage(message({ dispatchId: "nope" }))).toBe(false);
    expect(validMessage(message({ key: "nope" }))).toBe(false);
    expect(validMessage(message({ message: "a\0" }))).toBe(false);
    expect(validMessage(message({ reasoningEffort: "!" }))).toBe(false);
  });
});

describe("validWorkspace", () => {
  it("accepts a coherent workspace", () => {
    expect(validWorkspace(workspace())).toBe(true);
  });

  it("refuses non-objects and missing or relative paths", () => {
    expect(validWorkspace(null)).toBe(false);
    expect(validWorkspace({})).toBe(false);
    expect(validWorkspace(workspace({ root: "relative" }))).toBe(false);
    expect(validWorkspace(workspace({ device: "" }))).toBe(false);
    expect(validWorkspace(workspace({ gitCommonDirectory: "git" }))).toBe(
      false,
    );
  });

  it("requires the project to share the git directory and a known policy", () => {
    const base = workspace();
    expect(
      validWorkspace({
        ...base,
        project: { ...base.project, gitCommonDirectory: "/elsewhere/.git" },
      }),
    ).toBe(false);
    expect(
      validWorkspace({
        ...base,
        execution: { ...base.execution, sandbox: "danger-full-access" },
      }),
    ).toBe(false);
    expect(
      validWorkspace({
        ...base,
        execution: { ...base.execution, approvalPolicy: "never" },
      }),
    ).toBe(false);
  });
});

describe("workspace identity", () => {
  it("ignores the execution policy for physical identity only", () => {
    const left = workspace();
    const right = workspace({
      execution: { sandbox: "read-only", approvalPolicy: "untrusted" },
    });
    expect(samePhysicalWorkspace(left, right)).toBe(true);
    expect(sameWorkspace(left, right)).toBe(false);
    expect(sameWorkspace(left, workspace())).toBe(true);
  });

  it("distinguishes every physical field", () => {
    const base = workspace();
    expect(samePhysicalWorkspace(base, workspace({ root: "/x" }))).toBe(false);
    expect(samePhysicalWorkspace(base, workspace({ inode: "9" }))).toBe(false);
    expect(
      samePhysicalWorkspace(
        base,
        workspace({ project: { ...base.project, inode: "9" } }),
      ),
    ).toBe(false);
  });
});
