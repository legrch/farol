import { createHash } from "node:crypto";
import type { AgentCommandDigester } from "../../app/port/agent-command-digester";

export class Sha256AgentCommandDigester implements AgentCommandDigester {
  digest(canonicalCommand: string): string {
    return createHash("sha256").update(canonicalCommand).digest("hex");
  }
}
