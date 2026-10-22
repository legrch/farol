import fs from "node:fs";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { parse } from "@babel/parser";
import { describe, expect, it, vi } from "vitest";
import { ProductConfigurationCommandSchema } from "../../src/pkg/product-settings/contract.ts";

// Run the production host case with controlled mechanics. No Electron, app,
// credential store, provider, task, network or shared build output is used.
const source = fs.readFileSync("src/apps/desktop/main.ts", "utf8");
const tree = parse(source, { sourceType: "module", plugins: ["typescript"] });
let branch;
function visit(node) {
  if (
    node.type === "SwitchCase" &&
    node.test?.value === "chatgpt.present-browser"
  )
    branch = source.slice(node.start, node.end);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) if (child?.type) visit(child);
    } else if (value?.type) visit(value);
  }
}
visit(tree);
if (!branch) throw new Error("CHATGPT_PRESENT_CASE_MISSING");

function harness() {
  const snapshot = { status: "error", error: "SETTINGS_READ_FAILED" };
  const context = {
    command: { kind: "chatgpt.present-browser" },
    embeddedBrowserEnabled: vi.fn(() => true),
    chatGptRoute: {
      open: vi.fn(async () => ({ status: "opened" })),
      retryFailedOpen: vi.fn(),
    },
    chatGptTaskAdmission: false,
    connectorTaskAdmission: false,
    chatGptSignInOpenGeneration: null,
    productTasksState: vi.fn(() => ({ tasks: [] })),
    configuration: { snapshot: vi.fn(() => snapshot) },
    browserHomeSurfaceOpen: false,
    section: "home",
    setupOpen: true,
    applyLayout: vi.fn(),
    publishLayout: vi.fn(),
    configurationFailure: (error) => ({ ok: false, error, snapshot }),
    ProductConfigurationResultSchema: { parse: (value) => value },
  };
  const handle = vm.runInNewContext(
    stripTypeScriptTypes(
      `async function handle() { switch(command.kind) { ${branch} } } handle`,
    ),
    context,
  );
  return { context, handle, snapshot };
}

describe("explicit ChatGPT presentation host mechanics", () => {
  it("accepts only the fixed command without a URL or provider request", () => {
    expect(
      ProductConfigurationCommandSchema.parse({
        kind: "chatgpt.present-browser",
      }),
    ).toEqual({ kind: "chatgpt.present-browser" });
    for (const extra of [
      { url: "https://example.invalid" },
      { prompt: "send" },
    ])
      expect(
        ProductConfigurationCommandSchema.safeParse({
          kind: "chatgpt.present-browser",
          ...extra,
        }).success,
      ).toBe(false);
  });

  it.each(["disabled", "missing"])(
    "refuses an unavailable route: %s",
    async (kind) => {
      const h = harness();
      if (kind === "disabled")
        h.context.embeddedBrowserEnabled.mockReturnValue(false);
      else h.context.chatGptRoute = null;
      expect(await h.handle()).toMatchObject({
        ok: false,
        error: "CHATGPT_ROUTE_UNAVAILABLE",
      });
      expect(h.context.applyLayout).not.toHaveBeenCalled();
    },
  );

  it.each(["chatGptTaskAdmission", "connectorTaskAdmission"])(
    "refuses conflicting host admission before presenting: %s",
    async (owner) => {
      const h = harness();
      h.context[owner] = true;
      expect(await h.handle()).toMatchObject({
        ok: false,
        error: "CHATGPT_TASK_IN_PROGRESS",
      });
      expect(h.context.chatGptRoute.open).not.toHaveBeenCalled();
      expect(h.context.applyLayout).not.toHaveBeenCalled();
    },
  );

  it.each(["sign-in", "task"])(
    "retains the existing %s identity",
    async (kind) => {
      const h = harness();
      if (kind === "sign-in") h.context.chatGptSignInOpenGeneration = 4;
      else
        h.context.productTasksState.mockReturnValue({
          tasks: [{ id: "original-task" }],
        });
      expect(await h.handle()).toEqual({ ok: true, snapshot: h.snapshot });
      expect(h.context.chatGptRoute.open).not.toHaveBeenCalled();
      expect(h.context.chatGptRoute.retryFailedOpen).not.toHaveBeenCalled();
      expect(h.context.browserHomeSurfaceOpen).toBe(false);
    },
  );

  it("opens through the existing route exactly once without retry or task creation", async () => {
    const h = harness();
    expect(await h.handle()).toEqual({ ok: true, snapshot: h.snapshot });
    expect(h.context.chatGptRoute.open).toHaveBeenCalledTimes(1);
    expect(h.context.chatGptRoute.retryFailedOpen).not.toHaveBeenCalled();
    expect(h.context.section).toBe("home");
    expect(h.context.setupOpen).toBe(true);
    // Renderer navigation owns the destination. This command alone neither
    // changes it nor claims that a native document has been constructed.
    expect(h.context.browserHomeSurfaceOpen).toBe(false);
    expect(h.context.applyLayout).toHaveBeenCalledTimes(1);
    expect(h.context.publishLayout).not.toHaveBeenCalled();
  });

  it.each(["unreachable", "throw"])(
    "retains a truthful failed open without retry: %s",
    async (kind) => {
      const h = harness();
      if (kind === "throw")
        h.context.chatGptRoute.open.mockRejectedValue(new Error("lost"));
      else
        h.context.chatGptRoute.open.mockResolvedValue({
          status: "unreachable",
        });
      expect(await h.handle()).toMatchObject({
        ok: false,
        error: "CHATGPT_PAGE_UNREACHABLE",
      });
      expect(h.context.chatGptRoute.open).toHaveBeenCalledTimes(1);
      expect(h.context.chatGptRoute.retryFailedOpen).not.toHaveBeenCalled();
    },
  );

  it("does not restore an old layout when the original open completes after navigation", async () => {
    const h = harness();
    let settle;
    const pending = new Promise((resolve) => {
      settle = resolve;
    });
    h.context.chatGptRoute.open.mockReturnValue(pending);
    const original = h.handle();
    expect(h.context.section).toBe("home");
    h.context.section = "home";
    h.context.setupOpen = false;
    settle({ status: "opened" });
    expect((await original).ok).toBe(true);
    expect(h.context.section).toBe("home");
    expect(h.context.applyLayout).toHaveBeenCalledTimes(1);
    expect(h.context.publishLayout).not.toHaveBeenCalled();
  });
});
