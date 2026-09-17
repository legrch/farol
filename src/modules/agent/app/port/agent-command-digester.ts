export interface AgentCommandDigester {
  digest(canonicalCommand: string): string;
}
