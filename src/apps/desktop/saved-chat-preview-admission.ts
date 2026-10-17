/** A session-local owner opt-in is separate from Computer folder authority. */
export function savedChatPreviewQualified(
  input: Readonly<{
    environment: string;
    ownerOptIn: string | undefined;
    outcomeUnknown: boolean;
    verification: Readonly<{
      profile: string;
      runtimeGeneration: string;
      buildId: string;
      protocol: string;
    }> | null;
    partition: string;
    buildId: string;
  }>,
): boolean {
  const verification = input.verification;
  return (
    (input.environment === "dev" ||
      input.environment === "preview" ||
      input.environment === "owner-preview") &&
    input.ownerOptIn === "1" &&
    !input.outcomeUnknown &&
    verification?.profile === "chatgpt.next-partition/1" &&
    verification.runtimeGeneration === `${input.partition}:${input.buildId}` &&
    verification.buildId === input.buildId &&
    verification.protocol === "chatgpt-page-readiness/1"
  );
}
