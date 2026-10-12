import { describe, expect, it } from "vitest";
import fixture from "../fixtures/shell-launch.json";
import gitResourceFixture from "../fixtures/shell-launch-git-resources.json";
import { encodeShellLaunch } from "../../apps/desktop/bridge/shell-launch.ts";

const host = () => ({
  ...structuredClone(fixture.host),
  watchdogSource: Buffer.from(fixture.host.watchdogSource),
});
// Shared synthetic cross-language values. No issuer, filesystem or child.
describe("private Shell launch projection", () => {
  it("matches the exact payload independently decoded by Go", () => {
    const input = host();
    const encoded = encodeShellLaunch(
      fixture.declaration,
      structuredClone(fixture.declaration),
      fixture.declaration.core,
      input,
    );
    input.watchdogSource.fill(0);
    input.appRoot.path = "/changed";
    expect(JSON.parse(Buffer.from(encoded).toString("utf8"))).toEqual(
      fixture.payload,
    );
  });
  it("requires a separately matching core and support expectation", () => {
    const changed = structuredClone(fixture.declaration);
    changed.qualification.osBuild = "25A124";
    expect(() =>
      encodeShellLaunch(fixture.declaration, changed, changed.core, host()),
    ).toThrow("shell_support_binding_mismatch");
    changed.core.binary.sha256 = "9".repeat(64);
    expect(() =>
      encodeShellLaunch(
        fixture.declaration,
        fixture.declaration,
        changed.core,
        host(),
      ),
    ).toThrow("shell_support_binding_mismatch");
  });
  it("rejects changed source and malformed host bindings", () => {
    const inputs = [
      { ...host(), profileId: "other\n" },
      { ...host(), hostLifetimeId: "" },
      { ...host(), childLaunchId: "child/alias" },
      { ...host(), watchdogSource: Buffer.from("changed source") },
      { ...host(), watchdogSource: Buffer.from([255]) },
      { ...host(), watchdogSource: Buffer.alloc(65537) },
      ...[
        "/",
        "/Applications/../Farol.app",
        "/Applications/Farol.app/",
        "relative",
        "/bad\npath",
      ].map((value) => ({
        ...host(),
        appRoot: { ...host().appRoot, path: value },
      })),
      ...["0", "01", "-1", "18446744073709551616"].map((value) => ({
        ...host(),
        appRoot: { ...host().appRoot, inode: value },
      })),
    ];
    for (const input of inputs)
      expect(() =>
        encodeShellLaunch(
          fixture.declaration,
          fixture.declaration,
          fixture.declaration.core,
          input,
        ),
      ).toThrow("invalid_shell_launch_metadata");
  });
});

it("projects the same finite Git data group decoded by Go", () => {
  const input = structuredClone(gitResourceFixture.declaration);
  const actual = encodeShellLaunch(input, structuredClone(input), input.core, {
    ...structuredClone(gitResourceFixture.host),
    watchdogSource: Buffer.from(gitResourceFixture.host.watchdogSource),
  });
  expect(JSON.parse(Buffer.from(actual).toString("utf8"))).toEqual(
    gitResourceFixture.payload,
  );
});
