import { describe, expect, it, vi } from "vitest";

import { exactProject } from "../../src/modules/chat/app/service/persistent-codex-handoff";

// Protocol fixtures only: no filesystem, live endpoint, Codex process or turn.
const projectId = "selected-project";
const root = "/approved/project";
const project = { id: projectId, roots: [{ path: root }] };

describe("exact saved Codex project selection", () => {
  it("accepts an omitted optional terminal cursor from the serving schema", async () => {
    const request = vi.fn().mockResolvedValue({ data: [project] });
    await expect(exactProject({ request }, projectId, root)).resolves.toBe(
      true,
    );
    expect(request.mock.calls).toEqual([
      ["project/list", { cursor: null, limit: 100 }],
    ]);
  });

  it("accepts an omitted terminal cursor after consuming the earlier page", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: [], nextCursor: "next" })
      .mockResolvedValueOnce({ data: [project] });
    await expect(exactProject({ request }, projectId, root)).resolves.toBe(
      true,
    );
    expect(request.mock.calls).toEqual([
      ["project/list", { cursor: null, limit: 100 }],
      ["project/list", { cursor: "next", limit: 100 }],
    ]);
  });

  it.each(["", 0, {}, true])(
    "refuses an invalid present cursor %j without another request",
    async (nextCursor) => {
      const request = vi
        .fn()
        .mockResolvedValue({ data: [project], nextCursor });
      await expect(exactProject({ request }, projectId, root)).resolves.toBe(
        false,
      );
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it("still requires one exact saved ID for the root", async () => {
    const request = vi.fn().mockResolvedValue({
      data: [project, { ...project, id: "another-project" }],
    });
    await expect(exactProject({ request }, projectId, root)).resolves.toBe(
      false,
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not treat a missing data array as a complete catalogue", async () => {
    const request = vi.fn().mockResolvedValue({});
    await expect(exactProject({ request }, projectId, root)).resolves.toBe(
      false,
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
});
