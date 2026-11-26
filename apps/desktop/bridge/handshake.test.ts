import { describe, expect, it } from "vitest";
import { qualifyHandshake } from "./handshake.ts";
import type { Handshake, Identity, Outcome } from "./wire.ts";

const expected: Handshake = {
  protocolMajor: 2,
  protocolMinor: 3,
  buildId: "build",
  profileId: "profile",
};
const identity: Identity = {
  protocolMajor: 2,
  protocolMinor: 3,
  buildId: "build",
  profileId: "profile",
  backendGeneration: "backend",
  capabilities: ["core.status"],
  maxFrameBytes: 1048576,
};

function reply(
  data: unknown,
  fields: Partial<Outcome> = {},
  context = { profileId: "profile", backendGeneration: "backend" },
): Outcome {
  return {
    status: "ok",
    requestId: "request",
    context,
    data,
    ...fields,
  } as unknown as Outcome;
}

describe("qualifyHandshake", () => {
  it("accepts the identity that matches the request and context", () => {
    expect(qualifyHandshake(reply(identity), expected)).toEqual({ identity });
  });

  it("accepts a newer backend minor version", () => {
    const newer = { ...identity, protocolMinor: 4 };
    expect(qualifyHandshake(reply(newer), expected)).toEqual({
      identity: newer,
    });
  });

  it("refuses a reply that is not an ok identity", () => {
    const invalid = { code: "invalid_backend_identity" };
    expect(
      qualifyHandshake(reply(identity, { status: "refused" }), expected),
    ).toEqual(invalid);
    expect(qualifyHandshake(reply({ nope: true }), expected)).toEqual(invalid);
    expect(qualifyHandshake(reply(undefined), expected)).toEqual(invalid);
  });

  it("refuses any identity that is not the one requested", () => {
    const wrong = { code: "wrong_backend_identity" };
    for (const crossed of [
      { ...identity, protocolMajor: 3 },
      { ...identity, protocolMinor: 2 },
      { ...identity, buildId: "other" },
      { ...identity, profileId: "other" },
    ])
      expect(
        qualifyHandshake(
          reply(
            crossed,
            {},
            {
              profileId: crossed.profileId,
              backendGeneration: "backend",
            },
          ),
          expected,
        ),
      ).toEqual(wrong);
  });

  it("refuses a reply whose context is not the identity's", () => {
    const wrong = { code: "wrong_backend_identity" };
    expect(
      qualifyHandshake(
        reply(identity, {}, { profileId: "profile", backendGeneration: "x" }),
        expected,
      ),
    ).toEqual(wrong);
    expect(
      qualifyHandshake(
        reply(identity, {}, { profileId: "x", backendGeneration: "backend" }),
        expected,
      ),
    ).toEqual(wrong);
  });
});
