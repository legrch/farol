import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  ShellActionSchema,
  ShellActionSourceSchema,
} from "../../src/pkg/ipc/shell-state";

// S35-TA-16 (U1 seam). A shell action used to arrive as `{ action }` alone,
// so a recipient could not tell an owner's own command from a publish the
// product made on its own behalf — which is the distinction the task-menu
// investigation needed and could not get. Provenance now travels on the
// envelope: what published it, which publish this is, and which auth window
// (if any) produced it. Nothing about what `publishShellAction` DOES
// changed: same actions, same recipient, same ordering.

const mainSource = path.resolve(
  import.meta.dirname,
  "../../src/apps/desktop/main.ts",
);

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    action: "open-settings",
    eventId: "0199c0de-0000-4000-8000-0000000000aa",
    source: "settings-command",
    authWindowGeneration: null,
    ...overrides,
  };
}

describe("shell action provenance", () => {
  it("S35-TA-16 accepts a fully stamped envelope", () => {
    expect(ShellActionSchema.parse(envelope())).toEqual(envelope());
  });

  // Each field is required: a publisher that forgets one is refused rather
  // than delivering an action nobody can attribute.
  const missing: ReadonlyArray<Readonly<{ field: string }>> = [
    { field: "eventId" },
    { field: "source" },
    { field: "authWindowGeneration" },
  ];

  for (const row of missing) {
    it(`S35-TA-16 refuses an envelope with no ${row.field}`, () => {
      const value = envelope();
      delete (value as Record<string, unknown>)[row.field];
      expect(ShellActionSchema.safeParse(value).success).toBe(false);
    });
  }

  const rejected: ReadonlyArray<
    Readonly<{ name: string; overrides: Record<string, unknown> }>
  > = [
    { name: "an unknown source", overrides: { source: "app-menu" } },
    { name: "a source that is not a string", overrides: { source: 1 } },
    { name: "an eventId that is not a uuid", overrides: { eventId: "abc" } },
    {
      name: "a negative auth window generation",
      overrides: { authWindowGeneration: -1 },
    },
    {
      name: "a fractional auth window generation",
      overrides: { authWindowGeneration: 1.5 },
    },
    {
      name: "an extra field the contract does not carry",
      overrides: { origin: "keyboard" },
    },
  ];

  for (const row of rejected) {
    it(`S35-TA-16 refuses ${row.name}`, () => {
      expect(ShellActionSchema.safeParse(envelope(row.overrides)).success).toBe(
        false,
      );
    });
  }

  it("S35-TA-16 the source enum names publishers, and says which are owner actions", () => {
    expect(ShellActionSourceSchema.options).toEqual([
      "settings-command",
      "quick-switcher-command",
      "overlay-dismissed",
      "sign-in-return-command",
      "verification-completed",
      "auth-window-closed",
    ]);
    // "app-menu" is deliberately NOT a source: requestSettings and
    // requestQuickSwitcher are each reached from both a menu item and a
    // keyboard shortcut, so the device would describe two paths to one
    // owner intent. The publisher is the stable fact.
    expect(ShellActionSourceSchema.safeParse("app-menu").success).toBe(false);
  });

  // main.ts exports nothing and no test loads it, so which source each
  // publisher stamps is checked at the source, the technique
  // watch-rail-product-contract.test.mjs and ipc-registration-contract
  // already use for this file.
  it("S35-TA-16 every publisher stamps its true source", async () => {
    const source = await readFile(mainSource, "utf8");
    const calls = [...source.matchAll(/publishShellAction\(\s*([^;]*?)\)/gsu)]
      .map((match) => match[1] ?? "")
      .filter((body) => !body.includes("action:"));
    expect(calls).toHaveLength(5);
    expect(
      calls.filter((body) => body.includes('"quick-switcher-command"')),
    ).toHaveLength(1);
    expect(
      calls.filter((body) => body.includes('"settings-command"')),
    ).toHaveLength(1);
    expect(
      calls.filter((body) => body.includes('"overlay-dismissed"')),
    ).toHaveLength(1);
    expect(
      calls.filter((body) => body.includes('"auth-window-closed"')),
    ).toHaveLength(1);
    expect(
      calls.filter((body) => body.includes('"sign-in-return-command"')),
    ).toHaveLength(1);
    expect(
      calls.filter((body) => body.includes('"verification-completed"')),
    ).toHaveLength(1);
    // Every publish is stamped: no call site may omit provenance.
    for (const body of calls) {
      expect(body).toMatch(
        /"(settings-command|quick-switcher-command|overlay-dismissed|sign-in-return-command|verification-completed|auth-window-closed)"/u,
      );
    }
  });

  it("S35-TA-16 a fresh eventId is minted per publish, not reused", async () => {
    const source = await readFile(mainSource, "utf8");
    expect(source).toContain("eventId: randomUUID()");
    // One mint inside the publisher means every send differs; a constant or
    // a hoisted id would make two publishes indistinguishable.
    expect(source.match(/eventId: randomUUID\(\)/gu)).toHaveLength(1);
  });

  it("S35-TA-16 the auth-window path carries the generation of the window that closed", async () => {
    const source = await readFile(mainSource, "utf8");
    // Stamped when the window opens...
    expect(source).toContain("chatGptSignInGeneration += 1");
    expect(source).toContain(
      "chatGptSignInOpenGeneration = chatGptSignInGeneration",
    );
    // ...and read back, then cleared, when ITS close is recorded, so a
    // delayed close from an older window reports the older number rather
    // than whatever is current.
    expect(source).toContain("const closing = chatGptSignInOpenGeneration");
    expect(source).toContain("chatGptSignInOpenGeneration = null");
    expect(source).toContain(
      "void recordChatGptSignInOutcome(closing, status)",
    );
    // The other three publishers carry no generation.
    expect(source).toContain(
      'publishShellAction("close-overlay", "overlay-dismissed")',
    );
  });
});
