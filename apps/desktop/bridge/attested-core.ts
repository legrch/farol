import {
  createCoreArtifactVerifier,
  type CoreArtifactDeclaration,
  type CoreArtifactExpectation,
} from "../../../src/pkg/kernel/infra/core-artifact.ts";
export type {
  CoreBuildBinding,
  CoreBinaryBinding,
  CoreArtifactDeclaration,
} from "../../../src/pkg/kernel/infra/core-artifact.ts";
import {
  BridgeError,
  spawnCore,
  type Client,
  type NativeCoreLaunch,
} from "./client.ts";
import {
  protocolMajor,
  protocolMinor,
  validate,
  type CoreRetirementAcknowledged,
} from "./wire.ts";
import type { ProfileLaunchBinding } from "./profile.ts";
import { recordTerminal } from "./terminal-recorder.ts";

export interface TrustedCoreExpectation extends CoreArtifactExpectation {
  readonly profileId: string;
}

function refuse(code: string): never {
  throw new BridgeError("refused", code);
}
const verification = createCoreArtifactVerifier({
  refuse,
  isRefusal: (error) => error instanceof BridgeError,
});
export function parseCoreArtifactDeclaration(
  value: unknown,
): CoreArtifactDeclaration {
  return verification.parseCoreArtifactDeclaration(value);
}
function expectation(value: unknown): TrustedCoreExpectation {
  const code = "invalid_core_expectation";
  const expected = verification.record(
    value,
    ["artifactRoot", "build", "binary", "profileId"],
    code,
  );
  const artifactRoot = verification.artifactRoot(expected.artifactRoot, code);
  const build = verification.buildBinding(expected.build, code);
  if (
    !validate("Handshake", {
      protocolMajor,
      protocolMinor,
      buildId: build.buildId,
      profileId: expected.profileId,
    })
  )
    return refuse(code);
  return Object.freeze({
    artifactRoot,
    build,
    binary: verification.binaryBinding(expected.binary, code),
    profileId: expected.profileId as string,
  });
}
// Reuse the same attestation for a one-shot bundled Go capability. The trusted
// caller still owns an immutable accepted tree through the original child close.
// This performs no spawn, profile opening, admission or new trust production.
export function verifyCoreExecutable(
  artifact: unknown,
  trusted: TrustedCoreExpectation,
): string {
  const expected = expectation(trusted);
  verification.bind(parseCoreArtifactDeclaration(artifact), expected);
  return verification.verifyBinary(expected);
}

// Trusted Electron host only; keep one instance for one child lifetime. A start
// is consumed before validation, even on refusal. No renderer IPC or operation
// body can supply these expectations. Client retains all pipe/cleanup ownership.
// Caller must keep the accepted artifact tree immutable through spawn and child
// lifetime: path-based spawnCore cannot atomically attest exec under host mutation.
export class AttestedCore {
  private consumed = false;
  private child: Client | undefined;
  private verified: TrustedCoreExpectation | undefined;
  private terminalBinding:
    | Readonly<{
        profile: ProfileLaunchBinding;
        hostLifetimeId: string;
        childLaunchId: string;
      }>
    | undefined;
  private retirementResult: Promise<void> | undefined;
  constructor(
    private readonly artifact: unknown,
    private readonly expected: TrustedCoreExpectation,
  ) {}
  // Caller retains a native selection when artifact validation refuses before spawnCore.
  start(timeoutMs = 2000, native?: NativeCoreLaunch): Promise<Client> {
    if (this.consumed)
      return Promise.reject(new BridgeError("refused", "core_start_consumed"));
    this.consumed = true;
    try {
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000)
        refuse("invalid_deadline");
      const expected = expectation(this.expected);
      const artifact = parseCoreArtifactDeclaration(this.artifact);
      verification.bind(artifact, expected);
      const executable = verification.verifyBinary(expected);
      this.verified = expected;
      let selectedNative = native;
      if (
        native?.hostLifetimeId !== undefined &&
        native.childLaunchId !== undefined
      ) {
        const originalProfile = native.profile;
        const hostLifetimeId = native.hostLifetimeId;
        const childLaunchId = native.childLaunchId;
        selectedNative = {
          ...native,
          profile: {
            beforeSpawn: () => {
              const selected = originalProfile.beforeSpawn();
              if (selected.state === "qualified")
                this.terminalBinding = Object.freeze({
                  profile: Object.freeze({ ...selected.binding }),
                  hostLifetimeId,
                  childLaunchId,
                });
              return selected;
            },
            close: () => originalProfile.close(),
          },
        };
      }
      // spawnCore alone performs the one handshake and any owned-child cleanup.
      // Propagate its original rejection, including cleanup unknown, unchanged.
      return spawnCore(
        executable,
        expected.profileId,
        expected.build.buildId,
        timeoutMs,
        ...(selectedNative ? ([selectedNative] as const) : []),
      ).then((client) => {
        this.child = client;
        return client;
      });
    } catch (error) {
      return Promise.reject(error);
    }
  }

  // Called only after the explicit durable ACK reply. The original Client,
  // profile and attestation are retained; callers cannot supply exit facts.
  completeRetirement(ack: CoreRetirementAcknowledged): Promise<void> {
    if (!this.retirementResult)
      this.retirementResult = this.completeRetirementOnce(ack);
    return this.retirementResult;
  }
  private async completeRetirementOnce(
    input: CoreRetirementAcknowledged,
  ): Promise<void> {
    if (
      !this.child ||
      !this.verified ||
      !this.terminalBinding ||
      !validate("CoreRetirementAcknowledged", input)
    )
      throw new BridgeError("refused", "core_retirement_unavailable");
    const ack = structuredClone(input);
    const context = this.child.verifiedContext;
    const terminal = await this.child.closeAndObserve();
    const executable = verification.verifyBinary(this.verified);
    await recordTerminal(
      executable,
      this.terminalBinding.profile,
      {
        ...ack,
        backendGeneration: context.backendGeneration,
        hostLifetimeId: this.terminalBinding.hostLifetimeId,
        childLaunchId: this.terminalBinding.childLaunchId,
        exitCode: terminal.exitCode === null ? "" : String(terminal.exitCode),
        signal: terminal.signal ?? "",
        forced: terminal.forced,
      },
      ack,
    );
  }
}
