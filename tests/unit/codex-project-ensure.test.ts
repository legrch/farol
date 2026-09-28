import { describe, expect, it } from "vitest";
import { ensureCodexProject } from "../../src/modules/chat/app/service/ensure-codex-project";
import type {
  ProjectEnsureContext,
  ProjectEnsureIntent,
  ProjectEnsureRequest,
} from "../../src/modules/chat/app/port/codex-project-ensure";
import type { HandoffWorkspace } from "../../src/modules/chat/app/service/persistent-codex-handoff";

const key = "019b0000-0000-4000-8000-000000000030";
const nextKey = "019b0000-0000-4000-8000-000000000031";
const workspace: HandoffWorkspace = {
  root: "/writers/feature",
  device: "1",
  inode: "2",
  gitCommonDirectory: "/canonical/.git",
  project: {
    root: "/canonical",
    device: "1",
    inode: "3",
    gitCommonDirectory: "/canonical/.git",
  },
  execution: { sandbox: "workspace-write", approvalPolicy: "on-request" },
};
const request: ProjectEnsureRequest = {
  key,
  workspaceId: "selected",
  name: "Project",
  mode: "ensure",
};
const project = (id = "saved", root = "/canonical") => ({
  id,
  name: "Project",
  roots: [{ path: root }],
});
function fixture() {
  let time = 10;
  let allowed = true;
  let physical: HandoffWorkspace | null = structuredClone(workspace);
  let record: unknown = null;
  let projects: unknown[] = [];
  const calls: string[] = [];
  const creates: unknown[] = [];
  const state = {
    list: async () => ({ data: projects, nextCursor: null }) as unknown,
    create: async (input: unknown) => {
      creates.push(input);
      projects = [project()];
      return { project: project() } as unknown;
    },
    claim: async (intent: ProjectEnsureIntent) => {
      if (record !== null) return false;
      record = structuredClone(intent);
      return true;
    },
    confirm: async (_root: unknown, selectedKey: string, projectId: string) => {
      expect((record as ProjectEnsureIntent).key).toBe(selectedKey);
      record = {
        ...(record as ProjectEnsureIntent),
        acknowledgedProjectId: projectId,
      };
    },
  };
  const context: ProjectEnsureContext = {
    authority: {
      resolve: async (workspaceId) =>
        workspaceId === "selected" ? physical : null,
    },
    journal: {
      read: async () => record,
      claim: async (intent) => {
        calls.push("claim");
        return state.claim(intent);
      },
      confirm: async (...args) => {
        calls.push("confirm");
        await state.confirm(...args);
      },
    },
    host: {
      catalogue: {
        request: async (_method, _params, deadline) => {
          expect(deadline).toBe(100);
          calls.push("list");
          return state.list();
        },
      },
      create: async (input, deadline) => {
        expect(deadline).toBe(100);
        calls.push("create");
        return state.create(input);
      },
    },
    gate: {
      run: async (preflight, effect) => {
        calls.push("gate");
        await preflight();
        return effect();
      },
    },
    expiresAt: 100,
    now: () => time,
    admitted: () => allowed,
    projectCreateAdmitted: true,
  };
  return {
    context,
    calls,
    creates,
    state,
    setTime: (value: number) => {
      time = value;
    },
    revoke: () => {
      allowed = false;
    },
    setPhysical: (value: HandoffWorkspace | null) => {
      physical = value;
    },
    setRecord: (value: unknown) => {
      record = value;
    },
    record: () => record,
    setProjects: (value: unknown[]) => {
      projects = value;
    },
  };
}

