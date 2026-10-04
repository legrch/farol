import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
const root = process.cwd();
function sandbox(files, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "farol-renderer-gate-"));
  try {
    for (const [name, source] of Object.entries(files)) {
      const file = path.join(dir, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, source);
    }
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
it("R01 actual strict config includes TSX and rejects an ill-typed JSX value", () => {
  const config = JSON.parse(fs.readFileSync("tsconfig.json", "utf8"));
  expect(config.compilerOptions.jsx).toBe("react-jsx");
  expect(config.include).toContain("src/**/*.tsx");
  for (const [source, expected] of [
    ["const item: number = <span />; export {item};", 1],
    ["const item = <span />; export {item};", 0],
  ]) {
    sandbox(
      { "tsconfig.json": JSON.stringify(config), "src/ui/probe.tsx": source },
      (dir) => {
        fs.symlinkSync(
          path.join(root, "node_modules"),
          path.join(dir, "node_modules"),
        );
        const result = spawnSync(
          process.execPath,
          [
            path.join(root, "node_modules/typescript/bin/tsc"),
            "--noEmit",
            "-p",
            dir,
          ],
          { encoding: "utf8" },
        );
        expect(result.status, result.stdout + result.stderr).toBe(expected);
      },
    );
  }
});
for (const [name, files, code] of [
  [
    "host React",
    { "src/apps/desktop/main.ts": 'import {useState} from "react";' },
    "ARCH_REACT_OUTSIDE_RENDERER",
  ],
  [
    "direct Node",
    { "src/ui/shell.tsx": 'import fs from "node:fs";' },
    "ARCH_RENDERER_HOST_IMPORT",
  ],
  [
    "indirect Node",
    {
      "src/ui/shell.tsx": 'import "../pkg/io/file";',
      "src/pkg/io/file.ts": 'import fs from "node:fs";',
    },
    "ARCH_RENDERER_HOST_IMPORT",
  ],
  [
    "backend internals",
    {
      "src/ui/shell.tsx": 'import "../modules/chat/app/service";',
      "src/modules/chat/app/service.ts": "export const value=1;",
    },
    "ARCH_UI_TO_MODULE_INFRA",
  ],
  [
    "dynamic host",
    { "src/ui/shell.tsx": 'const target="electron"; import(target);' },
    "ARCH_DYNAMIC_IMPORT",
  ],
])
  it(`R03 rejects ${name}`, () =>
    sandbox(files, (dir) => {
      const result = spawnSync(
        process.execPath,
        ["tooling/check-architecture.mjs", "--root", dir, "--json"],
        { encoding: "utf8" },
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toContain(code);
    }));
it("R03 accepts renderer JSX and pure contract imports", () =>
  sandbox(
    {
      "src/ui/shell.tsx":
        'import {useState} from "react"; import "../modules/chat/contract/view"; export const View=()=> <span/>;',
      "src/modules/chat/contract/view.ts": "export type View={id:string};",
    },
    (dir) => {
      const result = spawnSync(
        process.execPath,
        ["tooling/check-architecture.mjs", "--root", dir, "--json"],
        { encoding: "utf8" },
      );
      expect(result.status, result.stdout + result.stderr).toBe(0);
    },
  ));
