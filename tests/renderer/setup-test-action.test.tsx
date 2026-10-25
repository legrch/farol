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
  it("consumes separate consent even when the route refuses before submission", async () => {
    const h = await mount({
      step: "attachment",
      value: pending(),
      signIn: "authenticated",
    });
    await h.confirmSignIn();
    const checkbox = () =>
      h.host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => checkbox().click());
    h.reply(() => ({
      ok: false,
      error: "CHATGPT_COMPOSER_DRAFT_PRESENT",
      snapshot: h.configuration(),
    }));
    await h.click("Test in ChatGPT");
    await h.navigate("attachment");
    expect(checkbox().checked).toBe(false);
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
      expect(h.button("Test in ChatGPT")?.disabled).toBe(true);
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
    expect(h.button("Test in ChatGPT")?.disabled).toBe(true);
    await h.publish(readySettings(true));
    expect(h.button("Test in ChatGPT")).toBeUndefined();
    expect(h.button("Start using Farol")?.disabled).toBe(false);
    await h.click("Start using Farol");
    expect(h.configuration().settings.setup.journey.dismissed).toBe(true);
    expect(h.c.getSnapshot().destination.area).toBe("home");
  });

  it.each([false, true])(
    "requires scoped consent and admits one separate request on double click (completed %s)",
    async (completed) => {
      const value = pending();
      value.setup.journey.dismissed = completed;
      const h = await mount({
        step: "attachment",
        value,
        signIn: "authenticated",
      });
      await h.confirmSignIn();
      const consent = h.host.querySelector<HTMLInputElement>(
        'input[type="checkbox"]',
      )!;
      expect(consent).toBeTruthy();
      expect(consent.checked).toBe(false);
      expect(h.button("Test in ChatGPT")?.disabled).toBe(true);
      const before = structuredClone(h.configuration());
      const calls = vi.mocked(h.f.api.configure).mock.calls.length;
      await act(async () => consent.click());
      expect(h.configuration()).toEqual(before);
      expect(h.f.api.configure).toHaveBeenCalledTimes(calls);
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

  it("invalidates consent when the challenge changes, and on remount", async () => {
    const value = pending();
    const h = await mount({
      step: "attachment",
      value,
      signIn: "authenticated",
    });
    await h.confirmSignIn();
    const checkbox = () =>
      h.host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => checkbox().click());
    expect(h.button("Test in ChatGPT")?.disabled).toBe(false);
    value.connectors.secureMcp.challenge!.challengeSha256 = "f".repeat(64);
    value.revision++;
    await h.publish(value);
    expect(checkbox().checked).toBe(false);
    expect(h.button("Test in ChatGPT")?.disabled).toBe(true);
    await act(async () => checkbox().click());
    await h.remount();
    expect(checkbox().checked).toBe(false);
    expect(h.button("Test in ChatGPT")?.disabled).toBe(true);
  });
});
