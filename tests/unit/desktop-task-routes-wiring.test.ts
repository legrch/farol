import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The ChatGPT route builders live in apps/desktop/task/route.ts and are tested
// there with injected ports. Nothing else checks which main-process state each
// port reads, so a swapped getter would pass every other test. This asserts the
// wiring as text; it executes nothing from main.ts.

const mainSource = path.resolve(
  import.meta.dirname,
  "../../src/apps/desktop/main.ts",
);

async function factoryBody(): Promise<{ source: string; body: string }> {
  const source = await readFile(mainSource, "utf8");
  const begin = source.indexOf("function taskRoutes() {");
  expect(begin).toBeGreaterThanOrEqual(0);
  const body = source
    .slice(begin, source.indexOf("\n}\n", begin) + 2)
    .replace(/\s+/g, " ");
  return { source, body };
}

describe("task routes wiring in main", () => {
  it("lends each main-process let as a late getter", async () => {
    const { source, body } = await factoryBody();
    for (const name of ["window", "chatGptHomeUrl", "chatGptE2eOrigin"])
      expect(body).toContain(`${name}: () => ${name},`);
    // The lets stay declared in main: their other readers are untouched.
    for (const declaration of [
      "let window: BrowserWindow | null = null;",
      "let chatGptHomeUrl = CHATGPT_HOME;",
      "let chatGptE2eOrigin: string | null = null;",
    ])
      expect(source).toContain(declaration);
    expect(source).toContain("let taskRoutesCache");
  });

  it("shares each const owner and main helper by reference", async () => {
    const { source, body } = await factoryBody();
    for (const name of [
      "managedChatGptRoutes",
      "liveTaskRegistry",
      "liveTaskConversationUrls",
      "activeDesktopIdentity",
      "channels",
      "displayProductName",
      "runtimeEnvironment",
      "persistLiveTaskState",
      "surfaceLiveTaskPersistenceFailure",
      "setLiveTaskLifecycle",
      "chatGptWindowPresentationOption",
      "liveChatGptSurfaceFactory",
    ]) {
      expect(body).toContain(` ${name},`);
      // A shared owner must stay a const, not become a lent `let`.
      expect(source).not.toMatch(new RegExp(`\\nlet ${name}\\b`));
    }
  });

  it("builds the real route, writes stderr unchanged and reads the real environment", async () => {
    const { body } = await factoryBody();
    expect(body).toContain(
      "openRoute: (options) => new ChatGptRoute(options),",
    );
    expect(body).toContain(
      "writeStderr: (text) => { process.stderr.write(text); },",
    );
    expect(body).toContain("env: process.env,");
  });

  it("keeps only thin wrappers in main, reaching the one lazily built instance", async () => {
    const { source } = await factoryBody();
    const wrapper = (header: string, call: string) => {
      const begin = source.indexOf(header);
      expect(begin, header).toBeGreaterThanOrEqual(0);
      expect(source.slice(begin, source.indexOf("\n}\n", begin) + 3)).toBe(
        `${header}\n  return taskRoutes().${call};\n}\n`,
      );
    };
    wrapper(
      "function createManagedChatGptRoute(options: ChatGptRouteOptions): ChatGptRoute {",
      "managed(options)",
    );
    wrapper(
      "function createLiveChatGptRoute(\n  taskId: string,\n  label: string,\n  initialUrl?: string,\n  routeBTask?: boolean,\n): ChatGptRoute {",
      "live(taskId, label, initialUrl, routeBTask)",
    );
    wrapper(
      "function createContextSummaryFallbackRoute(\n  binding: ContextBinding,\n  recoveredConversationUrl?: string,\n): ChatGptRoute {",
      "contextSummaryFallback(binding, recoveredConversationUrl)",
    );
    // None of the moved bodies is left behind.
    for (const fragment of [
      "FAROL_UPDATE_ADMISSION_DIAGNOSTIC",
      "FAROL_PROFILE_PREPARATION_DIAGNOSTIC",
      "farol-e2e-task",
      "recordConversationUrl",
      "recordTaskActivity",
      "Context recovery",
    ])
      expect(source).not.toContain(fragment);
  });
});
