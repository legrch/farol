import { createRoot } from "react-dom/client";
import type { StartupRecoveryAPI } from "./contract";
import { StartupRecovery } from "./view";

export function isStartupRecoveryDocument(url: URL): boolean {
  return (
    url.protocol === "file:" &&
    url.hostname === "" &&
    url.pathname.endsWith("/shell.html") &&
    url.search === "" &&
    url.hash === "#farol-startup-recovery"
  );
}

export function startStartupRecovery(): void {
  const host = document.getElementById("root");
  if (!host) throw new Error("RENDERER_ROOT_MISSING");
  document.body.classList.add("startup-recovery-document");
  const api = (window as unknown as { farolRecovery: StartupRecoveryAPI })
    .farolRecovery;
  const root = createRoot(host);
  root.render(<StartupRecovery api={api} />);
  window.addEventListener("pagehide", () => root.unmount(), { once: true });
}
