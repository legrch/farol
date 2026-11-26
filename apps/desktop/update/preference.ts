import {
  AutomaticUpdatePreferences,
  InstallOnQuitPreferences,
  InstallOnQuitUnconfirmed,
  NoticePreferences,
  UpdatePreferences,
} from "./record";

// The update preference readers over the guarded private records. Every read
// fails closed: an unreadable, malformed or unexpectedly shaped record throws,
// and only a verified absence (the record is not there at all) is the default.
// A prewritten "unconfirmed" witness means a past write may or may not have
// landed, so the choice is unknown and is never inferred from valid-looking
// bytes. This file owns the in-memory unknown flags; the writers stay with the
// release owner and mark them through here.

export type PreferenceFiles = Readonly<{
  preferences: string;
  notices: string;
  automatic: string;
  automaticUnconfirmed: string;
  quit: string;
  quitUnconfirmed: string;
}>;

export type PreferencePorts = Readonly<{
  files: PreferenceFiles;
  // The guarded private record read: null for absent files and JSON null alike.
  readRecord(file: string): Promise<unknown | null>;
  // A bare existence probe. Resolves when the entry exists and rejects with the
  // filesystem error otherwise, so absence is told apart from every other fault.
  probe(file: string): Promise<unknown>;
  // Authenticates the owned private state directory before a read.
  ensureRoot(): Promise<void>;
}>;

const isAbsent = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException).code === "ENOENT";

export function createPreferences(ports: PreferencePorts) {
  const { files } = ports;
  let automaticUnknown = false;
  let quitUnknown = false;

  const readPreferences = async () => {
    const raw = await ports.readRecord(files.preferences);
    return raw === null
      ? {
          schema: "farol.installed-update-preferences/1" as const,
          skipped: null,
          deferredVersion: null,
        }
      : UpdatePreferences.parse(raw);
  };

  const readNotices = async () => {
    const raw = await ports.readRecord(files.notices);
    return raw === null
      ? {
          schema: "farol.installed-update-notices/1" as const,
          seenVersion: null,
          failureNotice: null,
        }
      : NoticePreferences.parse(raw);
  };

  const readAutomatic = async () => {
    try {
      await ports.probe(files.automaticUnconfirmed);
      automaticUnknown = true;
    } catch (error) {
      if (!isAbsent(error)) throw error;
    }
    if (automaticUnknown)
      throw new Error("UPDATE_AUTOMATIC_PREFERENCE_OUTCOME_UNKNOWN");
    await ports.ensureRoot();
    const raw = await ports.readRecord(files.automatic);
    if (raw === null) {
      // readRecord also returns JSON null. Only actual absence is default OFF.
      try {
        await ports.probe(files.automatic);
      } catch (error) {
        if (isAbsent(error))
          return {
            schema: "farol.installed-automatic-update-preference/1" as const,
            enabled: false,
          };
        throw error;
      }
      throw new Error("UPDATE_AUTOMATIC_PREFERENCE_INVALID");
    }
    return AutomaticUpdatePreferences.parse(raw);
  };

  const readQuit = async () => {
    await ports.ensureRoot();
    const unconfirmed = await ports.readRecord(files.quitUnconfirmed);
    if (unconfirmed !== null) {
      InstallOnQuitUnconfirmed.parse(unconfirmed);
      quitUnknown = true;
    } else {
      try {
        await ports.probe(files.quitUnconfirmed);
        throw new Error("UPDATE_QUIT_PREFERENCE_INVALID");
      } catch (error) {
        if (!isAbsent(error)) throw error;
      }
    }
    if (quitUnknown)
      return {
        status: "unknown" as const,
        enabled: false as const,
        code: "UPDATE_QUIT_PREFERENCE_OUTCOME_UNKNOWN",
      };
    const raw = await ports.readRecord(files.quit);
    if (raw === null) {
      try {
        await ports.probe(files.quit);
      } catch (error) {
        if (isAbsent(error))
          return {
            status: "confirmed" as const,
            scope: "install-on-normal-quit" as const,
            enabled: false,
          };
        throw error;
      }
      throw new Error("UPDATE_QUIT_PREFERENCE_INVALID");
    }
    return {
      status: "confirmed" as const,
      scope: "install-on-normal-quit" as const,
      enabled: InstallOnQuitPreferences.parse(raw).enabled,
    };
  };

  return Object.freeze({
    readPreferences,
    readNotices,
    readAutomatic,
    readQuit,
    automaticUnknown: () => automaticUnknown,
    markAutomaticUnknown: () => {
      automaticUnknown = true;
    },
    markQuitUnknown: () => {
      quitUnknown = true;
    },
  });
}
