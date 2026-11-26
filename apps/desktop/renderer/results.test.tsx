import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  Intent,
  RendererFacade,
  WindowSnapshot,
} from "../../../src/ui/renderer/contract";
import type { PageProps } from "./page";
import { WorkspaceEditResults } from "./results";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const operationId = "44444444-4444-4444-8444-444444444444";
const hosts: { unmount(): void; host: HTMLElement }[] = [];
afterEach(() => {
  for (const m of hosts.splice(0)) {
    act(() => m.unmount());
    m.host.remove();
  }
});
const intent = (id: string, state: Intent["state"], code: string | null) =>
  ({ id, state, code }) as Intent;
function render(
  options: { pendingEdit?: boolean; delivery?: boolean; intents?: object } = {},
) {
  const settings = {
    computer: { pendingEdit: options.pendingEdit ? { operationId } : null },
  } as unknown as PageProps["settings"];
  const snapshot = {
    status: "current",
    intents: options.intents ?? {},
    workspaceEditDelivery: options.delivery ? operationId : null,
    configuration: { status: "ready", settings },
  } as unknown as WindowSnapshot;
  const facade = {
    getSnapshot: () => snapshot,
    observeWorkspaceEdit: vi.fn(),
    acknowledgeWorkspaceEdit: vi.fn(),
  } as unknown as RendererFacade;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  hosts.push({ unmount: () => root.unmount(), host });
  act(() =>
    root.render(
      createElement(WorkspaceEditResults, { snapshot, facade, settings }),
    ),
  );
  const button = (label: string) =>
    [...host.querySelectorAll("button")].find((b) => b.textContent === label);
  return { host, facade, button };
}

describe("WorkspaceEditResults", () => {
  it("renders nothing without an operation", () => {
    expect(render().host.textContent).toBe("");
  });
  it("observes a pending edit and labels an unobserved submission", () => {
    const r = render({ pendingEdit: true });
    expect(r.host.textContent).toContain(
      "Edit submission: Not observed in this window.",
    );
    act(() => r.button("Observe existing edit")!.click());
    expect(r.facade.observeWorkspaceEdit).toHaveBeenCalledExactlyOnceWith(
      operationId,
    );
  });
  it("records delivery and explains an unknown acknowledgement", () => {
    const r = render({
      delivery: true,
      intents: {
        [`ack:${operationId}`]: intent(`ack:${operationId}`, "unknown", "LOST"),
      },
    });
    expect(r.host.textContent).toContain(
      "Result acknowledgement: Outcome unknown. LOST Do not repeat acknowledgement; delivery is unconfirmed.",
    );
    expect(r.button("Record result delivery")!.disabled).toBe(true);
  });
});
