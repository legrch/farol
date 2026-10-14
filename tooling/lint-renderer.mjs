import fs from "node:fs/promises";
import path from "node:path";
import { transform } from "esbuild";
import { ESLint } from "eslint";
import hooks from "eslint-plugin-react-hooks";
// TypeScript 7 is newer than the TS parser's supported peer range. Strip types
// with the existing compiler, preserving JSX and hook structure for ESLint.
const eslint = new ESLint({
  overrideConfigFile: true,
  overrideConfig: [
    {
      files: ["**/*.{jsx,js}"],
      languageOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        parserOptions: { ecmaFeatures: { jsx: true } },
      },
      plugins: { "react-hooks": hooks },
      rules: {
        "react-hooks/rules-of-hooks": "error",
        "react-hooks/exhaustive-deps": "error",
      },
    },
  ],
});
async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async (entry) =>
        entry.isDirectory()
          ? walk(path.join(dir, entry.name))
          : /\.(?:ts|tsx)$/u.test(entry.name)
            ? [path.join(dir, entry.name)]
            : [],
      ),
    )
  ).flat();
}
let errors = 0;
for (const file of [
  ...(await walk("src/ui/renderer")),
  ...(await walk("apps/desktop/renderer")),
]) {
  const { code } = await transform(await fs.readFile(file, "utf8"), {
    loader: file.endsWith(".tsx") ? "tsx" : "ts",
    jsx: "preserve",
    target: "es2022",
  });
  const results = await eslint.lintText(code, { filePath: `${file}.jsx` });
  for (const result of results)
    for (const message of result.messages) {
      errors++;
      process.stderr.write(`${file}: ${message.ruleId}: ${message.message}\n`);
    }
}
if (errors) process.exitCode = 1;
else process.stdout.write("Renderer hook rules checked.\n");
