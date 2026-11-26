// A whole-file line diff for the preview, with unchanged runs folded away.

const MAX_DIFF_CELLS = 4_000_000;
const DIFF_CONTEXT = 3;

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

type DiffOp = Readonly<{ kind: " " | "-" | "+"; line: string }>;

function diffOps(
  before: readonly string[],
  after: readonly string[],
): DiffOp[] {
  if (before.length * after.length > MAX_DIFF_CELLS) {
    return [
      ...before.map((line) => ({ kind: "-" as const, line })),
      ...after.map((line) => ({ kind: "+" as const, line })),
    ];
  }
  const width = after.length + 1;
  const table = new Uint32Array((before.length + 1) * width);
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        before[i] === after[j]
          ? (table[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(
              table[(i + 1) * width + j] ?? 0,
              table[i * width + j + 1] ?? 0,
            );
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      ops.push({ kind: " ", line: before[i] ?? "" });
      i += 1;
      j += 1;
    } else if (
      (table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)
    ) {
      ops.push({ kind: "-", line: before[i] ?? "" });
      i += 1;
    } else {
      ops.push({ kind: "+", line: after[j] ?? "" });
      j += 1;
    }
  }
  for (; i < before.length; i += 1)
    ops.push({ kind: "-", line: before[i] ?? "" });
  for (; j < after.length; j += 1)
    ops.push({ kind: "+", line: after[j] ?? "" });
  return ops;
}

/** A whole-file line diff, with unchanged runs folded down to a little context. */
export function lineDiff(before: string, after: string): string {
  if (before === after) return "";
  const ops = diffOps(splitLines(before), splitLines(after));
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, index) => {
    if (op.kind === " ") return;
    for (
      let near = Math.max(0, index - DIFF_CONTEXT);
      near <= Math.min(ops.length - 1, index + DIFF_CONTEXT);
      near += 1
    ) {
      keep[near] = true;
    }
  });
  const rendered: string[] = [];
  let elided = 0;
  ops.forEach((op, index) => {
    if (!keep[index]) {
      elided += 1;
      return;
    }
    if (elided > 0) {
      rendered.push(`… ${elided} unchanged line${elided === 1 ? "" : "s"}`);
      elided = 0;
    }
    rendered.push(`${op.kind}${op.line}`);
  });
  if (elided > 0) {
    rendered.push(`… ${elided} unchanged line${elided === 1 ? "" : "s"}`);
  }
  return rendered.join("\n");
}
