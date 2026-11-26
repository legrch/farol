import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Command as CommandView, Group, type Actions } from "./page";

const Command = CommandView as unknown as (
  props: Record<string, unknown>,
) => null;

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mounted: { unmount(): void; host: HTMLElement }[] = [];
afterEach(() => {
  for (const m of mounted.splice(0)) {
    act(() => m.unmount());
    m.host.remove();
  }
});
function mount(node: ReactElement) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(node));
  mounted.push({ unmount: () => root.unmount(), host });
  return host;
}
const actions = (allowed: boolean) => {
  const run = vi.fn(async () => null);
  const allowedFn = vi.fn(() => allowed);
  return {
    actions: { allowed: allowedFn, run } as unknown as Actions,
    run,
    allowedFn,
  };
};

describe("Group", () => {
  it("renders a labelled section with a heading", () => {
    const host = mount(createElement(Group, { title: "T", children: "body" }));
    const section = host.querySelector("section.settings-group");
    expect(section?.getAttribute("aria-label")).toBe("T");
    expect(section?.querySelector("h3")?.textContent).toBe("T");
    expect(section?.textContent).toBe("Tbody");
  });
  it("omits the heading but keeps the label when showTitle is false", () => {
    const host = mount(
      createElement(Group, { title: "T", showTitle: false, children: "body" }),
    );
    expect(host.querySelector("h3")).toBeNull();
    expect(host.querySelector("section")?.getAttribute("aria-label")).toBe("T");
  });
});

describe("Command", () => {
  it("runs the command with the admit callback on click", () => {
    const { actions: a, run, allowedFn } = actions(true);
    const admit = () => true;
    const command = { kind: "support.export" } as const;
    const host = mount(
      createElement(Command, { command, actions: a, admit }, "Go"),
    );
    const button = host.querySelector("button")!;
    expect(button.className).toBe("subtle");
    expect(button.disabled).toBe(false);
    expect(allowedFn).toHaveBeenCalledWith("support.export", undefined);
    act(() => button.click());
    expect(run).toHaveBeenCalledWith(command, admit);
  });
  it("disables when not allowed or forced, and passes the workspace id", () => {
    const { actions: a, run, allowedFn } = actions(false);
    const command = {
      kind: "computer.remove-workspace",
      workspaceId: "w1",
    } as never;
    const host = mount(createElement(Command, { command, actions: a }, "Go"));
    const button = host.querySelector("button")!;
    expect(button.disabled).toBe(true);
    expect(allowedFn).toHaveBeenCalledWith("computer.remove-workspace", "w1");
    act(() => button.click());
    expect(run).not.toHaveBeenCalled();
    const b = actions(true);
    const forced = mount(
      createElement(
        Command,
        { command, actions: b.actions, disabled: true, className: "primary" },
        "Go",
      ),
    ).querySelector("button")!;
    expect(forced.disabled).toBe(true);
    expect(forced.className).toBe("primary");
  });
});
