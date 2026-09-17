import type {
  CodexCallerRelayOperation,
  CodexCallerRelayResponse,
} from "../../../../pkg/caller-relay/protocol";

export interface CodexCallerRelayPort {
  request(
    operation: CodexCallerRelayOperation,
  ): Promise<CodexCallerRelayResponse>;
}
