import { act } from "react";
import {
  storedSummary,
  storedPage,
  storedReply,
} from "../fixtures/recovery-archive";
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
  archive: "available",
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
    expect(button(f.host, "Open workspace").disabled).toBe(true);
    expect(f.api.read).not.toHaveBeenCalled();
    await select(f);
    expect(f.host.textContent).toContain("/synthetic/work");
    expect(button(f.host, "Open workspace").disabled).toBe(false);
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
    await act(async () => button(f.host, "Open workspace").click());
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
      await act(async () => button(f.host, "Open workspace").click());
      expect(f.host.querySelector('[role="alert"]')?.textContent).toContain(
        "no action was repeated",
      );
      expect(button(f.host, "Open workspace").disabled).toBe(true);
      await act(async () => button(f.host, "Open workspace").click());
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
    await act(async () => button(f.host, "Open workspace").click());
    expect(f.host.textContent).not.toContain("private");
    expect(button(f.host, "Open workspace").disabled).toBe(true);
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
      expect(f.host.textContent).toContain("Saved settings could not be read");
    else if ("folders" in state && state.folders.length === 0)
      expect(f.host.textContent).toContain("No approved workspaces");
    else {
      await select(f);
      expect(button(f.host, "Open workspace").disabled).toBe(true);
      expect(f.host.textContent).toContain("Workspace reads are unavailable");
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

it("shows saved Settings during startup and observes readiness without initiating a read", async () => {
  const f = await mount({
    ...ready,
    computer: "starting",
    archive: "starting",
  });
  try {
    expect(f.host.textContent).toContain("Revision 7");
    expect(f.host.textContent).toContain("Starting workspace reads");
    expect(button(f.host, "Load stored replies").disabled).toBe(true);
    f.api.state.mockResolvedValue(ready);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 180)));
    await select(f);
    expect(button(f.host, "Open workspace").disabled).toBe(false);
    expect(f.api.read).not.toHaveBeenCalled();
    expect(f.api.state).toHaveBeenCalledTimes(2);
  } finally {
    await f.dispose();
  }
});
it.each(["<script>not executable</script>\nSaved text ✓", "", " \n\t"])(
  "loads stored copies explicitly and preserves %j with unconfirmed provenance",
  async (text) => {
    const f = await mount({ ...ready, computer: "unavailable" });
    const summary = storedSummary(1, text);
    f.api.read
      .mockResolvedValueOnce({
        status: "ok",
        data: { kind: "archive-list", after: "", ...storedPage([summary]) },
      })
      .mockResolvedValueOnce({
        status: "ok",
        data: { kind: "archive-read", ...storedReply(summary, text) },
      });
    try {
      await act(async () => button(f.host, "Stored replies").click());
      expect(f.api.read).not.toHaveBeenCalled();
      await act(async () => button(f.host, "Load stored replies").click());
      expect(f.api.read).toHaveBeenLastCalledWith({
        kind: "archive-list",
        after: "",
      });
      expect(f.host.textContent).toContain("Some records remain unresolved");
      await act(async () =>
        (
          f.host.querySelector(
            '[aria-label="Open stored reply 1"]',
          ) as HTMLButtonElement
        ).click(),
      );
      expect(f.api.read).toHaveBeenLastCalledWith({
        kind: "archive-read",
        key: summary.key,
        digest: summary.digest,
      });
      expect(
        f.host.querySelector('[aria-label="Stored reply text"]')?.textContent,
      ).toBe(text);
      if (text === "") {
        expect(f.host.textContent).toContain("This stored reply is empty.");
      } else {
        expect(f.host.textContent).not.toContain("This stored reply is empty.");
      }
      expect(f.host.querySelectorAll("script, iframe, a, input")).toHaveLength(
        0,
      );
      expect(f.host.textContent).toContain("Outcome unconfirmed");
      expect(f.host.textContent).not.toContain("completed");
      await act(async () => button(f.host, "Workspaces").click());
      await act(async () => button(f.host, "Stored replies").click());
      expect(f.api.read).toHaveBeenCalledTimes(2);
      expect(
        f.host.querySelector('[aria-label="Stored reply text"]')?.textContent,
      ).toBe(text);
    } finally {
      await f.dispose();
    }
  },
);
it("loads each bounded page only on explicit demand and keeps the next observed cursor", async () => {
  const f = await mount(),
    rows = Array.from({ length: 32 }, (_, i) => storedSummary(i + 1));
  f.api.read
    .mockResolvedValueOnce({
      status: "ok",
      data: {
        kind: "archive-list",
        after: "",
        ...storedPage(rows, rows[31]!.key),
      },
    })
    .mockResolvedValueOnce({
      status: "ok",
      data: {
        kind: "archive-list",
        after: rows[31]!.key,
        ...storedPage([storedSummary(33)]),
      },
    });
  try {
    await act(async () => button(f.host, "Stored replies").click());
    await act(async () => button(f.host, "Load stored replies").click());
    expect(f.api.read).toHaveBeenCalledTimes(1);
    expect(
      f.host.querySelectorAll('[aria-label^="Open stored reply"]'),
    ).toHaveLength(32);
    await act(async () => button(f.host, "Load more replies").click());
    expect(f.api.read).toHaveBeenLastCalledWith({
      kind: "archive-list",
      after: rows[31]!.key,
    });
    expect(
      f.host.querySelectorAll('[aria-label^="Open stored reply"]'),
    ).toHaveLength(33);
    expect(
      [...f.host.querySelectorAll("button")].some(
        (b) => b.textContent === "Load more replies",
      ),
    ).toBe(false);
  } finally {
    await f.dispose();
  }
});
it.each(["unknown", "refused", "unavailable", "crossed cursor"])(
  "pauses the stored reader on %s while keeping folders usable",
  async (failure) => {
    const f = await mount();
    f.api.read.mockResolvedValueOnce(
      failure === "crossed cursor"
        ? {
            status: "ok",
            data: {
              kind: "archive-list",
              after: "f".repeat(64),
              ...storedPage(),
            },
          }
        : { status: failure },
    );
    try {
      await act(async () => button(f.host, "Stored replies").click());
      await act(async () => button(f.host, "Load stored replies").click());
      expect(button(f.host, "Load stored replies").disabled).toBe(true);
      expect(f.host.textContent).toContain("The reader is paused");
      await act(async () => button(f.host, "Load stored replies").click());
      expect(f.api.read).toHaveBeenCalledTimes(1);
      await act(async () => button(f.host, "Workspaces").click());
      await select(f);
      expect(button(f.host, "Open workspace").disabled).toBe(false);
      expect(button(f.host, "Quit").disabled).toBe(false);
    } finally {
      await f.dispose();
    }
  },
);
it("withholds a changed stored summary before rendering text", async () => {
  const f = await mount();
  f.api.read
    .mockResolvedValueOnce({
      status: "ok",
      data: { kind: "archive-list", after: "", ...storedPage() },
    })
    .mockResolvedValueOnce({
      status: "ok",
      data: {
        kind: "archive-read",
        ...storedReply({ ...storedSummary(), backendGeneration: "crossed" }),
      },
    });
  try {
    await act(async () => button(f.host, "Stored replies").click());
    await act(async () => button(f.host, "Load stored replies").click());
    await act(async () =>
      (
        f.host.querySelector(
          '[aria-label="Open stored reply 1"]',
        ) as HTMLButtonElement
      ).click(),
    );
    expect(f.host.querySelector('[aria-label="Stored reply text"]')).toBeNull();
    expect(f.host.textContent).toContain("The reader is paused");
  } finally {
    await f.dispose();
  }
});

