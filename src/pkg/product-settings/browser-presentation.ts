export interface BrowserPresentationSelection {
  readonly environment: "preview" | "dev";
  readonly demoMode?: boolean;
  readonly legacySetupTestMode?: boolean;
}

// Selects only Browser chrome, never a runtime, provider or permission mode.
export function compactBrowserSelected(
  input: BrowserPresentationSelection,
): boolean {
  return input.demoMode !== true && input.legacySetupTestMode !== true;
}
