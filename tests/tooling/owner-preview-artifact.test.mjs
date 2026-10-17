import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertDerivativeTrees,
  derivePreviewTree,
  derivativeManifest,
  generationIdentity,
  pinCurrentGeneration,
  regularBytes,
} from "../../tooling/verify-owner-preview.mjs";
import {
  PREVIEW_LAUNCHER_PATH,
  PREVIEW_ASSET_PATHS,
  previewPlist,
  previewLinkTarget,
} from "../../tooling/owner-preview-contract.mjs";
import {
  previewSvg,
  assertPreviewAssets,
} from "../../tooling/owner-preview-assets.mjs";
const { test } = await import(
  process.env.VITEST === "true" ? "vitest" : "node:test"
);
const plist = `<?xml version="1.0"?><plist><dict>
<key>CFBundleDisplayName</key><string>Farol</string>
<key>CFBundleName</key><string>Farol</string>
<key>CFBundleIdentifier</key><string>local.farol.next.preview</string>
<key>CFBundleIconFile</key><string>farol.icns</string>
<key>CFBundleExecutable</key><string>Farol Next Preview</string>
<key>CFBundleVersion</key><string>1</string>
</dict></plist>`;
// SYNTHETIC content fixtures only: these headers are NOT rendered icons and
// the fake app is NOT a canonical package. Full verification always invokes the
// unchanged native canonical verifier and reconstructs real assets itself.
async function fixture(run) {
  const directory = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "farol-preview-contract-"),
  );
  const base = path.join(directory, "Farol.app");
  const app = path.join(directory, "Farol Preview.app");
  const assets = {
    "farol-preview-mark.svg": await previewSvg(),
    "farol-preview-mark.png": Buffer.concat([
      Buffer.from("89504e470d0a1a0a", "hex"),
      Buffer.from("SYNTHETIC PNG"),
    ]),
    "farol-preview.icns": Buffer.from("icnsSYNTHETIC ICNS"),
  };
  try {
    for (const relative of [
      "Contents/Resources/app",
      "Contents/MacOS",
      "Contents/Frameworks/Vendor/Versions/A",
    ])
      await fs.mkdir(path.join(base, relative), {
        recursive: true,
        mode: 0o755,
      });
    for (const [relative, bytes, mode = 0o644] of [
      ["Contents/Info.plist", plist],
      [PREVIEW_LAUNCHER_PATH, "BASE LAUNCHER", 0o755],
      ["Contents/Resources/app/main.cjs", "BASE MAIN"],
      ["Contents/Resources/app/farol-backend", "BASE GO CORE", 0o755],
      ["Contents/Resources/app/build-identity.json", '{"buildId":"fixture"}'],
      ["Contents/Resources/farol.icns", "BASE ICON"],
      [
        "Contents/Frameworks/Vendor/Versions/A/runtime",
        "VENDOR RUNTIME",
        0o755,
      ],
    ])
      await fs.writeFile(path.join(base, relative), bytes, { mode });
    await fs.symlink(
      "A",
      path.join(base, "Contents/Frameworks/Vendor/Versions/Current"),
    );
    await derivePreviewTree(base, app, assets);
    await run({ directory, base, app, assets });
  } finally {
    await fs.rm(directory, { recursive: true });
  }
}

test("derivation preserves canonical files/modes/vendor links and verifies the exact allowlist", () =>
  fixture(async ({ base, app, assets }) => {
    const digest = await assertDerivativeTrees(base, app, assets);
    assert.match(digest, /^[a-f0-9]{64}$/u);
    assert.equal(
      await fs.readFile(
        path.join(app, "Contents/Resources/app/main.cjs"),
        "utf8",
      ),
      "BASE MAIN",
    );
    assert.equal(
      await fs.readlink(
        path.join(app, "Contents/Frameworks/Vendor/Versions/Current"),
      ),
      "A",
    );
    assert.equal(
      await fs.readFile(path.join(base, PREVIEW_LAUNCHER_PATH), "utf8"),
      "BASE LAUNCHER",
    );
    assert.equal(
      await fs.readFile(path.join(base, "Contents/Info.plist"), "utf8"),
      plist,
    );
    await assert.rejects(derivePreviewTree(base, app, assets), {
      code: "EEXIST",
    });
  }));

test("a private operator umask preserves every exact derivative mode", () =>
  fixture(async ({ directory, base, assets }) => {
    const app = path.join(directory, "Private Umask Preview.app");
    const verifier = new URL(
      "../../tooling/verify-owner-preview.mjs",
      import.meta.url,
    ).href;
    const assetModule = new URL(
      "../../tooling/owner-preview-assets.mjs",
      import.meta.url,
    ).href;
    const script = `
      import { derivePreviewTree } from ${JSON.stringify(verifier)};
      import { previewSvg } from ${JSON.stringify(assetModule)};
      process.umask(0o077);
      await derivePreviewTree(process.argv[1], process.argv[2], {
        "farol-preview-mark.svg": await previewSvg(),
        "farol-preview-mark.png": Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("SYNTHETIC PNG")]),
        "farol-preview.icns": Buffer.from("icnsSYNTHETIC ICNS"),
      });
    `;
    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", script, base, app],
      {
        encoding: "utf8",
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      },
    );
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr);
    for (const relative of Object.values(PREVIEW_ASSET_PATHS))
      assert.equal(
        (await fs.stat(path.join(app, relative))).mode & 0o777,
        0o644,
      );
    await assertDerivativeTrees(base, app, assets);
  }));

