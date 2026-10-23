import fs from "node:fs";
import { describe, it, expect } from "vitest";
import {
  assertDeliveryPolicy,
  readWorkflow,
} from "../../tooling/delivery-policy.mjs";

const policy = JSON.parse(
  fs.readFileSync(".github/delivery-policy.json", "utf8"),
);
const pr = readWorkflow(".github/workflows/pr.yml");
const release = readWorkflow(".github/workflows/release.yml");
const setup = readWorkflow(".github/actions/setup-ci/action.yml");

describe("repository delivery policy", () => {
  it("parses the complete workflows and matches the checked-in delivery contract", () => {
    expect(fs.readdirSync(".github/workflows").sort()).toEqual([
      "pr.yml",
      "release.yml",
    ]);
    assertDeliveryPolicy(policy, pr, release, setup);
    const taskfile = fs.readFileSync("Taskfile.yml", "utf8");
    expect(taskfile).toMatch(/ci:[\s\S]*?- task: scan:secrets/u);
    expect(taskfile).toMatch(/ci:cloud:[\s\S]*?- task: scan:secrets/u);
  });

  it.each([
    [
      "main deployment",
      (p, r) => {
        r.on.push.branches = ["main"];
      },
    ],
    [
      "docs trigger bypass",
      (p) => {
        p.on.pull_request["paths-ignore"] = ["docs/**"];
      },
    ],
    [
      "unversioned action",
      (p) => {
        p.jobs.checks.steps[0].uses = "actions/checkout@v4";
      },
    ],
    [
      "write-capable PR",
      (p) => {
        p.permissions.contents = "write";
      },
    ],
    [
      "missing native check",
      (p) => {
        delete p.jobs.native;
      },
    ],
    [
      "missing final dependency",
      (p) => {
        p.jobs.required.needs.pop();
      },
    ],
    [
      "unconditional skip",
      (p) => {
        p.jobs.native.if = "false";
      },
    ],
    [
      "latest release",
      (p, r) => {
        r.jobs.publish.steps.at(-1).run = "gh release create v1 --latest";
      },
    ],
    [
      "automatic tag publication",
      (p, r) => {
        delete r.jobs.publish.if;
        r.jobs.publish.needs = "build";
      },
    ],
    [
      "missing exact-asset qualification input",
      (_p, r) => {
        delete r.on.workflow_dispatch.inputs.manifest_sha256;
      },
    ],
    [
      "artifact-name fallback instead of immutable artifact ID",
      (_p, r) => {
        const step = r.jobs.publish.steps.find((s) =>
          s.uses?.startsWith("actions/download-artifact@"),
        );
        delete step.with["artifact-ids"];
        step.with.name = "public-release-assets";
      },
    ],
    [
      "write-capable preparation",
      (_p, r) => {
        r.jobs.build.permissions = { contents: "write" };
      },
    ],
    [
      "publisher rebuild",
      (_p, r) => {
        r.jobs.publish.steps.at(-1).run += "\ntask package";
      },
    ],
  ])("rejects policy drift: %s", (_name, mutate) => {
    const p = structuredClone(pr),
      r = structuredClone(release);
    mutate(p, r);
    expect(() => assertDeliveryPolicy(policy, p, r, setup)).toThrow();
  });
});
