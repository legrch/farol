import type { Destination, WindowSnapshot } from "./contract";

export function isHomeOverview(destination: Destination): boolean {
  return (
    destination.area === "home" &&
    (destination.homeView ?? "overview") === "overview" &&
    !destination.homeSelection
  );
}

/** Home uses the full content width; an explicitly opened page list remains usable. */
export function pageListMode(
  destination: Destination,
  preference: WindowSnapshot["sidebar"],
): WindowSnapshot["sidebar"] {
  return isHomeOverview(destination) && preference === "full"
    ? "rail"
    : preference;
}
