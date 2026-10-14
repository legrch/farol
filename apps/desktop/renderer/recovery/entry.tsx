import { createRoot } from "react-dom/client";
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
  const api = (window as unknown as { farolRecovery: { quit(): void } })
    .farolRecovery;
  const root = createRoot(host);
  root.render(<StartupRecovery quit={() => api.quit()} />);
  window.addEventListener("pagehide", () => root.unmount(), { once: true });
}
