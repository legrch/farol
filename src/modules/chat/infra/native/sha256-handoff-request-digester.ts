import { createHash } from "node:crypto";

import type {
  HandoffMessage,
  HandoffRequest,
  HandoffRequestDigester,
} from "../../app/service/persistent-codex-handoff";

export class Sha256HandoffRequestDigester implements HandoffRequestDigester {
  digest(request: HandoffRequest): string {
    return createHash("sha256")
      .update(JSON.stringify(request), "utf8")
      .digest("hex");
  }

  digestMessage(request: HandoffMessage): string {
    return createHash("sha256")
      .update(JSON.stringify(request), "utf8")
      .digest("hex");
  }
}
