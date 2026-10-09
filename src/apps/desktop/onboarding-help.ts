import path from "node:path";
import { pathToFileURL } from "node:url";

// Renderer input selects a fixed destination, never a URL or credentials.
// The guide uses existing shell resources relative to the host-owned bundle.
const destinations = Object.freeze({
  tunnels: "https://platform.openai.com/settings/organization/tunnels",
  "api-keys": "https://platform.openai.com/settings/organization/api-keys",
  chatgpt: "https://chatgpt.com/plugins",
});

export type OnboardingHelpDestination =
  keyof typeof destinations | "setup-guide";

export function onboardingHelpUrl(
  destination: unknown,
  bundledDirectory?: string,
): string {
  if (destination === "setup-guide") {
    if (!bundledDirectory || !path.isAbsolute(bundledDirectory)) {
      throw new Error("ONBOARDING_GUIDE_BUNDLE_INVALID");
    }
    const document = pathToFileURL(path.join(bundledDirectory, "shell.html"));
    document.hash = "farol-connection-guide";
    return document.href;
  }
  if (
    typeof destination !== "string" ||
    !Object.hasOwn(destinations, destination)
  ) {
    throw new Error("ONBOARDING_HELP_DESTINATION_INVALID");
  }
  return destinations[destination as keyof typeof destinations];
}

export async function openOnboardingHelp(
  destination: unknown,
  open: (url: string) => Promise<void>,
  openGuide?: () => Promise<void>,
): Promise<boolean> {
  try {
    if (destination === "setup-guide") {
      if (!openGuide) return false;
      await openGuide();
    } else {
      await open(onboardingHelpUrl(destination));
    }
    return true;
  } catch {
    return false;
  }
}
