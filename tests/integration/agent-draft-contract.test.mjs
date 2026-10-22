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

function admissionHandler(source) {
  const start = source.indexOf(
    'required<HTMLButtonElement>("#new-task").addEventListener',
  );
  const end = source.indexOf(
    'required<HTMLButtonElement>("#task-menu-button").addEventListener',
    start,
  );
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

function functionBody(source, signature) {
  const start = source.indexOf(signature);
  expect(start, `${signature} is present`).toBeGreaterThan(-1);
  // The next top-level declaration ends it, and some of them are `async`.
  // Missing that made every row here fail on the slice rather than on what
  // it was asserting — a red for the wrong reason, which proves nothing.
  const ends = ["\nfunction ", "\nasync function ", "\nconst "]
    .map((marker) => source.indexOf(marker, start + 1))
    .filter((at) => at > start);
  expect(ends.length, `${signature} has a terminator`).toBeGreaterThan(0);
  return source.slice(start, Math.min(...ends));
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
    expect(source.slice(submit, submit + 900)).toContain(
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
      source.indexOf("window.farol.onShellAction("),
      source.indexOf("window.farol.onWindowState("),
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
      source.indexOf("window.farol.onShellAction("),
      source.indexOf("window.farol.onWindowState("),
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
      source.indexOf("window.farol.onShellAction("),
      source.indexOf("window.farol.onWindowState("),
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
      source.indexOf("window.farol.onShellAction("),
      source.indexOf("window.farol.onWindowState("),
    );
    expect(handler).toContain("if (provenance.eventId !== null)");
    expect(handler).toContain("handledShellActionIds.add(provenance.eventId)");
  });
});

describe("a layout pushed by the host cannot close an open overlay", () => {
  it("never writes shellOverlay from the pushed layout", async () => {
    // The dialog follows `shellOverlay` (one line: it closes whenever the
    // value leaves "task-menu"). Assigning that value from a host push made
    // main's stale mirror able to close a menu the renderer had just opened,
    // taking the Agent editor with it — no owner action, no shell action.
    const body = functionBody(
      await shell(),
      "function applyHostLayout(layout: z.infer<typeof ShellLayoutSchema>): void {",
    );
    expect(body).not.toContain("shellOverlay = layout.overlay");
    expect(body).not.toMatch(/shellOverlay\s*=/u);
  });

  it("adopts the layout through the one function that has no overlay in it", async () => {
    const body = functionBody(
      await shell(),
      "function applyHostLayout(layout: z.infer<typeof ShellLayoutSchema>): void {",
    );
    expect(body).toContain("hostLayoutUpdate(layout)");
  });

  it("still adopts section, task and sidebar from the push", async () => {
    // The fix must not stop main coordinating what it genuinely owns: which
    // section and task its native surfaces are laid out for.
    const body = functionBody(
      await shell(),
      "function applyHostLayout(layout: z.infer<typeof ShellLayoutSchema>): void {",
    );
    expect(body).toContain("section = ");
    expect(body).toContain("selectedTaskId = ");
    expect(body).toContain("sidebarOverlayOpen = ");
  });

  it("leaves a task change to the draft store's own rule", async () => {
    // A layout naming a different task still moves the selection, and the
    // store drops the draft on a task change exactly as before. No new
    // close path is added for it.
    const source = await shell();
    const body = functionBody(
      source,
      "function applyHostLayout(layout: z.infer<typeof ShellLayoutSchema>): void {",
    );
    expect(body).not.toContain("taskAgentDraft");
    expect(functionBody(source, "function openTaskMenu(): void {")).toContain(
      "taskAgentDraft.select(task.taskId)",
    );
  });
});

describe("a layout that moves nothing does not rebuild the menu", () => {
  it("renders only when something the renderer holds actually changed", async () => {
    // Measured: the push arrived 1.76 s after the sign-in outcome, carrying
    // the section and task already held, and landed mid-word — "notes" was
    // cut to "no". A rebuild between two keystrokes replaces the element the
    // rest of the word was addressed to, and restoring the value into a
    // fresh node is not the same as never having replaced it.
    const body = functionBody(
      await shell(),
      "function applyHostLayout(layout: z.infer<typeof ShellLayoutSchema>): void {",
    );
    expect(body).toContain("hostLayoutChanged(");
    expect(body).toContain("if (changed) render(false)");
    expect(body).not.toMatch(/^\s*render\(false\);$/mu);
  });
});

