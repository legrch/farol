import { describe, expect, it } from "vitest";
import { AgentDraftStore, EMPTY_AGENT_DRAFT } from "../../src/ui/agent-draft";

const typed = {
  mode: "subtree",
  objective: "Review the changed files",
  subtree: "packages/app/src",
  paths: "",
  exclusions: "node_modules",
};

describe("the Agent assignment the owner is typing", () => {
  it("survives a rebuild of the menu it was typed into", () => {
    // The defect: the task menu closes on an `open-settings` shell action
    // published when a ChatGPT route window closes — by a task's lifecycle
    // or a quit drain, not by the owner — and the typed subfolder path was
    // gone before Run Agent could be pressed. Nothing but the fields held
    // it. Now the renderer does.
    const store = new AgentDraftStore();
    store.select("task-1");
    store.capture("task-1", typed);
    expect(store.restore("task-1")).toEqual(typed);
    // Any number of rebuilds; the draft is not consumed by reading it.
    expect(store.restore("task-1")).toEqual(typed);
  });

  it("is dropped when the menu moves to a different task", () => {
    const store = new AgentDraftStore();
    store.select("task-1");
    store.capture("task-1", typed);
    store.select("task-2");
    expect(store.restore("task-2")).toBeNull();
    expect(store.held()).toBe(false);
  });

  it("is dropped when the assignment is submitted", () => {
    const store = new AgentDraftStore();
    store.select("task-1");
    store.capture("task-1", typed);
    store.clear();
    expect(store.restore("task-1")).toBeNull();
  });

  it("is dropped when the owner dismisses the menu", () => {
    const store = new AgentDraftStore();
    store.select("task-1");
    store.capture("task-1", typed);
    store.clear();
    expect(store.held()).toBe(false);
  });

  it("never hands one task's text to another", () => {
    const store = new AgentDraftStore();
    store.select("task-1");
    store.capture("task-1", typed);
    expect(store.restore("task-2")).toBeNull();
  });

  it("ignores a capture addressed to a task it is not showing", () => {
    // A keystroke that lands after the selection moved belongs to neither
    // task; it must not become the new task's draft.
    const store = new AgentDraftStore();
    store.select("task-1");
    store.capture("task-2", typed);
    expect(store.restore("task-1")).toBeNull();
  });

  it("selecting the same task again keeps the draft", () => {
    // renderTaskMenu and openTaskMenu both run repeatedly for one task; a
    // redundant select must not be a clear.
    const store = new AgentDraftStore();
    store.select("task-1");
    store.capture("task-1", typed);
    store.select("task-1");
    expect(store.restore("task-1")).toEqual(typed);
  });

  it("holds nothing until the owner types", () => {
    const store = new AgentDraftStore();
    store.select("task-1");
    expect(store.restore("task-1")).toBeNull();
    expect(store.held()).toBe(false);
  });

  it("keeps its own copy of what it was handed", () => {
    const store = new AgentDraftStore();
    store.select("task-1");
    const mutable = { ...typed };
    store.capture("task-1", mutable);
    mutable.subtree = "somewhere/else";
    expect(store.restore("task-1")?.subtree).toBe("packages/app/src");
  });

  it("names the defaults the fields fall back to", () => {
    expect(EMPTY_AGENT_DRAFT).toEqual({
      mode: "workspace",
      objective: "",
      subtree: "",
      paths: "",
      exclusions: "",
    });
  });
});
