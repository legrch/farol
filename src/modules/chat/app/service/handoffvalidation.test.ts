import { describe, expect, it } from "vitest";
import type {
  HandoffContinue,
  HandoffMessage,
  HandoffRequest,
  HandoffTitleRequest,
  HandoffWorkspace,
} from "../port/handoff";
import {
  identifier,
  isDigest,
  isUuid,
  object,
  samePhysicalWorkspace,
  sameProject,
  titleName,
  sameWorkspace,
  validContinue,
  validMessage,
  validRequest,
  validTitle,
  validWorkspace,
} from "./handoffvalidation";

const REQUEST_ID = "5f7c2b0e-3a1d-4e8b-9c6a-0d4f1e2b3a45";
const DISPATCH = "6a7c2b0e-3a1d-4e8b-8c6a-0d4f1e2b3a46";

const request = (overrides: Partial<HandoffRequest> = {}): HandoffRequest => ({
  key: REQUEST_ID,
  workspaceId: "workspace_1",
  projectId: "project-1",
  message: "hello",
  model: "gpt-5.1/codex",
  ...overrides,
});

const message = (overrides: Partial<HandoffMessage> = {}): HandoffMessage => ({
  key: REQUEST_ID,
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

describe("isUuid", () => {
  it("accepts versions 1 to 8 with an RFC variant, in either case", () => {
    expect(isUuid(REQUEST_ID)).toBe(true);
    expect(isUuid(REQUEST_ID.toUpperCase())).toBe(true);
  });

  it("refuses other versions, variants and shapes", () => {
    expect(isUuid("5f7c2b0e-3a1d-0e8b-9c6a-0d4f1e2b3a45")).toBe(false);
    expect(isUuid("5f7c2b0e-3a1d-9e8b-9c6a-0d4f1e2b3a45")).toBe(false);
    expect(isUuid("5f7c2b0e-3a1d-4e8b-7c6a-0d4f1e2b3a45")).toBe(false);
    expect(isUuid(`${REQUEST_ID}x`)).toBe(false);
    expect(isUuid("")).toBe(false);
  });
});

describe("sameProject", () => {
  it("compares root, device, inode and git directory", () => {
    const { project } = workspace();
    expect(sameProject(project, { ...project })).toBe(true);
    expect(sameProject(project, { ...project, root: "/x" })).toBe(false);
    expect(sameProject(project, { ...project, device: "9" })).toBe(false);
    expect(sameProject(project, { ...project, inode: "9" })).toBe(false);
    expect(
      sameProject(project, { ...project, gitCommonDirectory: "/x/.git" }),
    ).toBe(false);
  });
});

describe("isDigest", () => {
  it("accepts exactly 64 lowercase hex characters", () => {
    expect(isDigest("a".repeat(64))).toBe(true);
    expect(isDigest("a".repeat(63))).toBe(false);
    expect(isDigest("a".repeat(65))).toBe(false);
    expect(isDigest("A".repeat(64))).toBe(false);
    expect(isDigest(`${"a".repeat(63)}g`)).toBe(false);
  });
});

describe("titleName", () => {
  it("bounds length and refuses NUL and non-strings", () => {
    expect(titleName("ok")).toBe(true);
    expect(titleName("x".repeat(1000))).toBe(true);
    expect(titleName("x".repeat(1001))).toBe(false);
    expect(titleName("a\0b")).toBe(false);
    expect(titleName(null)).toBe(false);
  });
});

describe("validTitle", () => {
  const title = (
    overrides: Partial<HandoffTitleRequest> = {},
  ): HandoffTitleRequest => ({
    key: REQUEST_ID,
    dispatchId: DISPATCH,
    workspaceId: "workspace_1",
    projectId: "project-1",
    expectedTitle: null,
    title: "A title",
    ...overrides,
  });

  it("accepts a title with or without an expected one", () => {
    expect(validTitle(title())).toBe(true);
    expect(validTitle(title({ expectedTitle: "Old" }))).toBe(true);
  });

  it("refuses bad identifiers, blank, oversized and NUL titles", () => {
    expect(validTitle(title({ key: "nope" }))).toBe(false);
    expect(validTitle(title({ dispatchId: "nope" }))).toBe(false);
    expect(validTitle(title({ workspaceId: "a b" }))).toBe(false);
    expect(validTitle(title({ projectId: "" }))).toBe(false);
    expect(validTitle(title({ title: "   " }))).toBe(false);
    expect(validTitle(title({ title: "a\0" }))).toBe(false);
    expect(validTitle(title({ expectedTitle: "a\0" }))).toBe(false);
  });

  it("measures the byte length, not the character count", () => {
    expect(validTitle(title({ title: "é".repeat(500) }))).toBe(true);
    expect(validTitle(title({ title: "é".repeat(501) }))).toBe(false);
  });
});

describe("validContinue", () => {
  const next = (overrides: Partial<HandoffContinue> = {}): HandoffContinue => ({
    key: REQUEST_ID,
    dispatchId: DISPATCH,
    message: "go on",
    ...overrides,
  });

  it("accepts a distinct key and dispatch id with a bounded message", () => {
    expect(validContinue(next())).toBe(true);
    expect(validContinue(next({ message: "x".repeat(8_192) }))).toBe(true);
  });

  it("refuses an equal key and dispatch id in any case", () => {
    expect(validContinue(next({ dispatchId: REQUEST_ID }))).toBe(false);
    expect(validContinue(next({ dispatchId: REQUEST_ID.toUpperCase() }))).toBe(
      false,
    );
  });

  it("refuses blank, NUL and oversized messages", () => {
    expect(validContinue(next({ message: " \n" }))).toBe(false);
    expect(validContinue(next({ message: "a\0" }))).toBe(false);
    expect(validContinue(next({ message: "x".repeat(8_193) }))).toBe(false);
    expect(validContinue(next({ key: "nope" }))).toBe(false);
  });
});
