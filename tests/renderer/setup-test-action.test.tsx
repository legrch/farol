import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { mount, readySettings } from "./setup-fixture";
import { deferred } from "./fixture";

// Real renderer/controller; scripted IPC only, no provider Send or Go authority.
function pending() {
  const value = readySettings();
  value.setup.connect.outcomeUnknown = true;
  value.connectors.secureMcp.appVerificationPending = true;
  value.connectors.secureMcp.chatgptApp = {
    name: "Farol",
    tunnelId: "synthetic-tunnel",
    connectorGeneration: 1,
  };
  return value;
}

describe("step four primary action", () => {
  it("keeps one admitted request per mounted binding even on pre-submit refusal", async () => {
    const h = await mount({
      step: "attachment",
      value: pending(),
      signIn: "authenticated",
    });
    await h.confirmSignIn();
    expect(h.host.querySelector('input[type="checkbox"]')).toBeNull();
    expect(h.button("Test in ChatGPT")?.disabled).toBe(false);
    h.reply(() => ({
      ok: false,
      error: "CHATGPT_COMPOSER_DRAFT_PRESENT",
      snapshot: h.configuration(),
    }));
    await h.click("Test in ChatGPT");
    await h.navigate("attachment");
    expect(h.button("Test in ChatGPT")?.disabled).toBe(true);
    expect(h.configuration().settings.setup.connect.outcomeUnknown).toBe(true);
    expect(
      vi
        .mocked(h.f.api.configure)
        .mock.calls.filter(([c]) => c.kind === "connector.verify-separate-app"),
    ).toHaveLength(1);
  });
  it.each(["missing", "unknown", "refused"])(
    "keeps exactly one footer Test visible for %s prerequisites",
    async (state) => {
      const h = await mount({
        step: "attachment",
        ...(state === "missing" ? {} : { value: pending() }),
      });
      if (state === "refused") {
        h.reply(() => ({
          ok: false,
          error: "CONNECTOR_ATTACHMENT_NOT_FOUND",
          snapshot: h.configuration(),
        }));
        await h.click("Refresh status");
      }
      const footer = h.host.querySelector(".setup-wizard-footer")!;
      expect(footer.querySelectorAll(".primary")).toHaveLength(1);
      expect(footer.contains(h.button("Test in ChatGPT")!)).toBe(true);
      expect(h.button("Test in ChatGPT")?.disabled).toBe(state === "missing");
      expect(h.button("Start using Farol")).toBeUndefined();
    },
  );

  it("switches to Finish only with current matching 4/4", async () => {
    const h = await mount({
      step: "attachment",
      value: pending(),
      signIn: "authenticated",
    });
    await h.confirmSignIn();
    expect(h.button("Test in ChatGPT")?.disabled).toBe(false);
    await h.publish(readySettings(true));
    expect(h.button("Test in ChatGPT")).toBeUndefined();
    expect(h.button("Start using Farol")?.disabled).toBe(false);
    await h.click("Start using Farol");
    expect(h.configuration().settings.setup.journey.dismissed).toBe(true);
    expect(h.c.getSnapshot().destination.area).toBe("home");
  });

  it.each([false, true])(
    "selects the scoped native-confirmed command once on double click (completed %s)",
    async (completed) => {
      const value = pending();
      value.setup.journey.dismissed = completed;
      const h = await mount({
        step: "attachment",
        value,
        signIn: "authenticated",
      });
      await h.confirmSignIn();
      expect(h.host.querySelector('input[type="checkbox"]')).toBeNull();
      expect(h.button("Test in ChatGPT")?.disabled).toBe(false);
      const waiting = deferred<unknown>();
      h.reply(() => waiting.promise);
      const test = h.button("Test in ChatGPT")!;
      await act(async () => {
        test.click();
        test.click();
      });
      const effects = () =>
        vi
          .mocked(h.f.api.configure)
          .mock.calls.filter(
            ([c]) => c.kind === "connector.verify-separate-app",
          );
      expect(effects()).toHaveLength(1);
      expect(effects()[0]![0]).toMatchObject({
        kind: "connector.verify-separate-app",
        expected: {
          ownerAuthorized: true,
          appName: "Farol",
          tunnelId: "synthetic-tunnel",
          connectorGeneration: 1,
          computerGeneration: 1,
          challengeSha256: "c".repeat(64),
        },
      });
      await act(async () =>
        waiting.resolve({
          ok: false,
          error: "CONNECTOR_APP_VERIFICATION_OUTCOME_UNKNOWN",
          snapshot: h.configuration(),
        }),
      );
      await h.navigate("attachment");
      expect(h.button("Test in ChatGPT")?.disabled).toBe(true);
      expect(h.configuration().settings.setup.connect.outcomeUnknown).toBe(
        true,
      );
      expect(
        h.configuration().settings.connectors.secureMcp.appVerificationPending,
      ).toBe(true);
      expect(effects()).toHaveLength(1);
    },
  );

  it("binds each request to the current challenge without treating IPC metadata as consent", async () => {
    const value = pending();
    const h = await mount({
      step: "attachment",
      value,
      signIn: "authenticated",
    });
    await h.confirmSignIn();
    value.connectors.secureMcp.challenge!.challengeSha256 = "f".repeat(64);
    value.revision++;
    await h.publish(value);
    await h.click("Test in ChatGPT");
    expect(
      vi
        .mocked(h.f.api.configure)
        .mock.calls.filter(
          ([c]) => c.kind === "connector.verify-separate-app",
        )[0]?.[0],
    ).toMatchObject({
      expected: { challengeSha256: "f".repeat(64) },
    });
    // Native confirmation, Go receipt and durable replay rejection are tested
    // at their actual host boundaries; this renderer test cannot prove them.
  });
});
