import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { Settings } from "../../src/ui/renderer/settings";
import type {
  Intent,
  RendererFacade,
  WindowSnapshot,
} from "../../src/ui/renderer/contract";
import { mount, readySettings, workspaceId } from "./setup-fixture";

// Pins the Unresolved actions content and the Workspace edit result groups
// (UnresolvedActionsContent, WorkspaceEditResults) through the real Settings
// container with a hand-built snapshot and a recording facade. No native
// filesystem, account or tunnel evidence.
const operationId = "44444444-4444-4444-8444-444444444444";
const pending = {
  operationId,
  workspaceId,
  relativePath: "file.txt",
  computerGeneration: 1,
  submittedAt: "2026-10-02T20:00:00.000Z",
};
const intent = (id: string, state: Intent["state"], code: string | null) =>
  ({ id, state, code }) as Intent;

async function sheet(
  options: {
    pendingEdit?: boolean;
    delivery?: boolean;
    intents?: Record<string, Intent>;
    patch?: Partial<WindowSnapshot>;
  } = {},
) {
  const value = readySettings();
  if (options.pendingEdit) value.computer.pendingEdit = pending;
  const h = await mount({ page: "general", value });
  const snapshot = {
    ...h.c.getSnapshot(),
    intents: options.intents ?? {},
    workspaceEditDelivery: options.delivery ? operationId : null,
    ...options.patch,
  } as WindowSnapshot;
  const facade = {
    getSnapshot: () => snapshot,
    observeWorkspaceEdit: vi.fn(async () => intent("x", "applied", null)),
    acknowledgeWorkspaceEdit: vi.fn(async () => intent("x", "applied", null)),
    refresh: vi.fn(async () => undefined),
    overlay: vi.fn(),
    navigate: vi.fn(),
  } as unknown as RendererFacade;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <Settings snapshot={snapshot} facade={facade} unresolvedSheet />,
    ),
  );
  const button = (label: string) =>
    [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (e) => e.textContent?.trim() === label,
    );
  return { h, host, facade, button, root };
}

describe("Unresolved actions content", () => {
  it("reports an empty list and offers refresh and support export", async () => {
    const s = await sheet();
    expect(s.host.querySelector("[role=status]")?.textContent).toBe(
      "No unresolved actions.",
    );
    expect(s.host.querySelector("ul")).toBeNull();
    expect(s.host.textContent).toContain(
      "Refreshing cannot prove that an unknown action did not run.",
    );
    expect(s.button("Save support file…")).toBeTruthy();
    expect(s.host.textContent).not.toContain("Workspace edit result");
    await act(async () => s.button("Refresh status")!.click());
    expect(s.facade.refresh).toHaveBeenCalledOnce();
  });
  it("lists an unknown row with its cause, id and code", async () => {
    const id = "settings:chatgpt.open-browser:";
    const s = await sheet({
      intents: { [id]: intent(id, "unknown", "OUTCOME_UNKNOWN") },
    });
    const list = s.host.querySelector(
      "ul[aria-label='Unresolved operations']",
    )!;
    expect(list.querySelector("h3")?.textContent).toBe("chatgpt open browser");
    expect(list.textContent).toContain("Outcome unknown.");
    expect(list.querySelector("code")?.textContent).toBe(id);
    expect(list.textContent).toContain("OUTCOME_UNKNOWN");
    expect(s.button("Review recovery options")).toBeUndefined();
  });
});

describe("Workspace edit results", () => {
  it("shows a pending edit and observes it only when settled and current", async () => {
    const s = await sheet({ pendingEdit: true });
    const group = s.host.querySelector(
      "section[aria-label='Workspace edit result']",
    )!;
    expect(group.textContent).toContain(operationId);
    expect(group.textContent).toContain(
      "Edit submission: Not observed in this window.",
    );
    expect(s.button("Record result delivery")).toBeUndefined();
    await act(async () => s.button("Observe existing edit")!.click());
    expect(s.facade.observeWorkspaceEdit).toHaveBeenCalledExactlyOnceWith(
      operationId,
    );
  });
  it("disables observation while one is checking and labels each state", async () => {
    const s = await sheet({
      pendingEdit: true,
      intents: {
        [`observe:${operationId}`]: intent(
          `observe:${operationId}`,
          "pending",
          null,
        ),
        [`settings:computer.apply-workspace-edit:${operationId}`]: intent(
          `settings:computer.apply-workspace-edit:${operationId}`,
          "refused",
          "EDIT_REFUSED",
        ),
      },
    });
    expect(s.button("Observe existing edit")!.disabled).toBe(true);
    expect(s.host.textContent).toContain("Observation: Checking….");
    expect(s.host.textContent).toContain("Edit submission: Refused.");
    expect(s.host.textContent).toContain("EDIT_REFUSED");
  });
  it("records delivery once and explains an unknown acknowledgement", async () => {
    const s = await sheet({ delivery: true });
    expect(s.host.textContent).toContain(
      "Review the result above, then record its delivery",
    );
    await act(async () => s.button("Record result delivery")!.click());
    expect(s.facade.acknowledgeWorkspaceEdit).toHaveBeenCalledExactlyOnceWith(
      operationId,
    );
    const u = await sheet({
      delivery: true,
      intents: {
        [`ack:${operationId}`]: intent(
          `ack:${operationId}`,
          "unknown",
          "ACK_LOST",
        ),
      },
    });
    expect(u.host.textContent).toContain(
      "Result acknowledgement: Outcome unknown. ACK_LOST Do not repeat acknowledgement; delivery is unconfirmed.",
    );
    expect(u.button("Record result delivery")!.disabled).toBe(true);
    const a = await sheet({
      delivery: true,
      intents: {
        [`ack:${operationId}`]: intent(`ack:${operationId}`, "applied", null),
      },
    });
    expect(a.host.textContent).toContain(
      "Result acknowledgement: Confirmed. Delivery recorded. This does not change the edit outcome.",
    );
  });
});
