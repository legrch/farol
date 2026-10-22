"use strict";

const path = require("node:path");
const { app, BrowserWindow, screen } = require("electron");

const userData = process.argv
  .find((argument) => argument.startsWith("--fixture-user-data="))
  ?.slice("--fixture-user-data=".length);
if (process.env.FAROL_E2E !== "1" || !userData || !path.isAbsolute(userData)) {
  throw new Error("FOCUS_FIXTURE_ISOLATION_REQUIRED");
}
app.setName("Farol Inactive Reopen Focus Fixture");
app.setPath("userData", userData);

app
  .whenReady()
  .then(async () => {
    const builtIn = screen.getAllDisplays().find((display) => display.internal);
    if (
      !builtIn ||
      builtIn.workArea.width < 280 ||
      builtIn.workArea.height < 140
    ) {
      throw new Error("FOCUS_FIXTURE_BUILT_IN_DISPLAY_UNAVAILABLE");
    }
    const window = new BrowserWindow({
      title: "Farol Inactive Reopen Focus Fixture",
      x: builtIn.workArea.x + 12,
      y: builtIn.workArea.y + 12,
      width: 280,
      height: 140,
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    await window.loadURL(
      "data:text/html,<html><body>Native focus fixture</body></html>",
    );
    window.show();
    window.focus();
    app.focus({ steal: true });
  })
  .catch((error) => {
    process.stderr.write(
      `FOCUS_FIXTURE_START_FAILED:${error?.message ?? error}\n`,
    );
    app.exit(1);
  });