for (const [name, mutate] of [
  [
    "changed renderer",
    async (app) =>
      fs.appendFile(
        path.join(app, "Contents/Resources/app/main.cjs"),
        "injection",
      ),
  ],
  [
    "changed vendor",
    async (app) =>
      fs.appendFile(
        path.join(app, "Contents/Frameworks/Vendor/Versions/A/runtime"),
        "injection",
      ),
  ],
  [
    "changed original icon",
    async (app) =>
      fs.appendFile(
        path.join(app, "Contents/Resources/farol.icns"),
        "injection",
      ),
  ],
  [
    "missing Go core",
    async (app) =>
      fs.unlink(path.join(app, "Contents/Resources/app/farol-backend")),
  ],
  [
    "added file",
    async (app) =>
      fs.writeFile(path.join(app, "Contents/Resources/app/extra"), "extra"),
  ],
  ["added directory", async (app) => fs.mkdir(path.join(app, "extra"))],
  [
    "changed executable mode",
    async (app) =>
      fs.chmod(path.join(app, "Contents/Resources/app/farol-backend"), 0o644),
  ],
  [
    "changed directory mode",
    async (app) => fs.chmod(path.join(app, "Contents/Resources/app"), 0o700),
  ],
  ["changed root mode", async (app) => fs.chmod(app, 0o700)],
  [
    "changed extra asset",
    async (app) =>
      fs.appendFile(
        path.join(app, PREVIEW_ASSET_PATHS["farol-preview.icns"]),
        "extra",
      ),
  ],
  [
    "changed plist executable",
    async (app) => {
      const file = path.join(app, "Contents/Info.plist");
      await fs.writeFile(
        file,
        (await fs.readFile(file, "utf8")).replace(
          "<string>Farol Next Preview</string>",
          "<string>Injected</string>",
        ),
      );
    },
  ],
  [
    "escaping symlink",
    async (app) => fs.symlink("/tmp", path.join(app, "escape")),
  ],
  [
    "changed vendor link",
    async (app) => {
      const link = path.join(
        app,
        "Contents/Frameworks/Vendor/Versions/Current",
      );
      await fs.unlink(link);
      await fs.symlink("../Versions/A", link);
    },
  ],
])
  test(`derivative refuses ${name}`, () =>
    fixture(async ({ base, app, assets }) => {
      await mutate(app);
      await assert.rejects(
        assertDerivativeTrees(base, app, assets),
        /OWNER_PREVIEW_TREE_DIFFERENCE|ARTIFACT_SYMLINK/u,
      );
    }));

test("plist transform refuses missing/duplicate identity keys and preserves unrelated bytes", () => {
  assert.ok(
    previewPlist(plist).includes(
      "<key>CFBundleVersion</key><string>1</string>",
    ),
  );
  assert.throws(
    () => previewPlist(plist.replace("CFBundleName", "OtherKey")),
    /PLIST_FIELD_INVALID/u,
  );
  assert.throws(
    () =>
      previewPlist(plist + "<key>CFBundleName</key><string>Duplicate</string>"),
    /PLIST_FIELD_INVALID/u,
  );
});

test("metadata binds original source/build/base manifest and recipe to generation identity", () => {
  const base = {
    sourceCommit: "a".repeat(40),
    sourceTreeDigest: "b".repeat(64),
    artifactSha256: "c".repeat(64),
    buildId: "d".repeat(64),
  };
  const bytes = Buffer.from(JSON.stringify(base));
  const manifest = derivativeManifest(base, bytes, "e".repeat(64));
  const id = generationIdentity(manifest);
  assert.match(id, /^[a-f0-9]{64}$/u);
  for (const changed of [
    { ...manifest, sourceCommit: "f".repeat(40) },
    { ...manifest, baseBuildId: "f".repeat(64) },
    { ...manifest, appTreeDigest: "f".repeat(64) },
    derivativeManifest(
      base,
      Buffer.concat([bytes, Buffer.from("\n")]),
      "e".repeat(64),
    ),
  ])
    assert.notEqual(generationIdentity(changed), id);
});

test("asset admission binds the fixed source and closed resource names", async () => {
  const svg = await previewSvg();
  assert.match(svg.toString(), />PREVIEW</u);
  assert.throws(
    () => assertPreviewAssets({ "farol-preview-mark.svg": svg }),
    /ASSETS_INVALID/u,
  );
});

test("current pointer is pinned physically and cannot target a hidden base or external app", () =>
  fixture(async ({ directory }) => {
    const preview = path.join(directory, "_output/preview");
    const generation = "a".repeat(64);
    const app = path.join(
      preview,
      "generations",
      generation,
      "Farol Preview.app",
    );
    await fs.mkdir(app, { recursive: true, mode: 0o700 });
    const current = path.join(preview, "Farol Preview.app");
    await fs.symlink(previewLinkTarget(generation), current);
    assert.equal((await pinCurrentGeneration(directory)).appPath, app);
    await fs.unlink(current);
    await fs.symlink(`generations/${generation}/.canonical/Farol.app`, current);
    await assert.rejects(
      pinCurrentGeneration(directory),
      /CURRENT_LINK_INVALID/u,
    );
    await fs.unlink(current);
    await fs.mkdir(current);
    await assert.rejects(
      pinCurrentGeneration(directory),
      /CURRENT_LINK_INVALID/u,
    );
  }));

test("manifest reads reject symlinks and oversized or shared files", () =>
  fixture(async ({ directory }) => {
    const file = path.join(directory, "manifest");
    await fs.writeFile(file, "12345");
    await assert.rejects(regularBytes(file, 4), /FILE_INVALID/u);
    const link = path.join(directory, "link");
    await fs.symlink("manifest", link);
    await assert.rejects(regularBytes(link), { code: "ELOOP" });
    await fs.link(file, path.join(directory, "shared"));
    await assert.rejects(regularBytes(file), /FILE_INVALID/u);
  }));
