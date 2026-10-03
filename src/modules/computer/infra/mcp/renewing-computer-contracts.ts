import {
  ReadonlyComputerCallRequestSchema,
  type ReadonlyComputerContract,
} from "../../contract/readonly-computer-contract";
import {
  MutableComputerCallRequestSchema,
  type MutableComputerContract,
} from "../../contract/mutable-computer-contract";
import { readonlyComputerCallCorrelation } from "../readonly-contract-handler";
import { mutableComputerCallCorrelation } from "../mutable-contract-handler";
import type { RenewableComputerAuthority } from "./renewable-computer-authority";

const invalidRequest = () => ({
  ok: false as const,
  correlation: null,
  error: {
    code: "COMPUTER_INVALID_REQUEST" as const,
    source: "contract" as const,
    retry: "never" as const,
  },
});
type RenewalAdmissionError = Readonly<{
  code:
    | "AUTHORITY_COMPUTER_MISMATCH"
    | "COMPUTER_APPROVAL_NOT_FOUND"
    | "AUTHORITY_EXPIRED"
    | "COMPUTER_APPROVAL_STORE_UNAVAILABLE";
  source: "computer-policy" | "task-admission" | "authority-store";
  retry: "never";
}>;
const admissionError = (error: unknown): RenewalAdmissionError => {
  const code = error instanceof Error ? error.message : "";
  if (
    code === "AUTHORITY_COMPUTER_MISMATCH" ||
    code === "COMPUTER_APPROVAL_NOT_FOUND"
  ) {
    return {
      code,
      source: "computer-policy" as const,
      retry: "never" as const,
    };
  }
  if (code === "AUTHORITY_EXPIRED")
    return { code, source: "task-admission" as const, retry: "never" as const };
  return {
    code: "COMPUTER_APPROVAL_STORE_UNAVAILABLE" as const,
    source: "authority-store" as const,
    retry: "never" as const,
  };
};

export function renewingReadonlyComputerContract(
  handler: ReadonlyComputerContract,
  authority: RenewableComputerAuthority,
): ReadonlyComputerContract {
  return {
    async execute(request, context) {
      const parsed = ReadonlyComputerCallRequestSchema.safeParse(request);
      if (!parsed.success) return invalidRequest();
      let execution;
      try {
        execution = await authority.admitExecution(15_000);
      } catch (error) {
        return {
          ok: false as const,
          correlation: readonlyComputerCallCorrelation(parsed.data),
          error: admissionError(error),
        };
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
      const parsed = MutableComputerCallRequestSchema.safeParse(request);
      if (!parsed.success) return invalidRequest();
      let execution;
      try {
        execution = await authority.admitExecution(15_000);
      } catch (error) {
        return {
          ok: false as const,
          correlation: mutableComputerCallCorrelation(parsed.data),
          error: admissionError(error),
        };
      }
      return authority.run(execution, () => handler.execute(request, context));
    },
  };
}
