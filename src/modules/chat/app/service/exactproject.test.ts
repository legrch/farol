import { describe, expect, it } from "vitest";
import type { HandoffHost } from "../port/handoff";
import { exactProject } from "./exactproject";

type Page = Readonly<{ data: unknown; nextCursor?: unknown }>;

function host(pages: readonly unknown[]): HandoffHost & {
  calls: unknown[];
} {
  const calls: unknown[] = [];
  let index = 0;
  return {
    calls,
    async request(method, params) {
      calls.push({ method, params });
      return pages[index++];
    },
  };
}

const project = (id: unknown, ...roots: string[]) => ({
  id,
  roots: roots.map((path) => ({ path })),
});

describe("exactProject", () => {
  it("accepts exactly one project owning the root", async () => {
    const h = host([
      { data: [project("p1", "/a"), project("p2", "/b")], nextCursor: null },
    ] satisfies Page[]);
    await expect(exactProject(h, "p2", "/b")).resolves.toBe(true);
    expect(h.calls).toEqual([
      { method: "project/list", params: { cursor: null, limit: 100 } },
    ]);
  });

  it("refuses a different or ambiguous owner", async () => {
    await expect(
      exactProject(host([{ data: [project("p1", "/a")] }]), "p2", "/a"),
    ).resolves.toBe(false);
    await expect(
      exactProject(
        host([{ data: [project("p1", "/a"), project("p2", "/a")] }]),
        "p1",
        "/a",
      ),
    ).resolves.toBe(false);
    await expect(
      exactProject(host([{ data: [project("p1", "/a")] }]), "p1", "/none"),
    ).resolves.toBe(false);
  });

  it("follows cursors across pages and counts matches over all of them", async () => {
    const h = host([
      { data: [project("p1", "/a")], nextCursor: "c1" },
      { data: [project("p2", "/a")], nextCursor: null },
    ]);
    await expect(exactProject(h, "p1", "/a")).resolves.toBe(false);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]).toEqual({
      method: "project/list",
      params: { cursor: "c1", limit: 100 },
    });
  });

  it("refuses malformed responses and rows", async () => {
    await expect(exactProject(host([null]), "p", "/a")).resolves.toBe(false);
    await expect(exactProject(host([{ data: "x" }]), "p", "/a")).resolves.toBe(
      false,
    );
    await expect(
      exactProject(host([{ data: [project("bad id", "/a")] }]), "p", "/a"),
    ).resolves.toBe(false);
    await expect(
      exactProject(host([{ data: [{ id: "p", roots: "x" }] }]), "p", "/a"),
    ).resolves.toBe(false);
  });

  it("refuses an empty, repeated or non-string cursor", async () => {
    await expect(
      exactProject(host([{ data: [], nextCursor: "" }]), "p", "/a"),
    ).resolves.toBe(false);
    await expect(
      exactProject(host([{ data: [], nextCursor: 7 }]), "p", "/a"),
    ).resolves.toBe(false);
    await expect(
      exactProject(
        host([
          { data: [], nextCursor: "c" },
          { data: [], nextCursor: "c" },
        ]),
        "p",
        "/a",
      ),
    ).resolves.toBe(false);
  });

  it("gives up after 32 pages", async () => {
    const pages = Array.from({ length: 40 }, (_, index) => ({
      data: [],
      nextCursor: `c${index}`,
    }));
    const h = host(pages);
    await expect(exactProject(h, "p", "/a")).resolves.toBe(false);
    expect(h.calls).toHaveLength(32);
  });
});
