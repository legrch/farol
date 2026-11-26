import { describe, expect, it, vi } from "vitest";
import { createPreferences, type PreferenceFiles } from "./preference";

const files: PreferenceFiles = {
  preferences: "/r/preferences.json",
  notices: "/r/notice-preferences.json",
  automatic: "/r/automatic-update-preference.json",
  automaticUnconfirmed: "/r/automatic-update-unconfirmed.json",
  quit: "/r/install-on-quit-preference.json",
  quitUnconfirmed: "/r/install-on-quit-unconfirmed.json",
};
const errno = (code: string) =>
  Object.assign(new Error(code), { code }) as NodeJS.ErrnoException;

// An in-memory directory: `records` holds parsed JSON, `present` holds every
// path that exists even when its parsed value is null.
function fixture(
  initial: Record<string, unknown> = {},
  options: { probeError?: Record<string, unknown>; readError?: string } = {},
) {
  const records = new Map<string, unknown>(Object.entries(initial));
  const readRecord = vi.fn(async (file: string) => {
    if (options.readError === file) throw new Error("UPDATE_RECORD_REFUSED");
    return records.has(file) ? (records.get(file) ?? null) : null;
  });
  const probe = vi.fn(async (file: string) => {
    if (file in (options.probeError ?? {})) throw options.probeError![file];
    if (!records.has(file)) throw errno("ENOENT");
    return {};
  });
  const ensureRoot = vi.fn(async () => undefined);
  const preferences = createPreferences({
    files,
    readRecord,
    probe,
    ensureRoot,
  });
  return { records, readRecord, probe, ensureRoot, preferences };
}

