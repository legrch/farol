// The ADR-0002 enforcement switch shared by the Go and TypeScript architecture
// checkers. Migration rules report everywhere and block only in migrated
// scopes; report findings in unmigrated scopes must match exact baseline rows,
// so a new finding fails even when another one was fixed in the same change.
import fs from "node:fs";
import path from "node:path";

export const findingKey = (finding) =>
  JSON.stringify([finding.code, finding.file, finding.detail]);

export const compareFinding = (a, b) =>
  findingKey(a) < findingKey(b) ? -1 : findingKey(a) > findingKey(b) ? 1 : 0;

const safePath = (file) =>
  typeof file === "string" &&
  file !== "" &&
  !path.posix.isAbsolute(file) &&
  !/[\\*?]/u.test(file) &&
  !file.split("/").some((part) => ["", ".", ".."].includes(part));

const baselineRow = (item) => ({
  code: item.code,
  file: item.file,
  detail: item.detail,
  ...(item.amount === undefined ? {} : { amount: item.amount }),
});

// `file` is the enforcement file relative to the root, `codes` the migration
// rules, `scopes` the admitted scope names, `scopeOf` maps a finding's file to
// its scope, `prefix` names the blocking enforcement codes (GO, TS), `label`
// the language in error messages and `command` the checker invocation quoted
// in stale-row messages.
export function enforcementSwitch({
  file: enforcementFile,
  version,
  codes,
  scopes,
  scopeOf,
  prefix,
  label,
  command,
}) {
  function read(root) {
    const file = path.join(root, enforcementFile);
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const invalid = (reason) => {
      throw new Error(`Invalid ${label} architecture enforcement: ${reason}`);
    };
    if (
      !data ||
      typeof data !== "object" ||
      Array.isArray(data) ||
      Object.keys(data).sort().join(",") !==
        "baseline,exceptions,migrated,source,version" ||
      data.version !== version ||
      !/^[a-f0-9]{40}$/u.test(data.source)
    )
      invalid("envelope");
    const migrated = new Map();
    for (const code of codes) {
      const list = data.migrated?.[code];
      if (
        !Array.isArray(list) ||
        list.some((scope) => !scopes.includes(scope)) ||
        list.join() !== [...new Set(list)].sort().join()
      )
        invalid(`migrated ${code}`);
      migrated.set(code, new Set(list));
    }
    if (Object.keys(data.migrated).length !== codes.length)
      invalid("unknown migrated rule");
    const row = (item, keys) =>
      item &&
      typeof item === "object" &&
      codes.includes(item.code) &&
      safePath(item.file) &&
      typeof item.detail === "string" &&
      item.detail !== "" &&
      keys.includes(Object.keys(item).sort().join(","));
    const baseline = new Map();
    if (!Array.isArray(data.baseline)) invalid("baseline");
    for (const item of data.baseline) {
      if (
        !row(item, ["code,detail,file", "amount,code,detail,file"]) ||
        (item.amount !== undefined &&
          (!Number.isSafeInteger(item.amount) || item.amount < 1)) ||
        baseline.has(findingKey(item))
      )
        invalid("baseline row");
      baseline.set(findingKey(item), item);
    }
    const exceptions = new Map();
    if (!Array.isArray(data.exceptions)) invalid("exceptions");
    for (const item of data.exceptions) {
      if (
        !row(item, ["code,detail,file,reason,removal"]) ||
        typeof item.reason !== "string" ||
        !item.reason.trim() ||
        typeof item.removal !== "string" ||
        !item.removal.trim() ||
        exceptions.has(findingKey(item))
      )
        invalid("exception row");
      exceptions.set(findingKey(item), item);
    }
    return { data, source: data.source, migrated, baseline, exceptions };
  }

  // Split migration findings by the enforcement switch. Row-exact for every
  // migration rule: in a migrated scope a finding blocks unless an exact,
  // reasoned exception row covers it; in a report scope a finding must match
  // an exact baseline row (code, file, detail). Rows with an amount
  // (occurrences or excess) may fall but never rise. Baseline rows without
  // their finding are stale. Without the file every finding is a report.
  // `write` rewrites the baseline: stale rows are dropped and amounts lowered;
  // `admit` also adds the current new findings (reviewed additions only).
  function enforce(root, findings, add, write = null) {
    const enforcement = read(root);
    const unique = [
      ...new Map(findings.map((item) => [findingKey(item), item])).values(),
    ]
      .sort(compareFinding)
      .map((item) => ({ ...item, scope: scopeOf(item.file) }));
    const reported = [];
    const excepted = [];
    const counts = {};
    const used = new Set();
    const matched = new Map();
    const fresh = [];
    for (const item of unique) {
      const migrated = enforcement?.migrated.get(item.code)?.has(item.scope);
      const exception =
        migrated && enforcement.exceptions.get(findingKey(item));
      if (exception) {
        used.add(findingKey(item));
        excepted.push({
          ...item,
          reason: exception.reason,
          removal: exception.removal,
        });
        continue;
      }
      counts[item.code] ??= {};
      counts[item.code][item.scope] =
        (counts[item.code][item.scope] ?? 0) + (item.amount ?? 1);
      if (migrated) {
        if (!write) add(item.code, item.file, item.detail);
        continue;
      }
      reported.push(item);
      if (!enforcement) continue;
      const row = enforcement.baseline.get(findingKey(item));
      if (!row) {
        fresh.push(item);
        continue;
      }
      matched.set(findingKey(item), item);
      if ((item.amount ?? 1) > (row.amount ?? 1)) fresh.push(item);
    }
    if (enforcement && write) {
      const rows = [];
      for (const [key, row] of enforcement.baseline) {
        const item = matched.get(key);
        if (!item) continue;
        const amount =
          row.amount === undefined
            ? undefined
            : Math.min(row.amount, item.amount ?? 1);
        rows.push(baselineRow({ ...row, amount }));
      }
      if (write.admit)
        for (const item of fresh) {
          const index = rows.findIndex(
            (row) => findingKey(row) === findingKey(item),
          );
          if (index !== -1) rows.splice(index, 1);
          rows.push(baselineRow(item));
        }
      rows.sort(compareFinding);
      const data = { ...enforcement.data, baseline: rows };
      fs.writeFileSync(
        path.join(root, enforcementFile),
        `${JSON.stringify(data, null, 2)}\n`,
      );
      return enforce(root, findings, add);
    }
    if (enforcement) {
      for (const [key, item] of enforcement.exceptions)
        if (!used.has(key))
          add(
            `${prefix}_EXCEPTION_STALE`,
            enforcementFile,
            `${item.code} ${item.file}: ${item.detail}`,
          );
      for (const item of fresh) {
        const row = enforcement.baseline.get(findingKey(item));
        add(
          `${prefix}_REPORT_NEW`,
          item.file,
          row
            ? `${item.code} ${item.detail}: amount ${item.amount} exceeds the baseline ${row.amount}; remove the new occurrences`
            : `${item.code} ${item.detail}: not in the baseline; fix it (adding a row needs reviewed --write-baseline --admit-new)`,
        );
      }
      for (const [key, row] of enforcement.baseline) {
        const item = matched.get(key);
        if (!item)
          add(
            `${prefix}_BASELINE_STALE`,
            row.file,
            `${row.code} ${row.detail}: no matching report finding; delete the row (${command} --write-baseline)`,
          );
        else if (row.amount !== undefined && (item.amount ?? 1) < row.amount)
          add(
            `${prefix}_BASELINE_STALE`,
            row.file,
            `${row.code} ${row.detail}: amount ${item.amount} is below the baseline ${row.amount}; set it to ${item.amount} (${command} --write-baseline)`,
          );
      }
    }
    return {
      mode: "report",
      source: enforcement?.source ?? null,
      migrated: Object.fromEntries(
        codes.map((code) => [
          code,
          [...(enforcement?.migrated.get(code) ?? [])],
        ]),
      ),
      findings: reported,
      excepted,
      counts,
    };
  }

  // Counts per rule and scope; * marks a migrated (blocking) scope.
  function table(report) {
    const columns = [
      ...new Set([
        ...scopes,
        ...Object.values(report.counts).flatMap((byScope) =>
          Object.keys(byScope),
        ),
      ]),
    ].sort();
    const width = Math.max(...codes.map((code) => code.length));
    const lines = [
      `${"rule".padEnd(width)} ${columns.map((scope) => scope.padStart(10)).join("")}     total`,
    ];
    for (const code of codes) {
      const cells = columns.map((scope) => {
        const count = report.counts[code]?.[scope] ?? 0;
        const mark = report.migrated[code].includes(scope) ? "*" : " ";
        return `${count}${mark}`.padStart(10);
      });
      const total = Object.values(report.counts[code] ?? {}).reduce(
        (sum, count) => sum + count,
        0,
      );
      lines.push(
        `${code.padEnd(width)} ${cells.join("")}${String(total).padStart(10)}`,
      );
    }
    return `${lines.join("\n")}\n`;
  }

  // The writer must leave the file exactly as the repository's Prettier
  // formats it (short arrays collapse); format through Prettier's own API.
  async function format(root) {
    const file = path.join(root, enforcementFile);
    let prettier;
    try {
      prettier = await import("prettier");
    } catch {
      throw new Error(
        "--write-baseline needs the repository's Prettier (run npm ci)",
      );
    }
    const options = (await prettier.resolveConfig(file)) ?? {};
    fs.writeFileSync(
      file,
      await prettier.format(fs.readFileSync(file, "utf8"), {
        ...options,
        filepath: file,
      }),
    );
  }

  return { read, enforce, table, format };
}