describe("fresh saved-project ensure contract (in-memory ports only)", () => {
  it("creates only the canonical project after durable intent and complete re-list", async () => {
    const f = fixture();
    expect(await ensureCodexProject(f.context, request)).toEqual({
      status: "created",
      projectId: "saved",
      proof: "create-ack-and-current-catalogue",
      controlGranted: false,
    });
    expect(f.calls).toEqual([
      "list",
      "gate",
      "claim",
      "create",
      "list",
      "confirm",
    ]);
    expect(f.creates).toEqual([
      { idempotencyKey: key, name: "Project", roots: [{ path: "/canonical" }] },
    ]);
    expect(f.record()).toMatchObject({
      project: workspace.project,
      acknowledgedProjectId: "saved",
    });
  });
  it("resolves an existing unique project without a grant, claim or create", async () => {
    const f = fixture();
    f.setProjects([project()]);
    expect(
      await ensureCodexProject(
        { ...f.context, projectCreateAdmitted: false },
        request,
      ),
    ).toMatchObject({
      status: "resolved",
      projectId: "saved",
      controlGranted: false,
    });
    expect(f.calls).toEqual(["list"]);
  });
  it("inspect never creates a missing project", async () => {
    const f = fixture();
    expect(
      await ensureCodexProject(f.context, { ...request, mode: "inspect" }),
    ).toMatchObject({ status: "missing" });
    expect(f.creates).toEqual([]);
  });
  it("never replaces a stale explicit preference with a fresh project", async () => {
    const f = fixture();
    expect(
      await ensureCodexProject(f.context, {
        ...request,
        preferredProjectId: "removed",
      }),
    ).toMatchObject({ status: "stale_preference" });
    expect(f.creates).toEqual([]);
  });
  it("does not choose among duplicate canonical projects without an explicit preference", async () => {
    const f = fixture();
    f.setProjects([project("a"), project("b")]);
    expect(await ensureCodexProject(f.context, request)).toMatchObject({
      status: "ambiguous",
    });
    expect(f.creates).toEqual([]);
    expect(
      await ensureCodexProject(f.context, {
        ...request,
        preferredProjectId: "b",
      }),
    ).toMatchObject({ status: "resolved", projectId: "b" });
  });
  it("does not send create without the separate owner project-mutation admission", async () => {
    const f = fixture();
    expect(
      await ensureCodexProject(
        { ...f.context, projectCreateAdmitted: false },
        request,
      ),
    ).toMatchObject({
      status: "refused",
      code: "PROJECT_CREATE_NOT_QUALIFIED",
    });
    expect(f.creates).toEqual([]);
  });
  it("does not replay create after a lost acknowledgement, even under another key", async () => {
    const f = fixture();
    f.state.create = async (input) => {
      f.creates.push(input);
      f.setProjects([project()]);
      throw Error("lost ack");
    };
    expect(await ensureCodexProject(f.context, request)).toMatchObject({
      status: "outcome_unknown",
    });
    expect(await ensureCodexProject(f.context, request)).toMatchObject({
      status: "outcome_unknown",
    });
    expect(
      await ensureCodexProject(f.context, { ...request, key: nextKey }),
    ).toMatchObject({ status: "outcome_unknown" });
    expect(
      await ensureCodexProject(f.context, { ...request, mode: "inspect" }),
    ).toMatchObject({
      status: "outcome_unknown",
      observedProjectId: "saved",
      controlGranted: false,
    });
    expect(f.creates).toHaveLength(1);
  });
  it("replays confirmed local intent through current catalogue without another effect", async () => {
    const f = fixture();
    await ensureCodexProject(f.context, request);
    expect(await ensureCodexProject(f.context, request)).toMatchObject({
      status: "resolved",
      proof: "current-catalogue",
    });
    expect(f.creates).toHaveLength(1);
  });
  it("keeps confirmation failure unknown and cannot dispatch a new key", async () => {
    const f = fixture();
    f.state.confirm = async () => {
      throw Error("fsync uncertain");
    };
    expect(await ensureCodexProject(f.context, request)).toMatchObject({
      status: "outcome_unknown",
    });
    expect(
      await ensureCodexProject(f.context, { ...request, key: nextKey }),
    ).toMatchObject({ status: "outcome_unknown" });
    expect(f.creates).toHaveLength(1);
  });
  it("one canonical journal claim serializes different-key contenders", async () => {
    const f = fixture();
    const result = await Promise.all([
      ensureCodexProject(f.context, request),
      ensureCodexProject(f.context, { ...request, key: nextKey }),
    ]);
    expect(result.filter((r) => r.status === "created")).toHaveLength(1);
    expect(f.creates).toHaveLength(1);
  });
  it("uses the same canonical identity from a different independently admitted writer", async () => {
    const f = fixture();
    await ensureCodexProject(f.context, request);
    f.setPhysical({ ...workspace, root: "/writers/other", inode: "4" });
    expect(await ensureCodexProject(f.context, request)).toMatchObject({
      status: "resolved",
      projectId: "saved",
    });
    expect(f.creates).toHaveLength(1);
  });
  it.each([
    null,
    undefined,
    {},
    { project: project("foreign", "/writers/feature") },
    { project: { ...project(), name: "foreign" } },
    { project: { ...project(), id: "bad id" } },
    {
      project: {
        ...project(),
        roots: [...project().roots, { path: "/extra" }],
      },
    },
  ])(
    "refuses malformed/foreign create acknowledgement %# without success or retry",
    async (ack) => {
      const f = fixture();
      f.state.create = async (input) => {
        f.creates.push(input);
        return ack;
      };
      expect(await ensureCodexProject(f.context, request)).toMatchObject({
        status: "outcome_unknown",
      });
      expect(f.calls).not.toContain("confirm");
      expect(f.creates).toHaveLength(1);
    },
  );
  it.each([
    undefined,
    {},
    { ...request, project: workspace.project, acknowledgedProjectId: null },
    {
      key,
      name: "Project",
      project: { ...workspace.project, inode: "wrong" },
      acknowledgedProjectId: null,
    },
  ])("keeps unsafe existing journal data unknown %#", async (record) => {
    const f = fixture();
    f.setRecord(record);
    expect(await ensureCodexProject(f.context, request)).toMatchObject({
      status: "outcome_unknown",
    });
    expect(f.creates).toEqual([]);
  });
  it.each([
    { key: "bad" },
    { workspaceId: "bad id" },
    { name: "" },
    { name: " x " },
    { name: "😀".repeat(51) },
    { mode: "unsupported" },
    { preferredProjectId: "bad id" },
  ])("rejects invalid input %# before provider access", async (delta) => {
    const f = fixture();
    expect(
      await ensureCodexProject(f.context, {
        ...request,
        ...delta,
      } as ProjectEnsureRequest),
    ).toMatchObject({ status: "refused" });
    expect(f.calls).toEqual([]);
  });
  it("refuses expiry/revocation before reads", async () => {
    const f = fixture();
    f.setTime(100);
    expect(await ensureCodexProject(f.context, request)).toMatchObject({
      status: "refused",
    });
    expect(f.calls).toEqual([]);
    f.setTime(10);
    f.revoke();
    expect(await ensureCodexProject(f.context, request)).toMatchObject({
      status: "refused",
    });
    expect(f.calls).toEqual([]);
  });
  it("does not disclose or create after physical drift during catalogue", async () => {
    const f = fixture();
    f.state.list = async () => {
      f.setPhysical({ ...workspace, inode: "changed" });
      return { data: [project()], nextCursor: null };
    };
    expect(await ensureCodexProject(f.context, request)).toMatchObject({
      status: "refused",
    });
    expect(f.creates).toEqual([]);
  });
  it("leaves claimed intent unknown and does not create if authority expires during claim", async () => {
    const f = fixture();
    const claim = f.state.claim;
    f.state.claim = async (intent) => {
      const result = await claim(intent);
      f.setTime(100);
      return result;
    };
    expect(await ensureCodexProject(f.context, request)).toMatchObject({
      status: "outcome_unknown",
    });
    expect(f.calls).not.toContain("create");
  });
  it.each([
    "claim-expiry",
    "invalid-ack",
    "ambiguous-readback",
    "confirm-revocation",
  ])("quarantines uncertain mutation at the gate: %s", async (fault) => {
    const f = fixture();
    let quarantined = false;
    if (fault === "claim-expiry") {
      const claim = f.state.claim;
      f.state.claim = async (intent) => {
        const result = await claim(intent);
        f.setTime(100);
        return result;
      };
    } else if (fault === "invalid-ack") {
      f.state.create = async () => ({
        project: project("foreign", "/outside"),
      });
    } else if (fault === "ambiguous-readback") {
      f.state.create = async () => {
        f.setProjects([project(), project("other")]);
        return { project: project() };
      };
    } else {
      const confirm = f.state.confirm;
      f.state.confirm = async (...args) => {
        await confirm(...args);
        f.revoke();
      };
    }
    const gate: ProjectEnsureContext["gate"] = {
      run: async (preflight, effect, safeToReleaseError) => {
        await preflight();
        try {
          return await effect();
        } catch (error) {
          quarantined = !safeToReleaseError(error);
          throw error;
        }
      },
    };
    expect(
      await ensureCodexProject({ ...f.context, gate }, request),
    ).toMatchObject({ status: "outcome_unknown" });
    expect(quarantined).toBe(true);
  });
  it("leaves the effect unknown if authority is revoked after confirmation", async () => {
    const f = fixture();
    const confirm = f.state.confirm;
    f.state.confirm = async (...args) => {
      await confirm(...args);
      f.revoke();
    };
    expect(await ensureCodexProject(f.context, request)).toMatchObject({
      status: "outcome_unknown",
    });
  });
  it("does not treat a partial/malformed catalogue as absence", async () => {
    const f = fixture();
    f.state.list = async () => ({ data: [project()], nextCursor: "repeated" });
    expect(await ensureCodexProject(f.context, request)).toMatchObject({
      status: "unavailable",
    });
    expect(f.creates).toEqual([]);
  });
  it("never creates after corrupt/failed journal reads", async () => {
    const f = fixture();
    const journal = {
      ...f.context.journal,
      read: async (): Promise<never> => {
        throw Error("unsafe state");
      },
    };
    expect(
      await ensureCodexProject({ ...f.context, journal }, request),
    ).toMatchObject({ status: "outcome_unknown" });
    expect(f.creates).toEqual([]);
  });
  it("refuses a missing authority and late drift after the journal await", async () => {
    const f = fixture();
    f.setPhysical(null);
    expect(await ensureCodexProject(f.context, request)).toMatchObject({
      status: "refused",
    });
    f.setPhysical(workspace);
    const journal = {
      ...f.context.journal,
      read: async () => {
        f.setPhysical({
          ...workspace,
          project: { ...workspace.project, inode: "changed" },
        });
        return null;
      },
    };
    expect(
      await ensureCodexProject({ ...f.context, journal }, request),
    ).toMatchObject({ status: "refused" });
    expect(f.calls).toEqual([]);
  });
  it("does not substitute a disappeared or replaced confirmed saved project", async () => {
    const f = fixture();
    await ensureCodexProject(f.context, request);
    f.setProjects([]);
    expect(await ensureCodexProject(f.context, request)).toMatchObject({
      status: "outcome_unknown",
    });
    f.setProjects([project("replacement")]);
    expect(await ensureCodexProject(f.context, request)).toMatchObject({
      status: "outcome_unknown",
    });
    expect(f.creates).toHaveLength(1);
  });
  it("cannot disclose created state after revocation during the create acknowledgement", async () => {
    const f = fixture();
    const create = f.state.create;
    f.state.create = async (input) => {
      const result = await create(input);
      f.revoke();
      return result;
    };
    expect(await ensureCodexProject(f.context, request)).toMatchObject({
      status: "outcome_unknown",
    });
    expect(f.calls).not.toContain("confirm");
  });
  it("cannot disclose created state after physical drift in post-create catalogue", async () => {
    const f = fixture();
    let pages = 0;
    f.state.list = async () => {
      if (++pages === 1) return { data: [], nextCursor: null };
      f.setPhysical({ ...workspace, inode: "changed" });
      return { data: [project()], nextCursor: null };
    };
    expect(await ensureCodexProject(f.context, request)).toMatchObject({
      status: "outcome_unknown",
    });
    expect(f.calls).not.toContain("confirm");
  });
  it("does not create when the mutation-gate preflight rechecks a changed physical root", async () => {
    const f = fixture();
    const gate: ProjectEnsureContext["gate"] = {
      run: async (preflight, effect) => {
        f.setPhysical({ ...workspace, inode: "changed" });
        await preflight();
        return effect();
      },
    };
    expect(
      await ensureCodexProject({ ...f.context, gate }, request),
    ).toMatchObject({ status: "outcome_unknown" });
    expect(f.creates).toEqual([]);
  });
  it("binds a copy of the validated request across asynchronous boundaries", async () => {
    const f = fixture();
    const mutable = { ...request };
    const authority = {
      resolve: async () => {
        mutable.key = nextKey;
        mutable.name = "Unexpected";
        return workspace;
      },
    };
    expect(
      await ensureCodexProject({ ...f.context, authority }, mutable),
    ).toMatchObject({ status: "created" });
    expect(f.creates).toEqual([
      { idempotencyKey: key, name: "Project", roots: [{ path: "/canonical" }] },
    ]);
  });
  it("complete catalogue proves only the canonical path, never the writer's saved project", async () => {
    const f = fixture();
    f.setProjects([project("writer-only", "/writers/feature")]);
    expect(
      await ensureCodexProject(
        { ...f.context, projectCreateAdmitted: false },
        request,
      ),
    ).toMatchObject({
      status: "refused",
      code: "PROJECT_CREATE_NOT_QUALIFIED",
    });
    expect(f.creates).toEqual([]);
  });
  it("does not confirm when post-create catalogue omits the acknowledged project", async () => {
    const f = fixture();
    f.state.create = async (input) => {
      f.creates.push(input);
      return { project: project() };
    };
    expect(await ensureCodexProject(f.context, request)).toMatchObject({
      status: "outcome_unknown",
    });
    expect(f.calls).not.toContain("confirm");
  });
  it.each(["revoked", "expired", "physical-drift"])(
    "does not disclose success after an asynchronous gate return: %s",
    async (fault) => {
      const f = fixture();
      const gate: ProjectEnsureContext["gate"] = {
        run: async (preflight, effect) => {
          await preflight();
          const result = await effect();
          if (fault === "revoked") f.revoke();
          else if (fault === "expired") f.setTime(100);
          else f.setPhysical({ ...workspace, inode: "replaced-after-gate" });
          return result;
        },
      };
      expect(
        await ensureCodexProject({ ...f.context, gate }, request),
      ).toMatchObject({ status: "outcome_unknown" });
      expect(f.creates).toHaveLength(1);
    },
  );
  it("cannot confirm when concurrent native creation makes re-list ambiguous", async () => {
    const f = fixture();
    f.state.create = async (input) => {
      f.creates.push(input);
      f.setProjects([project(), project("native-other")]);
      return { project: project() };
    };
    expect(await ensureCodexProject(f.context, request)).toMatchObject({
      status: "outcome_unknown",
    });
    expect(f.calls).not.toContain("confirm");
  });
});
