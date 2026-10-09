import fs from "node:fs";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { parse } from "@babel/parser";
import { describe, expect, it, vi } from "vitest";
import {
  ProductConfigurationCommandSchema,
  ProductConfigurationEvidenceSchema,
  ProductConfigurationResultSchema,
} from "../../src/pkg/product-settings/contract.ts";

// Actual host code with injected route mechanics. No browser, network, state
// writer, credential, provider or shared build output participates.
const source = fs.readFileSync("src/apps/desktop/main.ts", "utf8");
const tree = parse(source, { sourceType: "module", plugins: ["typescript"] });
let branch;
let returnCallback;
function visit(node) {
  if (
    node.type === "SwitchCase" &&
    node.test?.value === "chatgpt.observe-sign-in"
  )
    branch = source.slice(node.start, node.end);
  if (
    node.type === "FunctionDeclaration" &&
    node.id?.name === "recordChatGptSignInOutcome"
  )
    returnCallback = source.slice(node.start, node.end);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) if (child?.type) visit(child);
    } else if (value?.type) visit(value);
  }
}
visit(tree);
if (!branch || !returnCallback)
  throw new Error("SIGN_IN_STATUS_HOST_CODE_MISSING");
const buildId = "3".repeat(64);
const observationId = "11111111-1111-4111-8111-111111111111";
const binding = { documentGeneration: 7, sequence: 2 };
function harness(state = "authenticated") {
  const observation = { state, binding: state === "unknown" ? null : binding };
  const context = {
    command: { kind: "chatgpt.observe-sign-in", buildId, observationId },
    buildIdentity: { buildId },
    chatGptRoute: {
      observeSignInStatus: vi.fn(async () => observation),
      isCurrentSignInStatus: vi.fn(() => true),
      open: vi.fn(),
      observeAccount: vi.fn(),
    },
    quitInProgress: false,
    installedUpdateAdmission: false,
    configuration: {
      snapshot: vi.fn(() => ({
        status: "error",
        error: "SETTINGS_READ_FAILED",
      })),
      recordChatGptObservation: vi.fn(async () => ({ ok: true })),
    },
    ProductConfigurationResultSchema,
    activeDesktopIdentity: { chatGptPartition: "synthetic-partition" },
    runtimeEnvironment: "dev",
    setupOpen: true,
    section: "computer",
    publishShellAction: vi.fn(),
  };
  const handle = vm.runInNewContext(
    stripTypeScriptTypes(
      `async function handle() { switch(command.kind) { ${branch} } } handle`,
    ),
    context,
  );
  const returned = vm.runInNewContext(
    stripTypeScriptTypes(`${returnCallback}\nrecordChatGptSignInOutcome`),
    context,
  );
  return { context, observation, handle, returned };
}
describe("bounded Sign in status host disclosure", () => {
  it("admits only exact content-free input and refuses known status without binding", () => {
    const h = harness();
    expect(ProductConfigurationCommandSchema.parse(h.context.command)).toEqual(
      h.context.command,
    );
    expect(
      ProductConfigurationCommandSchema.safeParse({
        ...h.context.command,
        key: "synthetic",
      }).success,
    ).toBe(false);
    expect(
      ProductConfigurationEvidenceSchema.safeParse({
        kind: "chatgpt.sign-in-status",
        observationId,
        buildId,
        state: "authenticated",
        binding: null,
      }).success,
    ).toBe(false);
  });

  it.each(["authenticated", "signed_out", "unknown"])(
    "discloses %s without opening, account fetch or Settings write",
    async (state) => {
      const h = harness(state);
      expect(await h.handle()).toMatchObject({
        ok: true,
        evidence: {
          kind: "chatgpt.sign-in-status",
          observationId,
          buildId,
          ...h.observation,
        },
      });
      expect(h.context.chatGptRoute.observeSignInStatus).toHaveBeenCalledTimes(
        1,
      );
      expect(h.context.chatGptRoute.open).not.toHaveBeenCalled();
      expect(h.context.chatGptRoute.observeAccount).not.toHaveBeenCalled();
      expect(
        h.context.configuration.recordChatGptObservation,
      ).not.toHaveBeenCalled();
    },
  );

  it.each(["missing-route", "wrong-build"])(
    "observes no substitute for %s",
    async (kind) => {
      const h = harness();
      const original = h.context.chatGptRoute;
      if (kind === "missing-route") h.context.chatGptRoute = null;
      else h.context.command.buildId = "4".repeat(64);
      expect(await h.handle()).toMatchObject({
        ok: true,
        evidence: { state: "unknown", binding: null },
      });
      expect(original.observeSignInStatus).not.toHaveBeenCalled();
    },
  );

  it.each(["quit", "update", "replacement", "document", "throw"])(
    "does not disclose a late positive answer after %s",
    async (loss) => {
      const h = harness();
      let settle;
      const waiting = new Promise((resolve) => {
        settle = resolve;
      });
      const original = h.context.chatGptRoute;
      original.observeSignInStatus.mockReturnValue(waiting);
      const result = h.handle();
      if (loss === "quit") h.context.quitInProgress = true;
      if (loss === "update") h.context.installedUpdateAdmission = true;
      if (loss === "replacement") h.context.chatGptRoute = { ...original };
      if (loss === "document")
        original.isCurrentSignInStatus.mockReturnValue(false);
      if (loss === "throw")
        original.isCurrentSignInStatus.mockImplementation(() => {
          throw new Error("lost");
        });
      settle(h.observation);
      expect(await result).toMatchObject({
        ok: true,
        evidence: { state: "unknown", binding: null },
      });
      expect(
        h.context.configuration.recordChatGptObservation,
      ).not.toHaveBeenCalled();
    },
  );

  it("classifies a failed route read without exposing its detail", async () => {
    const h = harness();
    h.context.chatGptRoute.observeSignInStatus.mockRejectedValue(
      new Error("private-detail"),
    );
    const result = await h.handle();
    expect(result).toMatchObject({
      ok: true,
      evidence: { state: "unknown", binding: null },
    });
    expect(JSON.stringify(result)).not.toContain("private-detail");
  });

  it.each(["authenticated", "not_authenticated", "unknown"])(
    "the original sign-in return preserves uncertainty for %s without another observation",
    async (state) => {
      const h = harness();
      await h.returned(3, state);
      if (state === "unknown")
        expect(
          h.context.configuration.recordChatGptObservation,
        ).not.toHaveBeenCalled();
      else {
        expect(
          h.context.configuration.recordChatGptObservation,
        ).toHaveBeenCalledTimes(1);
        expect(
          h.context.configuration.recordChatGptObservation.mock.calls[0][1],
        ).toBe(true);
      }
      expect(h.context.chatGptRoute.observeSignInStatus).not.toHaveBeenCalled();
      expect(h.context.publishShellAction).toHaveBeenCalledExactlyOnceWith(
        "sign-in-returned",
        "auth-window-closed",
        3,
      );
    },
  );
});
