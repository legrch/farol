// Observe the original application only after its first real window exists.
// This is a readback, not isolation admission, cleanup permission or acceptance.
export async function readNativePreviewEcho(application) {
  const page = await application.firstWindow();
  const actual = await application.evaluate(({ app, BrowserWindow }) => ({
    pid: process.pid,
    name: app.getName(),
    isPackaged: app.isPackaged,
    home: app.getPath("home"),
    userData: app.getPath("userData"),
    sessionData: app.getPath("sessionData"),
    temp: app.getPath("temp"),
    windows: BrowserWindow.getAllWindows().map((window) => ({
      visible: window.isVisible(),
      focused: window.isFocused(),
    })),
  }));
  return { page, actual };
}
