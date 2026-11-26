import { createHash } from "node:crypto";
import path from "node:path";

const KEY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TEMPORARY_SUFFIX_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/iu;

/** Root entries that belong to project preferences, not to a dispatch. */
const PREFERENCE_ROOT_ENTRY =
  /^project-preference-(?:[a-f0-9-]{36}\.json|selections-[a-f0-9]{64})$/u;
/** The closed set of record files one dispatch directory may hold. */
const DISPATCH_RECORD_FILE =
  /^(?:reservation|thread-intent|thread|turn-intent|turn|continuation-child|continuation-verified|message-intent|message|title-intent|title|(?:dispatch-attempt|pre-effect-proof)-(?:[0-9]|[12][0-9]|3[01]))\.json$/u;
const SELECTION_SLOT = /^[0-9]{6}\.json$/u;
const SELECTION_WITNESS = /^witness-[0-9]{6}\.json$/u;
const SELECTION_ENTRY =
  /^(?:witness-)?[0-9]{6}\.json(?:\.[0-9a-f-]{36}\.tmp)?$/iu;
const SELECTION_PUBLISHED_ENTRY = /^(?:witness-)?[0-9]{6}\.json$/u;

export const MAX_ROOT_ENTRIES = 4096;
export const MAX_DISPATCH_FILES = 80;

export function validKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

export function isPreferenceRootEntry(name: string): boolean {
  return PREFERENCE_ROOT_ENTRY.test(name);
}

export function isDispatchRecordFile(name: string): boolean {
  return DISPATCH_RECORD_FILE.test(name);
}

/** The lowercase directory name of one dispatch under the journal root. */
export function dispatchDirectory(root: string, key: string): string {
  return path.join(root, key.toLowerCase());
}

export function preferenceFile(root: string, key: string): string {
  return path.join(root, `project-preference-${key.toLowerCase()}.json`);
}

export function preferenceSelectionDirectory(
  root: string,
  canonicalProject: unknown,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(canonicalProject), "utf8")
    .digest("hex");
  return path.join(root, `project-preference-selections-${digest}`);
}

export function selectionSlotName(sequence: number): string {
  return `${String(sequence).padStart(6, "0")}.json`;
}

export function selectionWitnessName(sequence: number): string {
  return `witness-${String(sequence).padStart(6, "0")}.json`;
}

export function selectionSlots(entries: readonly string[]): string[] {
  return entries.filter((name) => SELECTION_SLOT.test(name)).sort();
}

export function selectionWitnesses(entries: readonly string[]): string[] {
  return entries.filter((name) => SELECTION_WITNESS.test(name)).sort();
}

export function selectionPublished(entries: readonly string[]): string[] {
  return entries.filter((name) => SELECTION_PUBLISHED_ENTRY.test(name)).sort();
}

export function selectionEntryUnexpected(name: string): boolean {
  return !SELECTION_ENTRY.test(name);
}

/** True when `name` is a private temporary link sibling of `basename`. */
export function isTemporaryAlias(basename: string, name: string): boolean {
  return (
    name.startsWith(`${basename}.`) &&
    TEMPORARY_SUFFIX_PATTERN.test(name.slice(basename.length + 1))
  );
}
