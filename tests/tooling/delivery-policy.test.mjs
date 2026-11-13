import fs from "node:fs";
import { describe, it, expect } from "vitest";
import {
  assertDeliveryPolicy,
  assertUnstablePolicy,
  readWorkflow,
} from "../../tooling/delivery-policy.mjs";

const policy = JSON.parse(
  fs.readFileSync(".github/delivery-policy.json", "utf8"),
);
const pr = readWorkflow(".github/workflows/pr.yml");
const release = readWorkflow(".github/workflows/release.yml");
const setup = readWorkflow(".github/actions/setup-ci/action.yml");
const unstable = readWorkflow(".github/workflows/unstable.yml");

describe("repository delivery policy", () => {
  it("prepares the tunnel input through the actual CLI in clean CI", () => {
    const steps = setup.runs.steps.filter(
      (step) => step.name === "Prepare the pinned Tunnel Client build input",
    );
    expect(steps).toHaveLength(1);
    expect(steps[0].run).toBe(
      "node tooling/prepare-tunnel-client.mjs --download",
    );
  });

  it("parses the complete workflows and matches the checked-in delivery contract", () => {
    expect(fs.readdirSync(".github/workflows").sort()).toEqual([
      "pr.yml",
      "release.yml",
      "unstable.yml",
    ]);
    assertDeliveryPolicy(policy, pr, release, setup);
    assertUnstablePolicy(unstable);
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
      "missing private draft ID pin",
      (_p, r) => {
        delete r.on.workflow_dispatch.inputs.draft_release_id;
      },
    ],
    [
      "public Actions binary upload",
      (_p, r) => {
        r.jobs.build.steps.push({
          uses: "actions/upload-artifact@" + "a".repeat(40),
          with: { path: "_output/release" },
        });
      },
    ],
    [
      "binary cache transfer",
      (_p, r) => {
        r.jobs.build.steps.push({
          uses: "actions/cache@" + "a".repeat(40),
          with: { path: "_output" },
        });
      },
    ],
    [
      "binary log transfer",
      (_p, r) => {
        r.jobs.build.steps.push({ run: "base64 _output/release/app.zip" });
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

it.each([true, false])(
  "refuses a fixed prerelease=%s policy that discards version channels",
  (prerelease) => {
    expect(() =>
      assertDeliveryPolicy({ ...policy, prerelease }, pr, release, setup),
    ).toThrow();
  },
);

describe("dry unstable build workflow", () => {
  it.each([
    [
      "push trigger",
      (u) => {
        u.on.push = { branches: ["main"] };
      },
    ],
    [
      "write-capable token",
      (u) => {
        u.permissions.contents = "write";
      },
    ],
    [
      "write-capable build job",
      (u) => {
        u.jobs.build.permissions = { contents: "write" };
      },
    ],
    [
      "release creation",
      (u) => {
        u.jobs.build.steps.push({ run: "gh release create v1 --draft" });
      },
    ],
    [
      "tag push",
      (u) => {
        u.jobs.build.steps.push({ run: "git tag v1 && git push origin v1" });
      },
    ],
    [
      "secret use",
      (u) => {
        u.jobs.build.steps.at(-1).env = { KEY: "${{ secrets.KEY }}" };
      },
    ],
    [
      "public Actions binary upload",
      (u) => {
        u.jobs.build.steps.push({
          uses: "actions/upload-artifact@" + "a".repeat(40),
          with: { path: "_output/release/unstable/SHA256SUMS" },
        });
      },
    ],
    [
      "artifact output",
      (u) => {
        u.jobs.build.outputs.artifact_id =
          "${{ steps.upload.outputs.artifact-id }}";
      },
    ],
    [
      "binary cache transfer",
      (u) => {
        u.jobs.build.steps.push({
          uses: "actions/cache@" + "a".repeat(40),
          with: { path: "_output" },
        });
      },
    ],
    [
      "unconditional build",
      (u) => {
        delete u.jobs.build.if;
      },
    ],
    [
      "cancelled build",
      (u) => {
        u.concurrency["cancel-in-progress"] = true;
      },
    ],
    [
      "floating source ref",
      (u) => {
        u.jobs.build.steps[0].with.ref = "main";
      },
    ],
    [
      "skipped source gate",
      (u) => {
        const step = u.jobs.build.steps.find(
          (item) =>
            item.name ===
            "Run the full unchanged source gate including secret scans",
        );
        step.run = step.run.replace("task ci\n", "");
      },
    ],
    [
      "unversioned action",
      (u) => {
        u.jobs.decide.steps[0].uses = "actions/checkout@v4";
      },
    ],
  ])("rejects drift: %s", (_name, mutate) => {
    const u = structuredClone(unstable);
    mutate(u);
    expect(() => assertUnstablePolicy(u)).toThrow();
  });
});
