import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  blockingObservations,
  EVIDENCE_LANES,
  missingCases,
} from "../../tooling/evidence-cases.mjs";

// The expected cases are declared apart from the runner, and this test keeps
// the two from drifting silently: a case added to the runner without a
// declaration, or a declared case no push site can produce, fails here.  The
// runtime comparison of executed against declared cases is what catches a run
// that skipped a case.

const nextRoot = path.resolve(import.meta.dirname, "../..");

function pushedCases(source) {
  const literals = new Set();
  const templates = [];
  for (const match of source.matchAll(/cases\.push\(([^;]*?)\);/gsu)) {
    for (const name of match[1].matchAll(
      /"([a-z0-9][a-z0-9-]*)"|`([^`]*)`/gu,
    )) {
      if (name[1]) literals.add(name[1]);
      else {
        const pattern = name[2]
          .split(/\$\{[^}]+\}/u)
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
          .join("[a-z0-9-]+");
        templates.push(new RegExp(`^${pattern}$`, "u"));
      }
    }
  }
  return { literals, templates };
}

function inlineCaseArrays(source) {
  return [...source.matchAll(/\bcases: \[([^\]]*)\]/gsu)].map((match) =>
    [...match[1].matchAll(/"([a-z0-9][a-z0-9-]*)"/gu)].map((name) => name[1]),
  );
}

describe("evidence case contract", () => {
  it("declares exactly the cases the E2E runner can record", async () => {
    const source = await fs.readFile(
      path.join(nextRoot, "tests/e2e/preview.e2e.mjs"),
      "utf8",
    );
    const { literals, templates } = pushedCases(source);
    const declared = new Set([
      ...EVIDENCE_LANES["development-build"].cases,
      ...EVIDENCE_LANES["sealed-package"].cases,
    ]);
    expect([...literals].filter((name) => !declared.has(name))).toEqual([]);
    expect(
      [...declared].filter(
        (name) =>
          !literals.has(name) &&
          !templates.some((template) => template.test(name)),
      ),
    ).toEqual([]);

    expect(inlineCaseArrays(source)).toEqual([
      [...EVIDENCE_LANES["persistence-fault"].cases],
      [...EVIDENCE_LANES["lifecycle-soak"].cases],
      [...EVIDENCE_LANES["two-generation-state"].cases],
    ]);
  });

  it("declares exactly the suites Hunt certifies", async () => {
    const source = await fs.readFile(
      path.join(nextRoot, "tooling/hunt-report.mjs"),
      "utf8",
    );
    expect(
      [...source.matchAll(/file: "(tests\/hunt\/[^"]+)"/gu)].map(
        (match) => match[1],
      ),
    ).toEqual([...EVIDENCE_LANES.hunt.cases]);
  });

  it("keeps an observation blocking unless it says it is informational", () => {
    // The kind that existed before severity did: an application already
    // gone at close. It carries no severity, and must still block.
    expect(
      blockingObservations([
        { kind: "closed-before-inspection", stage: "application-close" },
      ]),
    ).toEqual([
      { kind: "closed-before-inspection", stage: "application-close" },
    ]);
    // An unknown future kind that forgot to declare one blocks too, rather
    // than slipping past the classification.
    expect(blockingObservations([{ kind: "something-new" }])).toHaveLength(1);
  });

  it("leaves an informational observation out of what decides the run", () => {
    expect(
      blockingObservations([
        {
          kind: "task-menu-closed-without-own-action",
          severity: "informational",
        },
      ]),
    ).toEqual([]);
    // It is excluded from the decision, not from the record: the runner
    // still reports it, which is asserted where the report is built.
    expect(
      blockingObservations([
        {
          kind: "task-menu-closed-without-own-action",
          severity: "informational",
        },
        { kind: "closed-before-inspection" },
      ]),
    ).toEqual([{ kind: "closed-before-inspection" }]);
  });

  it("treats an explicitly blocked case as accounted for, never as missing", () => {
    const [first, second, ...rest] = EVIDENCE_LANES["development-build"].cases;
    expect(
      missingCases("development-build", rest, [
        { name: first, reason: "no secondary display" },
      ]),
    ).toEqual([second]);
  });
});