it("observes original backend loss without another read and keeps the already displayed copy", async () => {
  const f = await mount();
  f.api.read
    .mockResolvedValueOnce({
      status: "ok",
      data: { kind: "archive-list", after: "", ...storedPage() },
    })
    .mockResolvedValueOnce({
      status: "ok",
      data: { kind: "archive-read", ...storedReply() },
    });
  try {
    await act(async () => button(f.host, "Stored replies").click());
    await act(async () => button(f.host, "Load stored replies").click());
    await act(async () =>
      (
        f.host.querySelector(
          '[aria-label="Open stored reply 1"]',
        ) as HTMLButtonElement
      ).click(),
    );
    f.api.state.mockResolvedValue({
      ...ready,
      computer: "unavailable",
      archive: "unavailable",
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 1100)));
    expect(f.host.textContent).toContain("Stored replies are unavailable");
    expect(
      f.host.querySelector('[aria-label="Stored reply text"]')?.textContent,
    ).toBe(storedReply().text);
    expect(
      (
        f.host.querySelector(
          '[aria-label="Open stored reply 1"]',
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(f.api.read).toHaveBeenCalledTimes(2);
    const count = f.api.state.mock.calls.length;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 1100)));
    expect(f.api.state).toHaveBeenCalledTimes(count);
    await act(async () => button(f.host, "Workspaces").click());
    await select(f);
    expect(button(f.host, "Open workspace").disabled).toBe(true);
    expect(f.host.textContent).toContain("Revision 7");
    expect(button(f.host, "Quit").disabled).toBe(false);
  } finally {
    await f.dispose();
  }
});

it("opens the existing workspace/reply view with commands paused without submitting anything", async () => {
  const f = await mount();
  try {
    await act(async () => button(f.host, "Open with commands paused").click());
    expect(f.host.querySelector("h1")?.textContent).toBe(
      "Your workspaces and stored replies",
    );
    expect(f.host.textContent).toContain("Commands paused");
    expect(f.host.textContent).toContain("Workspaces");
    expect(f.api.read).not.toHaveBeenCalled();
    expect(f.api.quit).not.toHaveBeenCalled();
  } finally {
    await f.dispose();
  }
});
it.each(["refused", "unavailable", "unknown"])(
  "checks once and preserves %s before opening with commands paused",
  async (status) => {
    const f = await mount();
    f.api.read.mockResolvedValue({ status });
    try {
      await act(async () =>
        button(f.host, "Check previous operations").click(),
      );
      expect(f.api.read).toHaveBeenCalledExactlyOnceWith({
        kind: "archive-list",
        after: "",
      });
      expect(button(f.host, "Check previous operations").disabled).toBe(true);
      expect(f.host.textContent).toContain("could not be confirmed");
      await act(async () =>
        button(f.host, "Open with commands paused").click(),
      );
      expect(f.api.read).toHaveBeenCalledOnce();
      expect(f.api.quit).not.toHaveBeenCalled();
    } finally {
      await f.dispose();
    }
  },
);
it("an empty stored observation never invents a clean predecessor or enables commands", async () => {
  const f = await mount();
  f.api.read.mockResolvedValue({
    status: "ok",
    data: {
      kind: "archive-list",
      observation: "stored_unconfirmed",
      after: "",
      entries: [],
      next: "",
      unresolved: false,
    },
  });
  try {
    await act(async () => button(f.host, "Check previous operations").click());
    expect(f.host.textContent).toContain(
      "previous operations remain unconfirmed",
    );
    expect(
      [...f.host.querySelectorAll("button")].some(
        (b) => b.textContent === "Continue",
      ),
    ).toBe(false);
    expect(button(f.host, "Open with commands paused").disabled).toBe(false);
  } finally {
    await f.dispose();
  }
});