describe("a run can read the decision that was made", () => {
  it("reports every shell action's inputs and its decision, content-free", async () => {
    // A run that ends with the editor gone should say which input produced
    // that, rather than leave the decision inferred from the outcome.
    const source = await shell();
    const handler = source.slice(
      source.indexOf("window.farol.onShellAction("),
      source.indexOf("window.farol.onWindowState("),
    );
    expect(handler).toContain("console.debug(");
    expect(handler).toContain('"farol.shell-action"');
    expect(handler).toContain('"farol.shell-decision"');
    // Every arrival is logged, not only the two the policy branch takes:
    // a `close-overlay` reaches closeOverlay(), which both closes the menu
    // and clears the draft, and used to leave no line at all.
    const arrival = handler.indexOf('"farol.shell-action"');
    const firstBranch = handler.indexOf(
      'parsed.data.action === "toggle-sidebar"',
    );
    expect(arrival).toBeGreaterThan(-1);
    expect(firstBranch).toBeGreaterThan(arrival);
    expect(handler).toMatch(/branch:/u);
    for (const field of [
      "eventId",
      "action",
      "source",
      "shellOverlay",
      "held",
      "draftTaskMatches",
      "draftHeld",
      "reason",
      "navigate",
    ]) {
      // `shellOverlay` is a shorthand property, so the key may be followed
      // by a comma rather than a colon.
      expect(handler, field).toMatch(new RegExp(`\\b${field}\\s*[,:]`, "u"));
    }
    // No field text, no labels, no paths: the line carries the shape of the
    // decision and nothing the owner typed.
    const start = handler.indexOf("console.debug(");
    expect(start).toBeGreaterThan(-1);
    const line = handler.slice(
      start,
      handler.indexOf("if (!decision.refreshReadiness)"),
    );
    expect(line).not.toContain("readAgentDraftFields");
    expect(line).not.toContain(".value");
    expect(line).not.toContain("objective");
  });
});

describe("the instrument cannot flood the thing it measures", () => {
  it("rate limits only the two lines that fire as often as a render", async () => {
    // A widened capture of the per-render stream hung a run for six minutes
    // with the application still alive. That was the instrument, not the
    // product, and an instrument that changes the subject is not one.
    const source = await shell();
    const render = functionBody(
      source,
      "function render(notify = true): void {",
    );
    expect(render).toContain("renderDuringMenu.admit()");
    expect(render).toContain("suppressed: admitted.suppressed");
    const tasks = functionBody(
      source,
      "function applyTasksState(state: ProductTasksState): void {",
    );
    expect(tasks).toContain("tasksStateDuringMenu.admit()");
  });

  it("leaves the per-event lines unthrottled, because they are rare", async () => {
    // One line per shell action, per decision, per overlay change and per
    // dialog close. Throttling those would lose the event the run is for.
    const source = await shell();
    for (const marker of [
      '"farol.shell-action"',
      '"farol.shell-decision"',
      '"farol.overlay"',
      '"farol.task-menu-close"',
    ]) {
      const at = source.indexOf(marker);
      expect(at, marker).toBeGreaterThan(-1);
      const before = source.slice(Math.max(0, at - 400), at);
      expect(before, marker).not.toContain(".admit()");
    }
  });

  it("gives a reopened menu its own first line", async () => {
    const source = await shell();
    const setter = functionBody(
      source,
      "function setShellOverlay(next: ShellOverlay): void {",
    );
    expect(setter).toContain("renderDuringMenu.reset()");
    expect(setter).toContain("tasksStateDuringMenu.reset()");
  });
});

