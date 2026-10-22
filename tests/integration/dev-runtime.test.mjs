import { describe, expect, it } from "vitest";
import { devInfoPlist, devExecutables } from "../../tooling/dev-runtime.mjs";

// Plist transformation only. Actual Dock/Cmd-Tab naming requires native proof.
const vendor = `<?xml version="1.0"?><plist><dict>
<key>CFBundleDisplayName</key><string>Electron</string>
<key>CFBundleName</key><string>Electron</string>
<key>CFBundleIdentifier</key><string>com.github.Electron</string>
<key>CFBundleIconFile</key><string>electron.icns</string>
<key>CFBundleExecutable</key><string>Electron</string>
<key>CFBundleVersion</key><string>44.4.2</string></dict></plist>`;

describe("Dev-only macOS bundle presentation", () => {
  it("changes only the four explicit presentation fields", () => {
    const result = devInfoPlist(vendor);
    expect(result.match(/<string>Farol Dev<\/string>/gu)).toHaveLength(2);
    expect(result).toContain("<string>local.farol.dev</string>");
    expect(result).toContain("<string>farol-dev.icns</string>");
    expect(result).toContain(
      "<key>CFBundleExecutable</key><string>Electron</string>",
    );
    expect(result).toContain(
      "<key>CFBundleVersion</key><string>44.4.2</string>",
    );
    expect(vendor).toContain("<string>com.github.Electron</string>");
  });
  it.each([
    vendor.replace("com.github.Electron", "local.farol.owner.preview"),
    vendor.replace("<key>CFBundleName</key>", "<key>unexpected</key>"),
    vendor + "<key>CFBundleName</key><string>Electron</string>",
  ])(
    "refuses unexpected input instead of editing a foreign identity",
    (plist) => {
      expect(() => devInfoPlist(plist)).toThrow("DEV_RUNTIME_PLIST_INVALID");
    },
  );
  it("limits restart compatibility to two exact checkout executables", () => {
    expect(devExecutables("/fixture/farol")).toEqual([
      "/fixture/farol/_output/dev-runtime/Farol Dev.app/Contents/MacOS/Electron",
      "/fixture/farol/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    ]);
  });
});
