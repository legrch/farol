import { createHash } from "node:crypto";

import type {
  HandoffAdopt,
  HandoffContinue,
  HandoffMessage,
  HandoffRequest,
  HandoffRequestDigester,
  HandoffTitleRequest,
} from "../../app/service/persistent-codex-handoff";

export class Sha256HandoffRequestDigester implements HandoffRequestDigester {
  digestTitle(request: HandoffTitleRequest): string {
    return createHash("sha256")
      .update(JSON.stringify(request), "utf8")
      .digest("hex");
  }
  digestAdopt(request: HandoffAdopt): string {
    return createHash("sha256")
      .update(JSON.stringify(request), "utf8")
      .digest("hex");
  }
  digest(request: HandoffRequest): string {
    return createHash("sha256")
      .update(JSON.stringify(request), "utf8")
      .digest("hex");
  }

  digestContinue(request: HandoffContinue): string {
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
