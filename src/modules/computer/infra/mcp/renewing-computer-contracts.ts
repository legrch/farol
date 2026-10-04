import {
  ReadonlyComputerCallRequestSchema,
  type ReadonlyComputerContract,
} from "../../contract/readonly-computer-contract";
import {
  MutableComputerCallRequestSchema,
  type MutableComputerContract,
} from "../../contract/mutable-computer-contract";
import { readonlyComputerExecutionLeaseMs } from "../../app/service/run-readonly-computer-action";
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
        execution = await authority.admitExecution(
          readonlyComputerExecutionLeaseMs(parsed.data.operation),
        );
      } catch (error) {
        return {
          ok: false as const,
          correlation: readonlyComputerCallCorrelation(parsed.data),
          error: admissionError(error),
        };
      }
      return authority.run(execution, async () => {
        const result = await handler.execute(request, context);
        if (!result.ok) return result;
        // A subtree read or Git verification can yield while policy changes
        // without a generation bump. Recheck the whole admitted ceiling before
        // disclosing output; never redispatch the completed operation.
        let current;
        try {
          current = await execution.current();
        } catch (error) {
          return {
            ok: false as const,
            correlation: readonlyComputerCallCorrelation(parsed.data),
            error: admissionError(error),
          };
        }
        if (!current) {
          return {
            ok: false as const,
            correlation: readonlyComputerCallCorrelation(parsed.data),
            error: admissionError(new Error("AUTHORITY_COMPUTER_MISMATCH")),
          };
        }
        if (context?.signal?.aborted) {
          return {
            ok: false as const,
            correlation: readonlyComputerCallCorrelation(parsed.data),
            error: {
              code: "WORKSPACE_REQUEST_CANCELLED" as const,
              source: "native-workspace" as const,
              retry: "never" as const,
            },
          };
        }
        return result;
      });
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
