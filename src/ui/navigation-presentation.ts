import type { SurfaceSection } from "../pkg/ipc/shell-state";

// Keep the durable label and task identity intact, including older saved views.
export function chatViewLabel(label: string): string {
  return label
    .replace(/^Demo · /u, "")
    .replace(/^ChatGPT task ([1-9]\d*)$/u, "ChatGPT $1");
}

export function navigationTitle(
  input: Readonly<{
    section: SurfaceSection;
    setupPage: string | null;
    settingsPage: "preferences" | "shortcuts" | "model" | "diagnostics" | null;
  }>,
): string {
  if (input.section === "computer") return input.setupPage ?? "Connections";
  if (input.section === "activity") return "Activity";
  if (input.section === "browser") return "ChatGPT";
  const settingsTitles = {
    preferences: "Preferences",
    shortcuts: "Keyboard Shortcuts",
    model: "Model",
    diagnostics: "Diagnostics",
  } as const;
  return input.settingsPage ? settingsTitles[input.settingsPage] : "Settings";
}
