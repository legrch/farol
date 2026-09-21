import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

async function shell() {
  return fs.readFile(path.join(root, "src/ui/shell.ts"), "utf8");
}

function functionBody(source, signature) {
  const start = source.indexOf(signature);
  expect(start, `${signature} is present`).toBeGreaterThan(-1);
  const end = source.indexOf("\nfunction ", start + 1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

// `src/ui/shell.ts` is a browser entry that calls `start()` at module scope
// and the unit environment is `node`, so it cannot be imported and driven.
// The repository pins facts about it on its source, as
// `watch-rail-product-contract` does. The store's own behaviour is driven
// for real in `tests/unit/agent-draft.test.ts`.
describe("the Agent draft is held by the renderer, not by the fields", () => {
  it("restores the draft whenever the menu is rebuilt", async () => {
    // This is the assertion the fix exists for, and the one a mutant that
    // drops the restore turns red: without it a rebuilt menu shows whatever
    // the fields happen to contain, which after an unowned close is nothing.
    const body = functionBody(
      await shell(),
      "function renderTaskMenu(): void {",
    );
    expect(body).toContain("taskAgentDraft.restore(task.taskId)");
    expect(body).toContain("writeAgentDraftFields(");
  });

  it("restores before anything reads the fields for the assignment", async () => {
    // The delivered scope is read from the DOM. If the restore ran after
    // that read, the wire shape would be built from stale fields.
    const body = functionBody(
      await shell(),
      "function renderTaskMenu(): void {",
    );
    const restore = body.indexOf("taskAgentDraft.restore(");
    expect(restore).toBeGreaterThan(-1);
    // Everything that turns the fields into an assignment, or into the
    // reason one cannot be run, has to see the restored text.
    for (const read of [
      "productAgentScopeSelection()",
      "objective.value",
      "agentFieldPrerequisite(",
    ]) {
      const at = body.indexOf(read);
      expect(at, `${read} is read in renderTaskMenu`).toBeGreaterThan(-1);
      expect(restore, `restore precedes ${read}`).toBeLessThan(at);
    }
  });

  it("captures every field the owner can type into", async () => {
    const source = await shell();
    const start = source.indexOf("const captureAgentDraft =");
    expect(start).toBeGreaterThan(-1);
    const block = source.slice(start, start + 600);
    for (const field of [
      "#task-agent-objective",
      "#task-agent-scope",
      "#task-agent-subtree",
      "#task-agent-paths",
      "#task-agent-exclusions",
    ]) {
      expect(block).toContain(field);
    }
    expect(block).toContain("taskAgentDraft.capture(");
  });

  it("clears on a task change, a submit and the owner's own dismissal", async () => {
    const source = await shell();
    expect(functionBody(source, "function openTaskMenu(): void {")).toContain(
      "taskAgentDraft.select(task.taskId)",
    );
    const close = functionBody(source, "function closeOverlay(): void {");
    expect(close).toContain('if (shellOverlay === "task-menu")');
    expect(close).toContain("taskAgentDraft.clear()");
    const submit = source.indexOf('"Agent assignment admitted."');
    expect(submit).toBeGreaterThan(-1);
    expect(source.slice(submit, submit + 200)).toContain(
      "taskAgentDraft.clear()",
    );
  });

  it("applies every outcome, and makes only the navigation conditional", async () => {
    // This replaces an earlier assertion that the handler stayed untouched.
    // That one existed to keep a decision open — whether an action the owner
    // did not cause may close the menu — and the owner has since taken it:
    // background navigation must not tear down an editor holding a draft.
    // What must NOT become conditional is the outcome itself; a readiness
    // change still applies whoever sent it.
    const source = await shell();
    const handler = source.slice(
      source.indexOf("window.farolNext.onShellAction("),
      source.indexOf("window.farolNext.onWindowState("),
    );
    expect(handler).toContain("refreshSettingsAfterReturn()");
    expect(handler).toContain("chatGptSignInOpened = false");
    // Exactly one place decides navigation, and it is the policy's answer.
    expect(handler.match(/selectSection\("settings"\)/gu)?.length).toBe(1);
    expect(handler).toContain("if (decision.navigate)");
  });

  it("keeps the fields as the single source the assignment is built from", async () => {
    // The store feeds the fields; the command still reads the fields. That
    // is what keeps the delivered scope and excludedPaths byte-identical.
    const source = await shell();
    const scope = functionBody(
      source,
      "function productAgentScopeSelection(): ProductAgentScopeSelection | null {",
    );
    expect(scope).toContain('required<HTMLSelectElement>("#task-agent-scope")');
    expect(scope).not.toContain("taskAgentDraft");
  });
});

describe("a background shell action does not take the editor", () => {
  it("routes open-settings and sign-in-returned through the policy", async () => {
    // Both used to run `selectSection("settings")` unconditionally, which is
    // what took the editor and the draft's fields with it.
    const source = await shell();
    const handler = source.slice(
      source.indexOf("window.farolNext.onShellAction("),
      source.indexOf("window.farolNext.onWindowState("),
    );
    expect(handler).toContain("decideShellAction(");
    expect(handler).toContain("draftHeld:");
    expect(handler).toContain("source: parsed.data.source");
    expect(handler).toContain("currentAuthWindowGeneration");
    // Navigation happens only when the decision says so.
    const navigate = handler.indexOf("if (decision.navigate)");
    const select = handler.indexOf('selectSection("settings")');
    expect(navigate).toBeGreaterThan(-1);
    expect(select).toBeGreaterThan(navigate);
  });

  it("re-reads readiness for every outcome it does not prove duplicate", async () => {
    const source = await shell();
    const handler = source.slice(
      source.indexOf("window.farolNext.onShellAction("),
      source.indexOf("window.farolNext.onWindowState("),
    );
    expect(handler).toContain("if (!decision.refreshReadiness) return;");
    expect(handler).toContain("refreshSettingsAfterReturn()");
  });

  it("offers the return control instead of navigating", async () => {
    const source = await shell();
    expect(source).toContain(
      'required<HTMLButtonElement>("#task-menu-return")',
    );
    const body = functionBody(source, "function renderTaskMenu(): void {");
    expect(body).toContain("returnAction.hidden = !taskMenuReturnOffered");
    const html = await fs.readFile(
      path.join(root, "src/ui/shell.html"),
      "utf8",
    );
    expect(html).toContain('id="task-menu-return"');
    expect(html).toContain("hidden");
  });

  it("checks the grant the assignment was written under before sending it", async () => {
    // Text surviving a background event must not become a way to run
    // against a grant that has since changed.
    const source = await shell();
    const submit = source.indexOf('"Agent assignment admitted."');
    const guard = source.lastIndexOf("agentAuthorityUnchanged(", submit);
    expect(guard).toBeGreaterThan(-1);
    const block = source.slice(guard, submit);
    expect(block).toContain("AGENT_AUTHORITY_CHANGED");
    expect(block).toContain("return;");
  });

  it("only ever deduplicates an event that carried an id", async () => {
    const source = await shell();
    const handler = source.slice(
      source.indexOf("window.farolNext.onShellAction("),
      source.indexOf("window.farolNext.onWindowState("),
    );
    expect(handler).toContain("if (provenance.eventId !== null)");
    expect(handler).toContain("handledShellActionIds.add(provenance.eventId)");
  });
});
