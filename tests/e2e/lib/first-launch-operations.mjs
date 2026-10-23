import { OperationsSnapshotSchema } from "../../../apps/desktop/renderer/operations-contract.ts";

// A native witness requires the producer's actual uncertainty diagnostic.
// The ordinary reader's compatibility default cannot qualify missing evidence.
const witnessSchema = OperationsSnapshotSchema.extend({
  unrecordedUncertainEntries:
    OperationsSnapshotSchema.shape.unrecordedUncertainEntries.removeDefault(),
});

export function parseFirstLaunchOperations(value) {
  return witnessSchema.parse(value);
}
