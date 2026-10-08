/**
 * Farol's approved twenty-unit design vocabulary.
 * Source: farol-design/home-sidebar-2026-10-06/app.js (paths and gear formula).
 * UI aliases preserve existing product route names. No routing or authority.
 */
export const designIconViewBox = "0 0 20 20";

const gearPoints = Array.from({ length: 32 }, (_, index) => {
  const angle = (index * Math.PI) / 16 - Math.PI / 16;
  const radius = index % 4 < 2 ? 8.3 : 6.8;
  return `${10 + radius * Math.cos(angle)},${10 + radius * Math.sin(angle)}`;
});

const paths = Object.freeze({
  back: "m12 4-6 6 6 6",
  forward: "m8 4 6 6-6 6",
  sidebar: "M2 3h16v14H2V3M7 3v14",
  download: "M10 2v10m-4-4 4 4 4-4M3 14v4h14v-4",
  appearance:
    "M10 2a8 8 0 1 0 0 16h1a2 2 0 0 0 0-4h-1a2 2 0 0 1 0-4h6a2 2 0 0 0 2-2 8 8 0 0 0-8-4M6 6h.1M5 10h.1M9 5h.1M13 6h.1",
  home: "M3 10 10 4l7 6M5 9v8h4v-5h3v5h3V9",
  chat: "M4 4h12v10H8l-4 3V4M7 7h6M7 10h4",
  setup: "M3 6h14M3 14h14M7 3v6M13 11v6",
  activity: "M3 15h3l3-10 4 12 2-6h3",
  settings:
    "M" +
    gearPoints.join("L") +
    "Z M12.6 10a2.6 2.6 0 1 0-5.2 0 2.6 2.6 0 0 0 5.2 0",
  general: "M3 5h14M3 10h14M3 15h14M7 3v4M13 8v4M8 13v4",
  folders: "M2 6V4h6l2 2h8v10H2V6",
  mac: "M3 3h14v10H3V3M7 17h6M10 13v4",
  connection: "M7 7 5 9a3 3 0 0 0 4 4l2-2M13 13l2-2a3 3 0 0 0-4-4L9 9M7 13l6-6",
  model: "M10 2 17 6v8l-7 4-7-4V6l7-4M3 6l7 4 7-4M10 10v8",
  updates: "M16 6a7 7 0 1 0 1 7M16 2v5h-5",
  diagnostics: "M6 2h8M8 2v6l-5 7v3h14v-3l-5-7V2M6 12h8",
  shortcuts: "M2 5h16v11H2V5M5 8h1M9 8h1M13 8h1M5 12h10",
  chevron: "m7 4 6 6-6 6",
  menu: "M3 4h14M3 10h14M3 16h14",
  check: "m4 10 4 4 8-8",
  search: "M8 3a5 5 0 1 0 0 10 5 5 0 0 0 0-10M12 12l5 5",
  close: "m5 5 10 10M15 5 5 15",
  shield: "M10 2 17 5v5c0 4-7 8-7 8s-7-4-7-8V5l7-3",
  clock: "M10 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16M10 5v5l3 2",
  warning: "m10 2 8 15H2l8-15M10 7v5M10 14v1",
  // Existing product-only glyph, fitted to the same twenty-unit grid.
  plus: "M10 3v14M3 10h14",
});

const aliases: Readonly<Record<string, keyof typeof paths>> = Object.freeze({
  chatgpt: "chat",
  computer: "mac",
  attention: "warning",
  workspaces: "folders",
});

/** Unknown or prototype-inherited names never become arbitrary path values. */
export function designIconPath(name: string): string {
  const resolved = Object.hasOwn(aliases, name) ? aliases[name]! : name;
  return Object.hasOwn(paths, resolved)
    ? paths[resolved as keyof typeof paths]
    : paths.general;
}
