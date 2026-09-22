import { app } from "electron";
import { terminateDesktopStartup } from "./desktop-startup-failure";

// Keep main.ts behind a handled dynamic import. A synchronous failure while
// its build/configuration contracts are evaluated is therefore a classified
// rejected startup, not Electron's native uncaught-exception dialog.
void import("./main").catch((error: unknown) => {
  terminateDesktopStartup(
    error,
    process.env.FAROL_NEXT_ENVIRONMENT === "dev" ? "dev" : "preview",
    {
      write: (message) => process.stderr.write(message),
      exit: (code) => app.exit(code),
    },
  );
});
