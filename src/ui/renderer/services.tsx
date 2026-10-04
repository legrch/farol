import { createContext, useContext, useSyncExternalStore } from "react";
import type { RendererFacade } from "./contract";
export const Services = createContext<RendererFacade | null>(null);
export function useRenderer() {
  const facade = useContext(Services);
  if (!facade) throw new Error("WINDOW_SERVICES_MISSING");
  return {
    facade,
    snapshot: useSyncExternalStore(facade.subscribe, facade.getSnapshot),
  };
}
