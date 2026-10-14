import { plistValue } from "./runtime-contract.mjs";

// Build-only producer: call only after source/core and vendor authentication.
// Read the authenticated vendor floor without inventing a fallback or accepting
// XML markup. Canonical macOS versions have two or three numeric components.
export function packageInfoPlist({
  runtimePlist,
  bundleVersion,
  buildVersion,
}) {
  let minimumSystemVersion;
  try {
    minimumSystemVersion = plistValue(runtimePlist, "LSMinimumSystemVersion");
  } catch (cause) {
    throw new Error("PACKAGE_RUNTIME_MINIMUM_SYSTEM_VERSION_INVALID", {
      cause,
    });
  }
  if (
    !/^[1-9][0-9]*\.(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*))?$/u.test(
      minimumSystemVersion,
    )
  ) {
    throw new Error("PACKAGE_RUNTIME_MINIMUM_SYSTEM_VERSION_INVALID");
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>Farol</string>
  <key>CFBundleIconFile</key>
  <string>farol.icns</string>
  <key>CFBundleExecutable</key>
  <string>Farol Next Preview</string>
  <key>CFBundleIdentifier</key>
  <string>local.farol.next.preview</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Farol</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${bundleVersion}</string>
  <key>CFBundleVersion</key>
  <string>${buildVersion}</string>
  <key>LSMinimumSystemVersion</key>
  <string>${minimumSystemVersion}</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSHumanReadableCopyright</key>
  <string>Local development preview</string>
</dict>
</plist>
`;
}
