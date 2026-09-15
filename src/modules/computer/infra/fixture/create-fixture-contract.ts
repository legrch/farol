import type { DeferredGate } from "../../../../pkg/async/deferred-gate";
import type { Clock } from "../../../../pkg/kernel/app/clock";
import { ComputerService } from "../../app/service/computer-service";
import type { ComputerContract } from "../../contract/computer-contract";
import { ComputerContractHandler } from "../contract-handler";
import { FixtureComputer } from "../repo/fixture-computer";

export type FixtureComputerIdentity = Readonly<{
  ownerId: string;
  sessionId: string;
  taskId: string;
  generation: number;
}>;

export function createFixtureComputerContract(
  identity: FixtureComputerIdentity,
  approval: DeferredGate,
  clock: Clock,
): ComputerContract {
  return new ComputerContractHandler(
    new ComputerService(
      {
        ownerId: identity.ownerId,
        sessionId: identity.sessionId,
        taskId: identity.taskId,
        generation: identity.generation,
        capability: "fixture.inspect",
        expiresAt: clock.now() + 3_600_000,
      },
      new FixtureComputer(approval),
      clock,
    ),
  );
}
