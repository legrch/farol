import { describe, expect, it, vi } from "vitest";
import { createUpdateRelaunchObserver } from "./relaunch";

function ports() {
  const cp = vi.fn(async () => undefined);
  const wait = vi.fn(async (_options: unknown) => null);
  let userData = "/data/a";
  const args = ["farol", "--flag"];
  const build = { buildId: "b" };
  const files = { cp };
  const observe = createUpdateRelaunchObserver({
    wait: wait as never,
    args,
    directory: "/app",
    userData: () => userData,
    build: build as never,
    files: files as never,
  });
  return {
    cp,
    wait,
    args,
    build,
    files,
    observe,
    moveUserData: (next: string) => {
      userData = next;
    },
  };
}

describe("update relaunch observer", () => {
  it("does nothing until it is called", () => {
    const { wait } = ports();
    expect(wait).not.toHaveBeenCalled();
  });

  it("hands the wait the launch arguments, build and physical files", async () => {
    const { observe, wait, args, build, files } = ports();
    await observe();
    const options = wait.mock.calls[0]![0] as Record<string, unknown>;
    expect(options).toMatchObject({
      args,
      directory: "/app",
      userData: "/data/a",
      build,
      physicalFiles: files,
    });
  });

  it("reads the user-data path each time it runs", async () => {
    const { observe, wait, moveUserData } = ports();
    await observe();
    moveUserData("/data/b");
    await observe();
    expect(
      wait.mock.calls.map((call) => (call[0] as { userData: string }).userData),
    ).toEqual(["/data/a", "/data/b"]);
  });

  it("copies without overwriting and keeps links and timestamps", async () => {
    const { observe, wait, cp } = ports();
    await observe();
    const { copyApp } = wait.mock.calls[0]![0] as {
      copyApp(source: string, destination: string): Promise<void>;
    };
    await copyApp("/from", "/to");
    expect(cp).toHaveBeenCalledWith("/from", "/to", {
      recursive: true,
      force: false,
      errorOnExist: true,
      verbatimSymlinks: true,
      preserveTimestamps: true,
    });
  });

  it("returns the wait's own outcome", async () => {
    const { observe, wait } = ports();
    wait.mockRejectedValueOnce(new Error("UPDATE_RELAUNCH_HINT_INVALID"));
    await expect(observe()).rejects.toThrow("UPDATE_RELAUNCH_HINT_INVALID");
  });
});