describe("an awaited task admission cannot take the editor", () => {
  it("records the surface it was dispatched under", async () => {
    // The closer, decoded from a real run's frames: the New task handler's
    // await resolved 1.7 s later and closed whatever overlay was open,
    // because it was written as if the surface could not have changed.
    const source = await shell();
    const handler = admissionHandler(source);
    expect(handler).toContain("const overlayAtDispatch = shellOverlay;");
  });

  it("navigates only when the surface has not moved since", async () => {
    const source = await shell();
    const handler = admissionHandler(source);
    expect(handler).toContain(
      "completionMayNavigate(overlayAtDispatch, shellOverlay)",
    );
    const guard = handler.indexOf("completionMayNavigate(");
    const close = handler.indexOf('setShellOverlay("none")');
    expect(guard).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(guard);
  });

  it("still admits the task and says where it is", async () => {
    // Not navigating is not the same as losing the task: it is admitted,
    // the tabs show it, and the owner is told rather than left guessing.
    const source = await shell();
    const handler = admissionHandler(source);
    expect(handler).toContain("applyTasksState(parsed.data.state)");
    expect(handler).toContain("waiting in the task tabs");
  });
});

describe("the recorder can see the element, not only the state", () => {
  it("watches the dialog's parent for a replaced node", async () => {
    // A replaced <dialog> keeps `open` true while showing nothing, emits no
    // close event and changes no overlay value. It is the one shape that
    // leaves no trace in any of the other lines, so it needs its own.
    const source = await shell();
    expect(source).toContain("new MutationObserver(");
    expect(source).toContain('"farol.task-menu-node"');
    expect(source).toContain("sameNode: node === taskMenuNode");
    expect(source).toContain("watchTaskMenuNode();");
  });

  it("says whether the document's dialog is still the one it holds", async () => {
    const render = functionBody(
      await shell(),
      "function render(notify = true): void {",
    );
    expect(render).toContain("sameNode: dialog === taskMenuNode");
    expect(render).toContain("connected:");
    expect(render).toContain("open:");
  });

  it("names the renderer instance, so a replaced page is obvious", async () => {
    // Two instance ids in one run means the page or the window was
    // replaced and nothing in this module closed anything.
    const source = await shell();
    expect(source).toContain("const rendererInstance =");
    expect(source).toContain('"farol.shell-start"');
  });

  it("reports what a throttle swallowed before forgetting it", async () => {
    const setter = functionBody(
      await shell(),
      "function setShellOverlay(next: ShellOverlay): void {",
    );
    expect(setter).toContain("throttle.pending()");
    expect(setter).toContain("-final");
  });
});

describe("the dialog stack is recorded", () => {
  it("reports the dialog stack, so the topmost modal is provable", async () => {
    const source = await shell();
    expect(source).toContain("function topLayerCensus(");
    for (const field of [
      "openDialogs",
      "topmostModal",
      "taskMenuIsModal",
      "activeElement",
      "setupOpen",
    ]) {
      expect(source, field).toContain(`${field}:`);
    }
    // On both the render line and the decision line, so a run can see the
    // stack at the moment a decision was taken and at every rebuild.
    expect(source.match(/\.\.\.topLayerCensus\(\)/gu)?.length).toBe(2);
  });
});

describe("a submitted assignment leaves nothing stale to send again", () => {
  it("clears the fields with the store, not the store alone", async () => {
    // The store clears on submit and the menu stays open, so the fields
    // kept the text. A second press then had `held() === false`, which is
    // the one condition the authority check is gated on — so it skipped the
    // check and would send on a grant that may have moved since. Clearing
    // both leaves the objective empty, which the existing prerequisite
    // already refuses by name and disables the control for.
    const source = await shell();
    const submit = source.indexOf('"Agent assignment admitted."');
    expect(submit).toBeGreaterThan(-1);
    const after = source.slice(submit, submit + 900);
    expect(after).toContain("taskAgentDraft.clear()");
    expect(after).toContain("writeAgentDraftFields(EMPTY_AGENT_DRAFT)");
  });

  it("keeps the authority check for a draft that is still held", async () => {
    const source = await shell();
    const guard = source.lastIndexOf(
      "agentAuthorityUnchanged(",
      source.indexOf('"Agent assignment admitted."'),
    );
    expect(guard).toBeGreaterThan(-1);
    expect(source.slice(guard - 200, guard)).toContain("taskAgentDraft.held()");
  });
});
