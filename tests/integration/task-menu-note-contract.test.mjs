import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

async function renderTaskMenuBody() {
  const source = await fs.readFile(path.join(root, "src/ui/shell.ts"), "utf8");
  const start = source.indexOf("function renderTaskMenu(): void {");
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("\nfunction ", start + 1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

// The renderer is a browser entry: it calls `start()` at module scope and the
// unit environment is `node`, so it cannot be imported and driven here. The
// repository's own way of pinning a fact about it is to assert on its source,
// as `watch-rail-product-contract` does — that is what this is.
describe("the task menu's sentence can always reach the DOM", () => {
  it("writes the note on the path that returns before the live panel", async () => {
    // The defect this pins: `renderTaskMenu` returns early when the selection
    // is empty or is not a live ChatGPT task, and the note used to be written
    // two hundred lines below that return. `runTaskMenuCommand` assigns the
    // selection from the command's own result and only then sets the success
    // sentence, so a command settling into either state set a sentence that
    // could never appear — and a wait for it could only expire, which is how
    // it reached us twice.
    const body = await renderTaskMenuBody();
    const guard = body.indexOf("if (!live || !task) {");
    expect(guard).toBeGreaterThan(-1);
    const guardEnd = body.indexOf("\n  }", guard);
    expect(guardEnd).toBeGreaterThan(guard);
    const guardBlock = body.slice(guard, guardEnd);
    expect(guardBlock).toContain("writeTaskMenuNote(");
  });

  it("uses one writer for the note, not a second copy in the guard", async () => {
    // Two inline writers would drift apart exactly the way the flag and its
    // sentence did elsewhere today.
    const body = await renderTaskMenuBody();
    expect(body).not.toContain('required<HTMLElement>("#task-menu-note")');
    expect(body.match(/writeTaskMenuNote\(/gu)?.length).toBe(2);
  });

  it("records which silence it was when the note is not written", async () => {
    const body = await renderTaskMenuBody();
    expect(body).toContain("taskMenuTrace.skipped(");
    expect(body).toContain('task ? "not-live" : "no-task"');
  });

  it("marks the menu-closed path, which also cannot show a sentence", async () => {
    const source = await fs.readFile(
      path.join(root, "src/ui/shell.ts"),
      "utf8",
    );
    const start = source.indexOf("async function runTaskMenuCommand(");
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("\nfunction ", start + 1));
    expect(body).toContain('taskMenuTrace.skipped("menu-closed")');
    expect(body).toContain("taskMenuTrace.dispatch(command.kind)");
    for (const outcome of ["ok", "refused", "invalid", "threw"]) {
      expect(body).toContain(`taskMenuTrace.settle("${outcome}")`);
    }
  });
});
