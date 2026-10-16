import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { isStartupRecoveryDocument } from "../../apps/desktop/renderer/recovery/entry";
import { StartupRecovery } from "../../apps/desktop/renderer/recovery/view";

// React/document fixture only; native startup and predecessor custody need E2E.
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const folder = {
  workspaceId: "00000000-0000-4000-8000-000000000004",
  label: "Synthetic work",
  root: "/synthetic/work",
};
const ready = {
  status: "ready",
  revision: 7,
  folders: [folder],
  computer: "available",
};
async function mount(state: unknown = ready) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const api = {
    state: vi.fn(async () => state),
    read: vi.fn(async (_request: unknown): Promise<unknown> => ({
      status: "refused",
    })),
    quit: vi.fn(),
  };
  await act(async () => root.render(<StartupRecovery api={api} />));
  return {
    host,
    api,
    dispose: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
function button(host: HTMLElement, label: string) {
  const value = [...host.querySelectorAll("button")].find(
    (entry) => entry.textContent === label,
  );
  if (!value) throw Error("missing button: " + label);
  return value;
}
async function select(f: Awaited<ReturnType<typeof mount>>) {
  await act(async () => {
    const select = f.host.querySelector("select")!;
    select.value = folder.workspaceId;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
it("shows saved Settings independently and requires an explicit folder action", async () => {
  const f = await mount();
  try {
    expect(f.host.querySelector("h1")?.textContent).toBe(
      "Your previous session needs recovery",
    );
    expect(f.host.textContent).toContain("Revision 7");
    expect(f.host.textContent).toContain("Connection and commands are paused");
    expect(button(f.host, "Open folder").disabled).toBe(true);
    expect(f.api.read).not.toHaveBeenCalled();
    await select(f);
    expect(f.host.textContent).toContain("/synthetic/work");
    expect(button(f.host, "Open folder").disabled).toBe(false);
    await act(async () => button(f.host, "Quit").click());
    expect(f.api.quit).toHaveBeenCalledOnce();
    expect(f.host.querySelectorAll("iframe, a, input")).toHaveLength(0);
  } finally {
    await f.dispose();
  }
});
it("opens approved subfolders and shows metadata with the original relative path", async () => {
  const f = await mount();
  f.api.read.mockImplementation(async (request) => {
    const body = request as { kind: string; relativePath: string };
    return {
      status: "ok",
      data:
        body.kind === "list"
          ? {
              kind: body.kind,
              relativePath: body.relativePath,
              entries: body.relativePath === "." ? ["folder/"] : ["note.md"],
              truncated: false,
            }
          : {
              kind: body.kind,
              relativePath: body.relativePath,
              bytes: 5,
              sha256: "b".repeat(64),
            },
    };
  });
  try {
    await select(f);
    await act(async () => button(f.host, "Open folder").click());
    await act(async () => button(f.host, "▸folder/").click());
    expect(f.api.read).toHaveBeenLastCalledWith({
      kind: "list",
      workspaceId: folder.workspaceId,
      relativePath: "folder",
    });
    await act(async () => button(f.host, "·note.md").click());
    expect(f.api.read).toHaveBeenLastCalledWith({
      kind: "metadata",
      workspaceId: folder.workspaceId,
      relativePath: "folder/note.md",
    });
    expect(f.host.textContent).toContain("5 bytes");
    expect(f.host.textContent).toContain("SHA-256 " + "b".repeat(64));
    await act(async () => button(f.host, "Up").click());
    expect(f.api.read).toHaveBeenLastCalledWith({
      kind: "list",
      workspaceId: folder.workspaceId,
      relativePath: ".",
    });
  } finally {
    await f.dispose();
  }
});
it.each(["unknown", "unavailable"])(
  "pauses after %s without offering a retry",
  async (status) => {
    const f = await mount();
    f.api.read.mockResolvedValueOnce({ status });
    try {
      await select(f);
      await act(async () => button(f.host, "Open folder").click());
      expect(f.host.querySelector('[role="alert"]')?.textContent).toContain(
        "no action was repeated",
      );
      expect(button(f.host, "Open folder").disabled).toBe(true);
      await act(async () => button(f.host, "Open folder").click());
      expect(f.api.read).toHaveBeenCalledTimes(1);
      expect(button(f.host, "Quit").disabled).toBe(false);
    } finally {
      await f.dispose();
    }
  },
);
it("rejects malformed and crossed read responses before rendering their entries", async () => {
  const f = await mount();
  f.api.read.mockResolvedValueOnce({
    status: "ok",
    data: {
      kind: "list",
      relativePath: "crossed",
      entries: ["private"],
      truncated: false,
    },
  });
  try {
    await select(f);
    await act(async () => button(f.host, "Open folder").click());
    expect(f.host.textContent).not.toContain("private");
    expect(button(f.host, "Open folder").disabled).toBe(true);
  } finally {
    await f.dispose();
  }
});
it.each([
  { status: "settings_unavailable" },
  { ...ready, computer: "unavailable" },
  { ...ready, folders: [] },
])("shows truthful unavailable/empty resource state %j", async (state) => {
  const f = await mount(state);
  try {
    expect(f.api.read).not.toHaveBeenCalled();
    if (state.status === "settings_unavailable")
      expect(f.host.textContent).toContain("Saved settings are unavailable");
    else if ("folders" in state && state.folders.length === 0)
      expect(f.host.textContent).toContain("No approved folders");
    else {
      await select(f);
      expect(button(f.host, "Open folder").disabled).toBe(true);
      expect(f.host.textContent).toContain("Folder reads are unavailable");
    }
    expect(button(f.host, "Quit").disabled).toBe(false);
  } finally {
    await f.dispose();
  }
});

it("admits recovery rendering only for its fixed local document fragment", () => {
  expect(
    isStartupRecoveryDocument(
      new URL("file:///fixture/shell.html#farol-startup-recovery"),
    ),
  ).toBe(true);
  for (const url of [
    "https://example.invalid/shell.html#farol-startup-recovery",
    "file:///fixture/other.html#farol-startup-recovery",
    "file:///fixture/shell.html?recovery=1#farol-startup-recovery",
    "file:///fixture/shell.html",
    "file://remote/shell.html#farol-startup-recovery",
  ]) {
    expect(isStartupRecoveryDocument(new URL(url))).toBe(false);
  }
});