describe("update preferences", () => {
  it("defaults to no skip and no deferral only when the record is absent", async () => {
    expect(await fixture().preferences.readPreferences()).toEqual({
      schema: "farol.installed-update-preferences/1",
      skipped: null,
      deferredVersion: null,
    });
  });

  it("reads a valid skip and refuses malformed or foreign records", async () => {
    const skipped = { version: "1.2.3", buildId: "a".repeat(64) };
    const valid = {
      schema: "farol.installed-update-preferences/1",
      skipped,
    };
    expect(
      await fixture({
        [files.preferences]: valid,
      }).preferences.readPreferences(),
    ).toEqual(valid);
    for (const bad of [
      { ...valid, extra: 1 },
      { schema: "other/1", skipped: null },
      { ...valid, skipped: { version: "1", buildId: "short" } },
      "text",
      [],
    ])
      await expect(
        fixture({ [files.preferences]: bad }).preferences.readPreferences(),
      ).rejects.toThrow();
  });

  it("propagates a refused read instead of defaulting", async () => {
    await expect(
      fixture(
        {},
        { readError: files.preferences },
      ).preferences.readPreferences(),
    ).rejects.toThrow("UPDATE_RECORD_REFUSED");
    await expect(
      fixture({}, { readError: files.notices }).preferences.readNotices(),
    ).rejects.toThrow("UPDATE_RECORD_REFUSED");
  });

  it("defaults notices to nothing seen, and refuses a malformed record", async () => {
    expect(await fixture().preferences.readNotices()).toEqual({
      schema: "farol.installed-update-notices/1",
      seenVersion: null,
      failureNotice: null,
    });
    const valid = {
      schema: "farol.installed-update-notices/1",
      seenVersion: "1.0.0",
    };
    expect(
      await fixture({ [files.notices]: valid }).preferences.readNotices(),
    ).toEqual(valid);
    await expect(
      fixture({
        [files.notices]: { ...valid, failureNotice: { code: "bad" } },
      }).preferences.readNotices(),
    ).rejects.toThrow();
  });

  describe("automatic update", () => {
    const record = (enabled: boolean) => ({
      schema: "farol.installed-automatic-update-preference/1",
      enabled,
    });

    it("is OFF only when the record is verifiably absent", async () => {
      const { preferences, ensureRoot, probe } = fixture();
      expect(await preferences.readAutomatic()).toEqual(record(false));
      expect(ensureRoot).toHaveBeenCalledOnce();
      expect(probe).toHaveBeenCalledWith(files.automaticUnconfirmed);
      expect(probe).toHaveBeenCalledWith(files.automatic);
    });

    it("reads both schema versions", async () => {
      const v2 = {
        schema: "farol.installed-automatic-update-preference/2",
        scope: "download-and-install",
        enabled: true,
      };
      expect(
        await fixture({
          [files.automatic]: record(true),
        }).preferences.readAutomatic(),
      ).toEqual(record(true));
      expect(
        await fixture({ [files.automatic]: v2 }).preferences.readAutomatic(),
      ).toEqual(v2);
    });

    it("refuses a JSON null record that exists as INVALID, not as default OFF", async () => {
      const { preferences } = fixture({ [files.automatic]: null });
      await expect(preferences.readAutomatic()).rejects.toThrow(
        "UPDATE_AUTOMATIC_PREFERENCE_INVALID",
      );
    });

    it("refuses malformed records", async () => {
      for (const bad of [
        { ...record(true), extra: 1 },
        {
          schema: "farol.installed-automatic-update-preference/2",
          enabled: true,
        },
        {
          schema: "farol.installed-automatic-update-preference/1",
          enabled: "yes",
        },
        "x",
      ])
        await expect(
          fixture({ [files.automatic]: bad }).preferences.readAutomatic(),
        ).rejects.toThrow();
    });

    it("is unknown while the write witness exists, and stays unknown", async () => {
      const { preferences, records, readRecord } = fixture({
        [files.automatic]: record(true),
        [files.automaticUnconfirmed]: {},
      });
      expect(preferences.automaticUnknown()).toBe(false);
      await expect(preferences.readAutomatic()).rejects.toThrow(
        "UPDATE_AUTOMATIC_PREFERENCE_OUTCOME_UNKNOWN",
      );
      expect(preferences.automaticUnknown()).toBe(true);
      expect(readRecord).not.toHaveBeenCalled();
      // Removing the witness does not clear a flag this owner already raised.
      records.delete(files.automaticUnconfirmed);
      await expect(preferences.readAutomatic()).rejects.toThrow(
        "UPDATE_AUTOMATIC_PREFERENCE_OUTCOME_UNKNOWN",
      );
    });

    it("stays unknown after a writer marks it, even with valid bytes", async () => {
      const { preferences } = fixture({ [files.automatic]: record(true) });
      expect(await preferences.readAutomatic()).toEqual(record(true));
      preferences.markAutomaticUnknown();
      expect(preferences.automaticUnknown()).toBe(true);
      await expect(preferences.readAutomatic()).rejects.toThrow(
        "UPDATE_AUTOMATIC_PREFERENCE_OUTCOME_UNKNOWN",
      );
    });

    it("rethrows probe faults other than absence", async () => {
      await expect(
        fixture(
          {},
          {
            probeError: { [files.automaticUnconfirmed]: errno("EACCES") },
          },
        ).preferences.readAutomatic(),
      ).rejects.toThrow("EACCES");
      await expect(
        fixture(
          { [files.automatic]: null },
          {
            probeError: { [files.automatic]: errno("EIO") },
          },
        ).preferences.readAutomatic(),
      ).rejects.toThrow("EIO");
      await expect(
        fixture(
          {},
          {
            probeError: { [files.automatic]: errno("EACCES") },
          },
        ).preferences.readAutomatic(),
      ).rejects.toThrow("EACCES");
    });

    it("propagates a refused root or record read", async () => {
      const f = fixture();
      f.ensureRoot.mockRejectedValueOnce(
        new Error("UPDATE_PRIVATE_STATE_INVALID"),
      );
      await expect(f.preferences.readAutomatic()).rejects.toThrow(
        "UPDATE_PRIVATE_STATE_INVALID",
      );
      await expect(
        fixture({}, { readError: files.automatic }).preferences.readAutomatic(),
      ).rejects.toThrow("UPDATE_RECORD_REFUSED");
    });
  });

  describe("install on quit", () => {
    const record = (enabled: boolean) => ({
      schema: "farol.installed-install-on-quit-preference/1",
      scope: "install-on-normal-quit",
      enabled,
    });
    const witness = {
      schema: "farol.installed-install-on-quit-unconfirmed/1",
      enabled: true,
    };

    it("is confirmed OFF only when the record is verifiably absent", async () => {
      const { preferences, ensureRoot } = fixture();
      expect(await preferences.readQuit()).toEqual({
        status: "confirmed",
        scope: "install-on-normal-quit",
        enabled: false,
      });
      expect(ensureRoot).toHaveBeenCalledOnce();
    });

    it("reads the confirmed choice", async () => {
      for (const enabled of [true, false])
        expect(
          await fixture({
            [files.quit]: record(enabled),
          }).preferences.readQuit(),
        ).toEqual({
          status: "confirmed",
          scope: "install-on-normal-quit",
          enabled,
        });
    });

    it("refuses a JSON null record that exists", async () => {
      await expect(
        fixture({ [files.quit]: null }).preferences.readQuit(),
      ).rejects.toThrow("UPDATE_QUIT_PREFERENCE_INVALID");
    });

    it("refuses a JSON null witness that exists", async () => {
      await expect(
        fixture({ [files.quitUnconfirmed]: null }).preferences.readQuit(),
      ).rejects.toThrow("UPDATE_QUIT_PREFERENCE_INVALID");
    });

    it("refuses malformed choice and malformed witness", async () => {
      for (const bad of [
        { ...record(true), extra: 1 },
        { ...record(true), scope: "elsewhere" },
        { ...record(true), enabled: 1 },
        "x",
      ])
        await expect(
          fixture({ [files.quit]: bad }).preferences.readQuit(),
        ).rejects.toThrow();
      for (const bad of [{ ...witness, extra: 1 }, { schema: "other/1" }, "x"])
        await expect(
          fixture({ [files.quitUnconfirmed]: bad }).preferences.readQuit(),
        ).rejects.toThrow();
    });

    it("reports unknown, never the stored choice, while the witness exists", async () => {
      const { preferences, readRecord } = fixture({
        [files.quit]: record(true),
        [files.quitUnconfirmed]: witness,
      });
      expect(await preferences.readQuit()).toEqual({
        status: "unknown",
        enabled: false,
        code: "UPDATE_QUIT_PREFERENCE_OUTCOME_UNKNOWN",
      });
      expect(readRecord).not.toHaveBeenCalledWith(files.quit);
    });

    it("stays unknown after the witness disappears or a writer marks it", async () => {
      const { preferences, records } = fixture({
        [files.quit]: record(true),
        [files.quitUnconfirmed]: witness,
      });
      await preferences.readQuit();
      records.delete(files.quitUnconfirmed);
      expect((await preferences.readQuit()).status).toBe("unknown");

      const marked = fixture({ [files.quit]: record(true) });
      expect((await marked.preferences.readQuit()).status).toBe("confirmed");
      marked.preferences.markQuitUnknown();
      expect(await marked.preferences.readQuit()).toEqual({
        status: "unknown",
        enabled: false,
        code: "UPDATE_QUIT_PREFERENCE_OUTCOME_UNKNOWN",
      });
    });

    it("rethrows probe faults other than absence and a refused root", async () => {
      await expect(
        fixture(
          { [files.quit]: null },
          {
            probeError: { [files.quit]: errno("EIO") },
          },
        ).preferences.readQuit(),
      ).rejects.toThrow("EIO");
      await expect(
        fixture(
          {},
          {
            probeError: { [files.quitUnconfirmed]: errno("EACCES") },
          },
        ).preferences.readQuit(),
      ).rejects.toThrow("EACCES");
      await expect(
        fixture(
          {},
          {
            probeError: { [files.quit]: errno("EACCES") },
          },
        ).preferences.readQuit(),
      ).rejects.toThrow("EACCES");
      const f = fixture();
      f.ensureRoot.mockRejectedValueOnce(
        new Error("UPDATE_PRIVATE_STATE_INVALID"),
      );
      await expect(f.preferences.readQuit()).rejects.toThrow(
        "UPDATE_PRIVATE_STATE_INVALID",
      );
    });

    it("keeps the automatic and quit flags independent", async () => {
      const { preferences } = fixture();
      preferences.markQuitUnknown();
      expect(preferences.automaticUnknown()).toBe(false);
      expect(await preferences.readAutomatic()).toMatchObject({
        enabled: false,
      });
    });
  });
});
