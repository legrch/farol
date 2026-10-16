import { expect, it, vi } from "vitest";
import { readNativePreviewEcho } from "../e2e/lib/native-preview-echo.mjs";

// Adapter contract only. No app/native process/window or filesystem is opened.
it("waits for the original window and retains the singleton PID and every window", async () => {
  const page = {};
  let windowObserved = false;
  const paths = {
    home: "/fixture/home",
    userData: "/fixture/data",
    sessionData: "/fixture/data",
    temp: "/fixture/temp",
  };
  const windows = [
    { isVisible: () => false, isFocused: () => false },
    { isVisible: () => true, isFocused: () => true },
  ];
  const application = {
    firstWindow: vi.fn(async () => {
      windowObserved = true;
      return page;
    }),
    evaluate: vi.fn(async (read) => {
      expect(windowObserved).toBe(true);
      return read({
        app: {
          getName: () => "Farol Dev",
          isPackaged: false,
          getPath: (key) => paths[key],
        },
        BrowserWindow: { getAllWindows: () => windows },
      });
    }),
  };
  const echo = await readNativePreviewEcho(application);
  expect(echo.page).toBe(page);
  expect(echo.actual).toEqual({
    pid: process.pid,
    name: "Farol Dev",
    isPackaged: false,
    ...paths,
    windows: [
      { visible: false, focused: false },
      { visible: true, focused: true },
    ],
  });
  expect(application.firstWindow).toHaveBeenCalledTimes(1);
  expect(application.evaluate).toHaveBeenCalledTimes(1);
});
it("does not read or retry when the original window observation fails", async () => {
  const application = {
    firstWindow: vi.fn(async () => {
      throw new Error("original_window_unknown");
    }),
    evaluate: vi.fn(),
  };
  await expect(readNativePreviewEcho(application)).rejects.toThrow(
    "original_window_unknown",
  );
  expect(application.firstWindow).toHaveBeenCalledTimes(1);
  expect(application.evaluate).not.toHaveBeenCalled();
});
