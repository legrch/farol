// Renderer input selects a fixed public destination, never a URL or credentials.
const destinations = Object.freeze({
  tunnels: "https://platform.openai.com/settings/organization/tunnels",
  "api-keys": "https://platform.openai.com/settings/organization/api-keys",
  chatgpt: "https://chatgpt.com/plugins",
  "setup-guide":
    "https://github.com/legrch/farol/blob/main/docs/setup-connection.md",
});

export type OnboardingHelpDestination = keyof typeof destinations;

export function onboardingHelpUrl(destination: unknown): string {
  if (
    typeof destination !== "string" ||
    !Object.hasOwn(destinations, destination)
  ) {
    throw new Error("ONBOARDING_HELP_DESTINATION_INVALID");
  }
  return destinations[destination as OnboardingHelpDestination];
}

export async function openOnboardingHelp(
  destination: unknown,
  open: (url: string) => Promise<void>,
): Promise<boolean> {
  try {
    await open(onboardingHelpUrl(destination));
    return true;
  } catch {
    return false;
  }
}
