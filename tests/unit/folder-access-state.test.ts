import { describe, expect, it } from "vitest";
import { ProductSettingsSchema } from "../../src/pkg/product-settings/contract";
import {
  allFoldersChecked,
  folderAccessChecked,
  folderDisplayName,
} from "../../src/ui/folder-access-state";
import {
  fixtureBuildId,
  guidedSettingsFixture,
} from "../fixtures/guided-onboarding";

function twoFolders() {
  const settings = guidedSettingsFixture();
  const first = settings.computer.workspaces[0]!;
  const second = {
    ...structuredClone(first),
    workspaceId: "00000000-0000-4000-8000-000000000099",
    root: "/tmp/another-project",
    label: "Internal test fixture",
  };
  settings.computer.workspaces.push(second);
  return settings;
}

describe("setup folder access evidence", () => {
  it("checks all folders independently, not just the connection witness", () => {
    const settings = twoFolders();
    expect(allFoldersChecked(settings, fixtureBuildId)).toBe(true);
    settings.computer.workspaces[1]!.accessCheck = null;
    expect(
      folderAccessChecked(
        settings,
        settings.computer.workspaces[0]!,
        fixtureBuildId,
      ),
    ).toBe(true);
    expect(allFoldersChecked(settings, fixtureBuildId)).toBe(false);
  });
  it("does not paint a saved but unchecked folder green", () => {
    const settings = twoFolders();
    delete settings.computer.workspaces[1]!.accessCheck;
    expect(allFoldersChecked(settings, fixtureBuildId)).toBe(false);
    expect(
      folderAccessChecked(
        settings,
        settings.computer.workspaces[1]!,
        fixtureBuildId,
      ),
    ).toBe(false);
  });
  it("does not inherit an old single-folder witness after a failed check", () => {
    const settings = guidedSettingsFixture();
    const folder = settings.computer.workspaces[0]!;
    delete folder.accessCheck;
    expect(folderAccessChecked(settings, folder, fixtureBuildId)).toBe(true);
    folder.accessCheck = null;
    expect(folderAccessChecked(settings, folder, fixtureBuildId)).toBe(false);
  });
  it.each(["build", "generation", "device", "inode", "missing-identity"])(
    "invalidates %s drift",
    (field) => {
      const settings = twoFolders();
      const folder = settings.computer.workspaces[0]!;
      if (field === "build") folder.accessCheck!.buildId = "f".repeat(64);
      if (field === "generation") settings.computer.generation += 1;
      if (field === "device") folder.rootIdentity!.device = "9";
      if (field === "inode") folder.rootIdentity!.inode = "9";
      if (field === "missing-identity") delete folder.rootIdentity;
      expect(allFoldersChecked(settings, fixtureBuildId)).toBe(false);
    },
  );
  it("does not count an empty folder list as completed setup", () => {
    const settings = guidedSettingsFixture();
    settings.computer.workspaces = [];
    expect(allFoldersChecked(settings, fixtureBuildId)).toBe(false);
  });
  it("displays actual folders rather than internal test labels", () => {
    const settings = twoFolders();
    expect(folderDisplayName(settings.computer.workspaces[1]!)).toBe(
      "another-project",
    );
    expect(settings.computer.workspaces).toHaveLength(2);
  });
  it("preserves successful and failed evidence across schema round trips", () => {
    const settings = twoFolders();
    settings.computer.workspaces[1]!.accessCheck = null;
    const restored = ProductSettingsSchema.parse(
      JSON.parse(JSON.stringify(settings)),
    );
    expect(
      folderAccessChecked(
        restored,
        restored.computer.workspaces[0]!,
        fixtureBuildId,
      ),
    ).toBe(true);
    expect(
      folderAccessChecked(
        restored,
        restored.computer.workspaces[1]!,
        fixtureBuildId,
      ),
    ).toBe(false);
  });
});
