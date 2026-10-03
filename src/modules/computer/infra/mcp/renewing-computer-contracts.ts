import type { ReadonlyComputerContract } from "../../contract/readonly-computer-contract";
import type { MutableComputerContract } from "../../contract/mutable-computer-contract";
import type { RenewableComputerAuthority } from "./renewable-computer-authority";

const admissionError = (error: unknown) => ({
  ok: false as const,
  correlation: null,
  error: {
    code:
      error instanceof Error && error.message === "AUTHORITY_COMPUTER_MISMATCH"
        ? ("AUTHORITY_COMPUTER_MISMATCH" as const)
        : error instanceof Error && error.message === "AUTHORITY_EXPIRED"
          ? ("AUTHORITY_EXPIRED" as const)
          : ("COMPUTER_APPROVAL_STORE_UNAVAILABLE" as const),
    source: "authority-store" as const,
    retry: "never" as const,
  },
});

export function renewingReadonlyComputerContract(
  handler: ReadonlyComputerContract,
  authority: RenewableComputerAuthority,
): ReadonlyComputerContract {
  return {
    async execute(request, context) {
      let execution;
      try {
        execution = await authority.admitExecution(15_000);
      } catch (error) {
        return admissionError(error);
      }
      return authority.run(execution, () => handler.execute(request, context));
    },
  };
}

export function renewingMutableComputerContract(
  handler: MutableComputerContract,
  authority: RenewableComputerAuthority,
): MutableComputerContract {
  return {
    async execute(request, context) {
      let execution;
      try {
        execution = await authority.admitExecution(15_000);
      } catch (error) {
        return admissionError(error);
      }
      return authority.run(execution, () => handler.execute(request, context));
    },
  };
}
