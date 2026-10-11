import { describe, expect, it } from "vitest";
import { connectorVerificationProof } from "../../src/apps/desktop/connector-verification-proof";
import type {
  ComputerConnectorCatalogueVerificationReceipt,
  ComputerConnectorVerificationReceipt,
} from "../../apps/desktop/bridge/wire";

// Projection fixtures only. The bridge separately validates digests and identity.
const binding = {
  buildId: "build",
  profileId: "profile",
  backendGeneration: "backend",
  runtimeId: "runtime",
  connectorGeneration: "1",
};
const common = {
  binding,
  execution: {
    ownerId: "owner",
    sessionId: "session",
    taskId: "task",
    taskEpoch: "1",
    participantId: "participant",
    turnId: "turn",
    generation: "1",
  },
  challengeSha256: "a".repeat(64),
  callIdSha256: "b".repeat(64),
};
const receipt: ComputerConnectorVerificationReceipt = {
  ...common,
  workspaceId: "workspace",
  entryCount: 0,
  truncated: false,
};
const catalogueReceipt: ComputerConnectorCatalogueVerificationReceipt = {
  ...common,
  workspaceCount: 0,
};

describe("connection verification proof projection", () => {
  it("keeps empty-catalogue proof distinct from an empty folder listing", () => {
    expect(connectorVerificationProof({ binding, catalogueReceipt })).toEqual({
      receipt: catalogueReceipt,
      workspaceId: null,
    });
    expect(connectorVerificationProof({ binding, receipt })).toEqual({
      receipt,
      workspaceId: "workspace",
    });
  });
  it("does not select ambiguous or missing proof", () => {
    expect(connectorVerificationProof({ binding })).toBeNull();
    expect(
      connectorVerificationProof({ binding, receipt, catalogueReceipt }),
    ).toBeNull();
  });
});
