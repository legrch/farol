import fs from "node:fs";
import path from "node:path";

const roots = [path.resolve("src"), path.resolve("apps/desktop")];
const rules = [
  ["LINT_EXPLICIT_ANY", /(?::|<|,)\s*any(?:\s*[>,;)=]|$)/u],
  ["LINT_ANY_ASSERTION", /\bas\s+any\b/u],
  ["LINT_TS_IGNORE", /@ts-ignore/u],
  ["LINT_UNFINISHED_MARKER", /\b(?:TODO|FIXME)\b/u],
];

function files(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const target = path.join(directory, entry.name);
      return entry.isDirectory()
        ? files(target)
        : /\.(?:ts|tsx)$/u.test(entry.name)
          ? [target]
          : [];
    })
    .sort();
}

const violations = [];
const productionFiles = roots.flatMap(files).sort();
for (const file of productionFiles) {
  const source = fs.readFileSync(file, "utf8");
  for (const [code, pattern] of rules) {
    if (pattern.test(source)) {
      violations.push(`${code} ${path.relative(process.cwd(), file)}`);
    }
  }
}

if (violations.length > 0) {
  process.stdout.write(`${violations.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Farol lint: ${productionFiles.length} production files checked.\n`,
  );
}
