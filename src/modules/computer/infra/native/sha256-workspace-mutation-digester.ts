import { createHash } from "node:crypto";

import type {
  WorkspaceMutationDigester,
  WorkspaceMutationDigestInput,
} from "../../app/port/workspace-mutation-repository";

export class Sha256WorkspaceMutationDigester implements WorkspaceMutationDigester {
  digest(input: WorkspaceMutationDigestInput): string {
    const operation = input.operation;
    const canonical =
      operation.kind === "workspace.write"
        ? [
            input.workspaceId,
            operation.kind,
            operation.relativePath,
            operation.expectedSha256,
            operation.content,
          ]
        : [
            input.workspaceId,
            operation.kind,
            operation.relativePath,
            operation.expectedSha256,
            operation.edits.map((edit) => [edit.oldText, edit.newText]),
          ];
    return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
  }
}
