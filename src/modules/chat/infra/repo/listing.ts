// Directory-listing filters of the private context store: which entry names
// are records of which kind. Pure string rules; nothing here touches the
// filesystem.

const TASK_KEY = /^[a-f0-9]{64}$/u;
const KEYED_RECORD = /^[a-f0-9]{64}\.json$/u;
const PUBLICATION_RECORD = /^publication-[a-f0-9]{64}\.json$/u;
const COMPLETION_RECORD = /^completion-[a-f0-9]{64}\.json$/u;
const OPERATION_RECORD = /^(?:[a-f0-9]{64}|[0-9]+)\.json$/u;

// A task directory is named by its binding key.
export function isTaskKey(name: string): boolean {
  return TASK_KEY.test(name);
}

// A checkpoint, summary or summary-attempt record named by its key.
export function isKeyedRecord(name: string): boolean {
  return KEYED_RECORD.test(name);
}

export function isPublicationRecord(name: string): boolean {
  return PUBLICATION_RECORD.test(name);
}

export function isCompletionRecord(name: string): boolean {
  return COMPLETION_RECORD.test(name);
}

// Any record that can carry an operation id, including epoch admissions.
export function isOperationRecord(name: string): boolean {
  return OPERATION_RECORD.test(name);
}
