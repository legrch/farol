import type {
  ActivityRecord,
  ActivityRecorder,
} from "../../app/port/activity-recorder";

export class ActivityLog implements ActivityRecorder {
  private readonly records: ActivityRecord[] = [];

  constructor(private readonly capacity = 256) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error("ACTIVITY_CAPACITY_INVALID");
    }
  }

  async record(record: ActivityRecord): Promise<void> {
    this.records.push(structuredClone(record));
    if (this.records.length > this.capacity) this.records.shift();
  }

  snapshot(): readonly ActivityRecord[] {
    return structuredClone(this.records);
  }
}
