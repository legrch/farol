import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Overlay } from "./overlay";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mounted: { unmount(): void; host: HTMLElement }[] = [];
beforeEach(() => {
  // jsdom does not implement the modal dialog methods.
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement,
  ) {
    this.setAttribute("open", "");
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  });
});
afterEach(() => {
  for (const m of mounted.splice(0)) {
    act(() => m.unmount());
    m.host.remove();
  }
});
function mount(props: Partial<Parameters<typeof Overlay>[0]> = {}) {
  const onClose = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ unmount: () => root.unmount(), host });
  act(() =>
    root.render(
      createElement(Overlay, {
        title: "Sheet",
        onClose,
        children: "body",
        ...props,
      }),
    ),
  );
  return { host, onClose };
}

describe("Overlay", () => {
  it("opens a labelled modal dialog with a close button", () => {
    const { host, onClose } = mount();
    const dialog = host.querySelector("dialog");
    expect(dialog?.getAttribute("aria-label")).toBe("Sheet");
    expect(dialog?.className).toBe("sheet");
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledTimes(1);
    expect(host.querySelector("h2")?.textContent).toBe("Sheet");
    act(() =>
      host
        .querySelector<HTMLButtonElement>('button[aria-label="Close"]')
        ?.click(),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on a backdrop click and on cancel when dismissible", () => {
    const { host, onClose } = mount();
    const dialog = host.querySelector("dialog")!;
    act(() => dialog.click());
    expect(onClose).toHaveBeenCalledTimes(1);
    const cancel = new Event("cancel", { cancelable: true });
    act(() => {
      dialog.dispatchEvent(cancel);
    });
    expect(cancel.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("ignores dismissal and hides the close button when not dismissible", () => {
    const { host, onClose } = mount({ dismissible: false });
    const dialog = host.querySelector("dialog")!;
    act(() => dialog.click());
    act(() => {
      dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(host.querySelector('button[aria-label="Close"]')).toBeNull();
  });

  it("renders a heading icon, description and extra class", () => {
    const { host } = mount({
      headingIcon: "warning",
      headingDescription: createElement("p", { id: "d" }, "more"),
      className: "update-sheet",
    });
    expect(host.querySelector("dialog")?.className).toBe("sheet update-sheet");
    expect(host.querySelector(".update-symbol svg")).not.toBeNull();
    expect(host.querySelector(".update-heading #d")?.textContent).toBe("more");
  });

  it("focuses the requested element and restores focus on unmount", () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const input = { current: null as HTMLElement | null };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const ref = (el: HTMLElement | null) => {
      input.current = el;
    };
    act(() =>
      root.render(
        createElement(Overlay, {
          title: "T",
          onClose: () => undefined,
          initialFocus: input,
          children: createElement("input", { ref, "aria-label": "q" }),
        }),
      ),
    );
    expect(document.activeElement).toBe(input.current);
    act(() => root.unmount());
    expect(document.activeElement).toBe(trigger);
    host.remove();
    trigger.remove();
  });
});
