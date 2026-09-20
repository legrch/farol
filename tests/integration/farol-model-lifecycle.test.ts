import http from "node:http";
import net from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyFarolModelConfigBlock,
  previewFarolModelConfigBlock,
  type FarolModelProviderSpec,
} from "../../src/apps/desktop/farol-model-config-block";
import {
  FarolModelLifecycle,
  type FarolModelLifecycleOptions,
  type FarolModelRotatePorts,
} from "../../src/apps/desktop/farol-model-lifecycle";

const roots: string[] = [];
const lifecycles: FarolModelLifecycle[] = [];

// The one model the endpoint serves (main.ts passes ROUTE_B_MODEL).
const MODEL = "farol-next/mind";

afterEach(async () => {
  await Promise.all(lifecycles.splice(0).map((lifecycle) => lifecycle.stop()));
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function disposableStateRoot(): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-model-lifecycle-"),
  );
  roots.push(root);
  return path.join(root, "model-endpoint");
}

function newLifecycle(
  stateRoot: string,
  handler?: FarolModelLifecycleOptions["handler"],
  extra: Partial<
    Omit<FarolModelLifecycleOptions, "stateRoot" | "handler">
  > = {},
): FarolModelLifecycle {
  const lifecycle = new FarolModelLifecycle({
    stateRoot,
    model: MODEL,
    ...(handler ? { handler } : {}),
    ...extra,
  });
  lifecycles.push(lifecycle);
  return lifecycle;
}

/** Exactly the request shape an ordinary Codex host sends to `/responses`. */
function codexRequest(model: string = MODEL) {
  return {
    model,
    stream: true,
    store: false,
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "say hi" }],
      },
    ],
    tools: [],
    client_metadata: {
      session_id: "0199c0de-0000-7000-8000-00000000d001",
      thread_id: "0199c0de-0000-7000-8000-00000000d001",
      turn_id: "turn-lifecycle-1",
      root_turn_id: "turn-lifecycle-1",
    },
  };
}

async function postTurn(
  port: number,
  token: string | undefined,
  body: unknown = codexRequest(),
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

/**
 * A silent occupant: accepts connections and never answers. Its accepted
 * sockets are tracked so the test can close it promptly afterwards — an
 * aborted probe leaves its socket open on the occupant's side, and
 * `server.close()` waits for every connection otherwise.
 */
async function occupyPort(
  port: number,
): Promise<net.Server & { closeNow: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    const sockets = new Set<net.Socket>();
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () =>
      resolve(
        Object.assign(server, {
          closeNow: () => {
            for (const socket of sockets) socket.destroy();
            return closeServer(server);
          },
        }),
      ),
    );
  });
}

/** Something that is not Farol: an HTTP server that answers every request 200. */
async function occupyPortWithForeignHttp(port: number): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("hello from something else");
    });
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

const emptyTurn: NonNullable<
  FarolModelLifecycleOptions["handler"]
> = async () => ({
  ok: true,
  events: [],
});

describe("Farol Model endpoint lifecycle", () => {
  it("reports not_running before start(), with nothing listening", async () => {
    const stateRoot = await disposableStateRoot();
    const lifecycle = newLifecycle(stateRoot);
    expect(lifecycle.status()).toEqual({ state: "not_running" });
    expect(await lifecycle.checkStatus()).toEqual({ state: "not_running" });
    expect(lifecycle.endpoint).toBeUndefined();
  });

  it("starts and stops with the caller's own lifecycle, never autospawning in between", async () => {
    const stateRoot = await disposableStateRoot();
    const lifecycle = newLifecycle(stateRoot);

    await lifecycle.start();
    const listening = lifecycle.status();
    expect(listening.state).toBe("listening");
    if (
      listening.state !== "not_running" &&
      listening.state !== "port_conflict"
    ) {
      expect(listening.port).toBeGreaterThan(0);
    }
    expect(await lifecycle.checkStatus()).toEqual(listening);

    await lifecycle.stop();
    expect(lifecycle.status()).toEqual({ state: "not_running" });

    // Stopped means stopped: nothing is listening on the persisted port.
    const port = await lifecycle.runtimeState.persistedPort();
    expect(port).toBeDefined();
    await expect(
      new Promise((resolve, reject) => {
        const socket = net.connect({ host: "127.0.0.1", port: port! });
        socket.once("connect", () => {
          socket.destroy();
          reject(new Error("expected the port to be closed"));
        });
        socket.once("error", () => resolve(undefined));
      }),
    ).resolves.toBeUndefined();
  });

  it("hands the endpoint the one model it serves", async () => {
    const stateRoot = await disposableStateRoot();
    const lifecycle = newLifecycle(stateRoot, emptyTurn);
    await lifecycle.start();
    expect(lifecycle.endpoint?.servedModel).toBe(MODEL);

    const token = await lifecycle.runtimeState.currentToken();
    const port = lifecycleExpectedPort(lifecycle);
    const mismatch = await postTurn(port, token, codexRequest("farol-model"));
    expect(mismatch.status).toBe(422);
    await mismatch.text();
    expect(lifecycle.status().state).toBe("listening");
  });

  it("reports a port conflict as a readable status instead of silently rebinding, and identifies the other Farol on check", async () => {
    const stateRoot = await disposableStateRoot();
    const first = newLifecycle(stateRoot);
    await first.start();
    const port = lifecycleExpectedPort(first);

    const second = newLifecycle(stateRoot);
    await second.start();
    expect(second.status()).toEqual({
      state: "port_conflict",
      port,
      occupant: "unprobed",
    });
    expect(second.endpoint).toBeUndefined();

    // The identity probe with this state root's token is answered by the
    // first instance: the port is held by another Farol, not by a stranger.
    expect(await second.checkStatus()).toEqual({
      state: "port_conflict",
      port,
      occupant: "farol",
    });

    // The first instance is unaffected and still on its own port; the
    // probe was not counted as a served turn.
    expect(lifecycleExpectedPort(first)).toBe(port);
    expect(first.status().state).toBe("listening");
  });

  it("tells a port held by something that is not this Farol from one that has since been vacated", async () => {
    const stateRoot = await disposableStateRoot();
    const warm = newLifecycle(stateRoot);
    await warm.start();
    const port = lifecycleExpectedPort(warm);
    await warm.stop();

    const occupier = await occupyPortWithForeignHttp(port);
    try {
      const lifecycle = newLifecycle(stateRoot, undefined, {
        probeTimeoutMs: 500,
      });
      await lifecycle.start();
      expect(lifecycle.status()).toEqual({
        state: "port_conflict",
        port,
        occupant: "unprobed",
      });
      expect(await lifecycle.checkStatus()).toEqual({
        state: "port_conflict",
        port,
        occupant: "foreign",
      });

      await closeServer(occupier);
      expect(await lifecycle.checkStatus()).toEqual({
        state: "port_conflict",
        port,
        occupant: "vacated",
      });
      // Read-only: the check never rebinds on its own.
      expect(lifecycle.endpoint).toBeUndefined();
    } finally {
      await closeServer(occupier).catch(() => undefined);
    }
  });

  it("reports a silent occupant that accepts the connection but never answers as not this Farol", async () => {
    const stateRoot = await disposableStateRoot();
    const warm = newLifecycle(stateRoot);
    await warm.start();
    const port = lifecycleExpectedPort(warm);
    await warm.stop();

    const occupier = await occupyPort(port);
    try {
      const lifecycle = newLifecycle(stateRoot, undefined, {
        probeTimeoutMs: 300,
      });
      await lifecycle.start();
      expect(await lifecycle.checkStatus()).toEqual({
        state: "port_conflict",
        port,
        occupant: "foreign",
      });
    } finally {
      await occupier.closeNow();
    }
  });

  it("turns connected only once the endpoint has actually served a request", async () => {
    const stateRoot = await disposableStateRoot();
    const lifecycle = newLifecycle(stateRoot, emptyTurn);
    await lifecycle.start();
    expect(lifecycle.status().state).toBe("listening");

    const token = await lifecycle.runtimeState.currentToken();
    const port = lifecycleExpectedPort(lifecycle);
    const response = await postTurn(port, token);
    expect(response.status).toBe(200);
    await response.text();

    expect(lifecycle.status().state).toBe("connected");
  });

  it("rotates the token on demand: the old token stops authenticating at once, the new one works (P2-1)", async () => {
    const stateRoot = await disposableStateRoot();
    const lifecycle = newLifecycle(stateRoot, emptyTurn);
    await lifecycle.start();
    const port = lifecycleExpectedPort(lifecycle);
    const before = await lifecycle.runtimeState.currentToken();
    expect(before).toBeDefined();

    const rotated = await lifecycle.rotateToken();
    expect(rotated).not.toBe(before);
    expect(await lifecycle.runtimeState.currentToken()).toBe(rotated);

    const stale = await postTurn(port, before);
    expect(stale.status).toBe(401);
    await stale.text();
    const fresh = await postTurn(port, rotated);
    expect(fresh.status).toBe(200);
    await fresh.text();
    // No restart happened: same endpoint, same port.
    expect(lifecycleExpectedPort(lifecycle)).toBe(port);
  });

  // S35-H2-1. The owner-facing rotation is one operation: the endpoint's
  // token and the literal in the owner's Codex config move together, or
  // neither moves. These run against the real endpoint — the old and new
  // tokens are tried against it — and against a real config.toml.
  describe("rotateAndRewrite (S35-H2-1)", () => {
    async function configRoot(): Promise<string> {
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), "farol-model-rotate-"),
      );
      roots.push(root);
      return path.join(root, "config.toml");
    }

    function portsFor(
      lifecycle: FarolModelLifecycle,
      configPath: string,
    ): Readonly<{
      configPath: string;
      spec: () => Promise<FarolModelProviderSpec | null>;
      preview: typeof previewFarolModelConfigBlock;
      apply: typeof applyFarolModelConfigBlock;
    }> {
      return {
        configPath,
        // The same shape `main.ts`'s `farolModelProviderSpec` builds.
        spec: async () => {
          const status = lifecycle.status();
          if (status.state !== "listening" && status.state !== "connected") {
            return null;
          }
          const token = await lifecycle.runtimeState.currentToken();
          if (!token) return null;
          return {
            providerName: "farol",
            displayName: "Farol Model",
            baseUrl: `http://127.0.0.1:${status.port}`,
            model: MODEL,
            wireApi: "responses",
            delivery: { mode: "bearer-token", token },
          };
        },
        preview: previewFarolModelConfigBlock,
        apply: applyFarolModelConfigBlock,
      };
    }

    it("rewrites the installed block with the new literal: the new token authenticates and the old one is refused", async () => {
      const lifecycle = newLifecycle(await disposableStateRoot(), emptyTurn);
      await lifecycle.start();
      const port = lifecycleExpectedPort(lifecycle);
      const configPath = await configRoot();
      const ports = portsFor(lifecycle, configPath);

      const installed = await ports.spec();
      expect(installed).not.toBeNull();
      await applyFarolModelConfigBlock(configPath, installed!);
      const before = await lifecycle.runtimeState.currentToken();
      expect(before).toBeDefined();
      expect(await fs.readFile(configPath, "utf8")).toContain(before!);

      const rotated = await lifecycle.rotateAndRewrite(ports);
      expect(rotated).toEqual({
        ok: true,
        providerBlockUpdated: true,
        providerBlockStatus: "update",
      });

      const after = await lifecycle.runtimeState.currentToken();
      expect(after).toBeDefined();
      expect(after).not.toBe(before);
      // The owner's config carries the literal the endpoint now accepts.
      const text = await fs.readFile(configPath, "utf8");
      expect(text).toContain(after!);
      expect(text).not.toContain(before!);
      const fresh = await postTurn(port, after);
      expect(fresh.status).toBe(200);
      await fresh.text();
      const stale = await postTurn(port, before);
      expect(stale.status).toBe(401);
      await stale.text();
    });

    it("refuses with FAROL_MODEL_ROTATE_BLOCK_NOT_UPDATED when the installed block's END marker is torn, and the old token still authenticates", async () => {
      const lifecycle = newLifecycle(await disposableStateRoot(), emptyTurn);
      await lifecycle.start();
      const port = lifecycleExpectedPort(lifecycle);
      const configPath = await configRoot();
      const ports = portsFor(lifecycle, configPath);

      const installed = await ports.spec();
      expect(installed).not.toBeNull();
      await applyFarolModelConfigBlock(configPath, installed!);
      const before = await lifecycle.runtimeState.currentToken();
      expect(before).toBeDefined();

      // The block's END marker is gone: the file is no longer a shape this
      // product will rewrite.
      const torn = (await fs.readFile(configPath, "utf8")).replace(
        "# END FAROL MANAGED BLOCK",
        "# END FAROL MANAGED BLOC",
      );
      await fs.writeFile(configPath, torn, { mode: 0o600 });

      const rotated = await lifecycle.rotateAndRewrite(ports);
      expect(rotated).toMatchObject({
        ok: false,
        code: "FAROL_MODEL_ROTATE_BLOCK_NOT_UPDATED",
      });

      // The token never moved, so the literal the owner's Codex config
      // still carries is still the one the endpoint accepts.
      expect(await lifecycle.runtimeState.currentToken()).toBe(before);
      const answered = await postTurn(port, before);
      expect(answered.status).toBe(200);
      await answered.text();
      expect(await fs.readFile(configPath, "utf8")).toContain(before!);
    });

    it("puts the previous token back when the rewrite fails after the rotation", async () => {
      const lifecycle = newLifecycle(await disposableStateRoot(), emptyTurn);
      await lifecycle.start();
      const port = lifecycleExpectedPort(lifecycle);
      const configPath = await configRoot();
      const ports = portsFor(lifecycle, configPath);

      const installed = await ports.spec();
      expect(installed).not.toBeNull();
      await applyFarolModelConfigBlock(configPath, installed!);
      const before = await lifecycle.runtimeState.currentToken();
      expect(before).toBeDefined();

      const rotated = await lifecycle.rotateAndRewrite({
        ...ports,
        // The preflight passes; the rewrite itself then fails, which is
        // the window a preflight alone cannot close.
        apply: async () => ({ status: "malformed" }),
      });
      expect(rotated).toMatchObject({
        ok: false,
        code: "FAROL_MODEL_ROTATE_BLOCK_NOT_UPDATED",
      });

      expect(await lifecycle.runtimeState.currentToken()).toBe(before);
      const answered = await postTurn(port, before);
      expect(answered.status).toBe(200);
      await answered.text();
    });

    it("rotates without installing anything when no managed block is present", async () => {
      const lifecycle = newLifecycle(await disposableStateRoot(), emptyTurn);
      await lifecycle.start();
      const port = lifecycleExpectedPort(lifecycle);
      const configPath = await configRoot();
      const ports = portsFor(lifecycle, configPath);
      const before = await lifecycle.runtimeState.currentToken();

      const rotated = await lifecycle.rotateAndRewrite(ports);
      expect(rotated).toMatchObject({ ok: true, providerBlockUpdated: false });

      const after = await lifecycle.runtimeState.currentToken();
      expect(after).not.toBe(before);
      const fresh = await postTurn(port, after);
      expect(fresh.status).toBe(200);
      await fresh.text();
      // No block was installed by a rotation.
      await expect(fs.lstat(configPath)).rejects.toThrow();
    });

    // S35-H2-1R. The rotation is a transaction, and these are the three
    // ways it could still leave the endpoint and the owner's config
    // disagreeing: two owner rotations overlapping, a step that rejects
    // instead of returning a status, and a restore that cannot be written.
    it("S35-H2-1R serializes two overlapping rotations, so the literal the config carries is always the one the endpoint accepts", async () => {
      const lifecycle = newLifecycle(await disposableStateRoot(), emptyTurn);
      await lifecycle.start();
      const port = lifecycleExpectedPort(lifecycle);
      const configPath = await configRoot();
      const base = portsFor(lifecycle, configPath);

      const installed = await base.spec();
      expect(installed).not.toBeNull();
      await applyFarolModelConfigBlock(configPath, installed!);
      const original = await lifecycle.runtimeState.currentToken();
      expect(original).toBeDefined();

      const events: string[] = [];
      const traced = (
        tag: string,
        apply: FarolModelRotatePorts["apply"],
      ): FarolModelRotatePorts => ({
        configPath,
        spec: async () => {
          events.push(`${tag}:spec`);
          return base.spec();
        },
        preview: async (path, spec) => {
          events.push(`${tag}:preview`);
          return base.preview(path, spec);
        },
        apply: async (path, spec) => {
          events.push(`${tag}:apply`);
          return apply(path, spec);
        },
      });

      let firstApplyEntered!: () => void;
      const applyEntered = new Promise<void>((resolve) => {
        firstApplyEntered = resolve;
      });
      let releaseFirstApply!: () => void;
      const applyReleased = new Promise<void>((resolve) => {
        releaseFirstApply = resolve;
      });

      // The first rotation parks inside its apply, with its token already
      // rotated and the owner's config still carrying the old literal.
      const first = lifecycle.rotateAndRewrite(
        traced("A", async () => {
          firstApplyEntered();
          await applyReleased;
          throw new Error("config write crashed");
        }),
      );
      await applyEntered;

      // The second rotation is asked for right there, and given real time
      // to run. Serialized, it does nothing at all until the first one has
      // finished putting the previous token back.
      const second = lifecycle.rotateAndRewrite(traced("B", base.apply));
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(events).toEqual([
        "A:spec",
        "A:preview",
        "A:spec",
        "A:preview",
        "A:apply",
      ]);

      releaseFirstApply();
      const [a, b] = await Promise.all([first, second]);
      expect(a).toMatchObject({
        ok: false,
        code: "FAROL_MODEL_ROTATE_BLOCK_NOT_UPDATED",
      });
      expect(b).toMatchObject({ ok: true, providerBlockUpdated: true });
      expect(events).toEqual([
        "A:spec",
        "A:preview",
        "A:spec",
        "A:preview",
        "A:apply",
        "B:spec",
        "B:preview",
        "B:spec",
        "B:preview",
        "B:apply",
      ]);

      // The invariant the mutex exists for: no restore from an earlier
      // rotation may land after a later one's apply.
      const finalToken = await lifecycle.runtimeState.currentToken();
      expect(finalToken).toBeDefined();
      const text = await fs.readFile(configPath, "utf8");
      expect(text).toContain(finalToken!);
      expect(text).not.toContain(original!);
      const fresh = await postTurn(port, finalToken);
      expect(fresh.status).toBe(200);
      await fresh.text();
      const stale = await postTurn(port, original);
      expect(stale.status).toBe(401);
      await stale.text();
    });

    it.each(["spec", "preview", "apply"] as const)(
      "S35-H2-1R puts the previous token back when the post-rotation %s rejects instead of returning a status",
      async (failing) => {
        const lifecycle = newLifecycle(await disposableStateRoot(), emptyTurn);
        await lifecycle.start();
        const port = lifecycleExpectedPort(lifecycle);
        const configPath = await configRoot();
        const base = portsFor(lifecycle, configPath);

        const installed = await base.spec();
        expect(installed).not.toBeNull();
        await applyFarolModelConfigBlock(configPath, installed!);
        const before = await lifecycle.runtimeState.currentToken();
        expect(before).toBeDefined();

        let specCalls = 0;
        let previewCalls = 0;
        const rotated = await lifecycle.rotateAndRewrite({
          configPath,
          spec: async () => {
            specCalls += 1;
            if (failing === "spec" && specCalls > 1) {
              throw new Error("spec crashed");
            }
            return base.spec();
          },
          preview: async (path, spec) => {
            previewCalls += 1;
            if (failing === "preview" && previewCalls > 1) {
              throw new Error("preview crashed");
            }
            return base.preview(path, spec);
          },
          apply: async (path, spec) => {
            if (failing === "apply") throw new Error("apply crashed");
            return base.apply(path, spec);
          },
        });

        // A rejection is not a status, so none is reported — but the
        // outcome is the same typed refusal a bad status gets.
        expect(rotated).toEqual({
          ok: false,
          code: "FAROL_MODEL_ROTATE_BLOCK_NOT_UPDATED",
        });
        expect(await lifecycle.runtimeState.currentToken()).toBe(before);
        const answered = await postTurn(port, before);
        expect(answered.status).toBe(200);
        await answered.text();
        expect(await fs.readFile(configPath, "utf8")).toContain(before!);
      },
    );

    it("S35-H2-1R fails closed when the restore itself fails: the endpoint accepts neither literal and the failure is typed", async () => {
      const lifecycle = newLifecycle(await disposableStateRoot(), emptyTurn);
      await lifecycle.start();
      const port = lifecycleExpectedPort(lifecycle);
      const configPath = await configRoot();
      const base = portsFor(lifecycle, configPath);

      const installed = await base.spec();
      expect(installed).not.toBeNull();
      await applyFarolModelConfigBlock(configPath, installed!);
      const before = await lifecycle.runtimeState.currentToken();
      expect(before).toBeDefined();

      // The private state directory has become unwritable for the restore
      // — the one case where the rotation cannot undo itself.
      Object.defineProperty(lifecycle.runtimeState, "restoreToken", {
        configurable: true,
        value: async () => {
          throw new Error("FAROL_MODEL_STATE_UNSAFE");
        },
      });

      let rotatedToken: string | undefined;
      const rotated = await lifecycle.rotateAndRewrite({
        ...base,
        apply: async () => {
          rotatedToken = await lifecycle.runtimeState.currentToken();
          throw new Error("config write crashed");
        },
      });

      expect(rotated).toEqual({
        ok: false,
        code: "FAROL_MODEL_ROTATE_RESTORE_FAILED",
      });
      expect(rotatedToken).toBeDefined();
      expect(rotatedToken).not.toBe(before);

      // Neither literal authenticates: the owner's config carries the old
      // one, the endpoint was left holding the new one, and accepting
      // nothing is the only closed outcome left until Preview/Apply runs.
      expect(await lifecycle.runtimeState.currentToken()).toBeUndefined();
      const old = await postTurn(port, before);
      expect(old.status).toBe(401);
      await old.text();
      const minted = await postTurn(port, rotatedToken);
      expect(minted.status).toBe(401);
      await minted.text();
      expect(await fs.readFile(configPath, "utf8")).toContain(before!);
    });

    // S35-H2-1R2. `undoRotation` restored, cleared and stopped only when
    // there WAS a previous token. A rotation that begins while the runtime
    // holds none — the token file gone, the owner's config still carrying
    // an earlier literal — therefore kept the freshly minted token after a
    // failed rewrite, so the endpoint went on accepting a value nothing
    // the owner has can produce. The invariant is one sentence for both
    // cases: after a failed rewrite the endpoint accepts exactly what it
    // accepted before the rotation started — the previous literal, or
    // nothing.
    //
    // `ensureToken` is what makes that starting state reachable through a
    // spec: it is what `start()` itself does, and "no token on disk" is
    // exactly the state a previous rotation that failed closed leaves
    // behind.
    function mintingPortsFor(
      lifecycle: FarolModelLifecycle,
      configPath: string,
    ): FarolModelRotatePorts {
      const base = portsFor(lifecycle, configPath);
      return {
        ...base,
        spec: async () => {
          const status = lifecycle.status();
          if (status.state !== "listening" && status.state !== "connected") {
            return null;
          }
          return {
            providerName: "farol",
            displayName: "Farol Model",
            baseUrl: `http://127.0.0.1:${status.port}`,
            model: MODEL,
            wireApi: "responses",
            delivery: {
              mode: "bearer-token",
              token: await lifecycle.runtimeState.ensureToken(),
            },
          };
        },
      };
    }

    it("S35-H2-1R2 clears the minted token when the rotation began with none, so a failed rewrite leaves the endpoint accepting nothing", async () => {
      const lifecycle = newLifecycle(await disposableStateRoot(), emptyTurn);
      await lifecycle.start();
      const port = lifecycleExpectedPort(lifecycle);
      const configPath = await configRoot();
      const base = mintingPortsFor(lifecycle, configPath);

      const installed = await base.spec();
      expect(installed).not.toBeNull();
      await applyFarolModelConfigBlock(configPath, installed!);
      const literal = await lifecycle.runtimeState.currentToken();
      expect(literal).toBeDefined();

      // The endpoint accepts nothing when the rotation starts, while the
      // owner's config still carries the earlier literal.
      await lifecycle.runtimeState.clearToken();
      expect(await lifecycle.runtimeState.currentToken()).toBeUndefined();
      const configBefore = await fs.readFile(configPath, "utf8");

      let mintedToken: string | undefined;
      const rotated = await lifecycle.rotateAndRewrite({
        ...base,
        apply: async () => {
          mintedToken = await lifecycle.runtimeState.currentToken();
          throw new Error("config write crashed");
        },
      });

      expect(rotated).toEqual({
        ok: false,
        code: "FAROL_MODEL_ROTATE_BLOCK_NOT_UPDATED",
      });
      expect(mintedToken).toBeDefined();
      expect(mintedToken).not.toBe(literal);

      // Exactly what it accepted before the rotation: nothing. Neither the
      // literal the owner's config carries nor the token this rotation
      // minted authenticates.
      expect(await lifecycle.runtimeState.currentToken()).toBeUndefined();
      const old = await postTurn(port, literal);
      expect(old.status).toBe(401);
      await old.text();
      const minted = await postTurn(port, mintedToken);
      expect(minted.status).toBe(401);
      await minted.text();
      // The failed rewrite left the owner's config byte for byte alone.
      expect(await fs.readFile(configPath, "utf8")).toBe(configBefore);
    });

    it("S35-H2-1R2 stops the endpoint when the rotation began with no token and clearing the minted one fails", async () => {
      const lifecycle = newLifecycle(await disposableStateRoot(), emptyTurn);
      await lifecycle.start();
      const port = lifecycleExpectedPort(lifecycle);
      const configPath = await configRoot();
      const base = mintingPortsFor(lifecycle, configPath);

      const installed = await base.spec();
      expect(installed).not.toBeNull();
      await applyFarolModelConfigBlock(configPath, installed!);
      await lifecycle.runtimeState.clearToken();
      expect(await lifecycle.runtimeState.currentToken()).toBeUndefined();

      // The private state directory has become unwritable, so removing the
      // minted token fails as well — the one case left where this process
      // cannot put the endpoint back the way it found it.
      Object.defineProperty(lifecycle.runtimeState, "clearToken", {
        configurable: true,
        value: async () => {
          throw new Error("FAROL_MODEL_STATE_UNSAFE");
        },
      });

      let mintedToken: string | undefined;
      const rotated = await lifecycle.rotateAndRewrite({
        ...base,
        apply: async () => {
          mintedToken = await lifecycle.runtimeState.currentToken();
          throw new Error("config write crashed");
        },
      });

      expect(rotated).toEqual({
        ok: false,
        code: "FAROL_MODEL_ROTATE_RESTORE_FAILED",
      });
      expect(mintedToken).toBeDefined();
      // Sealed, then stopped: the token it was left holding cannot be
      // used against it, and S35-TA-2 makes the refusal independent of
      // this close having worked. Both are asserted — the seal is the
      // guarantee, the closed port is the tidy-up that followed it.
      expect(lifecycle.status()).toEqual({ state: "sealed", port });
      await expect(postTurn(port, mintedToken)).rejects.toThrow();
    });

    // S35-TA-2 (round-3 P1). Both fail-closed branches ended in
    // `await this.stop().catch(() => undefined)`, so the promise that
    // every request is refused rested entirely on closing the listener.
    // When the close itself fails — and the token file still carries the
    // literal this rotation minted, because clearing it is what failed in
    // the first place — the endpoint stayed live accepting a value the
    // owner's config does not carry. The refusal must not depend on
    // `stop()` succeeding: entering the fail-closed path seals the
    // endpoint first, in memory, with no I/O that can fail.
    //
    // The table below is the whole state space of the fail-closed path, so
    // a later case does not need another round:
    //
    // | previous token | restoreToken | clearToken | endpoint.stop() | outcome                             |
    // |----------------|--------------|------------|-----------------|-------------------------------------|
    // | set            | ok           | —          | not reached     | BLOCK_NOT_UPDATED, old literal back |
    // | set            | throws       | ok         | not reached     | RESTORE_FAILED, sealed, nothing works |
    // | set            | throws       | throws     | ok              | RESTORE_FAILED, sealed, stopped     |
    // | set            | throws       | throws     | throws          | RESTORE_FAILED, sealed, still bound |
    // | unset          | —            | ok         | not reached     | RESTORE_FAILED, sealed, nothing works |
    // | unset          | —            | throws     | ok              | RESTORE_FAILED, sealed, stopped     |
    // | unset          | —            | throws     | throws          | RESTORE_FAILED, sealed, still bound |
    //
    // The failing step is `apply` in each row below; `spec` and `preview`
    // reach the same `undoRotation` and are covered by the S35-H2-1R
    // serialization cases above.
    /** Makes the endpoint's own close fail, leaving the socket bound. */
    function breakEndpointStop(lifecycle: FarolModelLifecycle): void {
      const endpoint = lifecycle.endpoint;
      expect(endpoint).toBeDefined();
      Object.defineProperty(endpoint!, "stop", {
        configurable: true,
        value: async () => {
          throw new Error("FAROL_MODEL_ENDPOINT_CLOSE_FAILED");
        },
      });
    }

    /** Makes a runtime-state write fail, as an unwritable state directory does. */
    function breakStateWrite(
      lifecycle: FarolModelLifecycle,
      method: "restoreToken" | "clearToken",
    ): void {
      Object.defineProperty(lifecycle.runtimeState, method, {
        configurable: true,
        value: async () => {
          throw new Error("FAROL_MODEL_STATE_UNSAFE");
        },
      });
    }

    it("S35-TA-2 seals the endpoint when the restore fails and the close fails too: the port is still bound and refuses both literals", async () => {
      const lifecycle = newLifecycle(await disposableStateRoot(), emptyTurn);
      await lifecycle.start();
      const port = lifecycleExpectedPort(lifecycle);
      const configPath = await configRoot();
      const base = portsFor(lifecycle, configPath);

      const installed = await base.spec();
      expect(installed).not.toBeNull();
      await applyFarolModelConfigBlock(configPath, installed!);
      const before = await lifecycle.runtimeState.currentToken();
      expect(before).toBeDefined();

      breakStateWrite(lifecycle, "restoreToken");
      breakStateWrite(lifecycle, "clearToken");
      breakEndpointStop(lifecycle);

      let mintedToken: string | undefined;
      const rotated = await lifecycle.rotateAndRewrite({
        ...base,
        apply: async () => {
          mintedToken = await lifecycle.runtimeState.currentToken();
          throw new Error("config write crashed");
        },
      });

      expect(rotated).toEqual({
        ok: false,
        code: "FAROL_MODEL_ROTATE_RESTORE_FAILED",
      });
      expect(mintedToken).toBeDefined();
      expect(mintedToken).not.toBe(before);
      // The token file still carries the minted literal — clearing it is
      // exactly what failed — and the socket is still bound, because the
      // close failed. Neither of those may make the endpoint usable.
      expect(await lifecycle.runtimeState.currentToken()).toBe(mintedToken);

      const minted = await postTurn(port, mintedToken);
      expect(minted.status).toBe(401);
      await minted.text();
      const old = await postTurn(port, before);
      expect(old.status).toBe(401);
      await old.text();
      expect(lifecycle.status()).toEqual({ state: "sealed", port });
    });

    it("S35-TA-2 seals the endpoint when the rotation began with no token, clearing fails and the close fails too", async () => {
      const lifecycle = newLifecycle(await disposableStateRoot(), emptyTurn);
      await lifecycle.start();
      const port = lifecycleExpectedPort(lifecycle);
      const configPath = await configRoot();
      const base = mintingPortsFor(lifecycle, configPath);

      const installed = await base.spec();
      expect(installed).not.toBeNull();
      await applyFarolModelConfigBlock(configPath, installed!);
      const earlier = await lifecycle.runtimeState.currentToken();
      await lifecycle.runtimeState.clearToken();
      expect(await lifecycle.runtimeState.currentToken()).toBeUndefined();

      breakStateWrite(lifecycle, "clearToken");
      breakEndpointStop(lifecycle);

      let mintedToken: string | undefined;
      const rotated = await lifecycle.rotateAndRewrite({
        ...base,
        apply: async () => {
          mintedToken = await lifecycle.runtimeState.currentToken();
          throw new Error("config write crashed");
        },
      });

      expect(rotated).toEqual({
        ok: false,
        code: "FAROL_MODEL_ROTATE_RESTORE_FAILED",
      });
      expect(mintedToken).toBeDefined();
      expect(await lifecycle.runtimeState.currentToken()).toBe(mintedToken);

      const minted = await postTurn(port, mintedToken);
      expect(minted.status).toBe(401);
      await minted.text();
      const old = await postTurn(port, earlier);
      expect(old.status).toBe(401);
      await old.text();
      expect(lifecycle.status()).toEqual({ state: "sealed", port });
    });

    it("S35-TA-2 a sealed endpoint stays sealed: start() does not revive it and its evidence records the refusals", async () => {
      const lifecycle = newLifecycle(await disposableStateRoot(), emptyTurn);
      await lifecycle.start();
      const port = lifecycleExpectedPort(lifecycle);
      const configPath = await configRoot();
      const base = portsFor(lifecycle, configPath);

      const installed = await base.spec();
      await applyFarolModelConfigBlock(configPath, installed!);
      breakStateWrite(lifecycle, "restoreToken");
      breakStateWrite(lifecycle, "clearToken");
      breakEndpointStop(lifecycle);
      await lifecycle.rotateAndRewrite({
        ...base,
        apply: async () => {
          throw new Error("config write crashed");
        },
      });
      expect(lifecycle.status()).toEqual({ state: "sealed", port });

      // A later `start()` must not build a fresh endpoint over the same
      // poisoned token file: that would un-seal the refusal.
      await lifecycle.start();
      expect(lifecycle.status()).toEqual({ state: "sealed", port });
      const again = await postTurn(
        port,
        await lifecycle.runtimeState.currentToken(),
      );
      expect(again.status).toBe(401);
      await again.text();

      // A second rotation cannot move the token of a sealed endpoint.
      await expect(lifecycle.rotateAndRewrite(base)).resolves.toEqual({
        ok: false,
        code: "MODEL_ENDPOINT_UNAVAILABLE",
      });
    });

    it("S35-TA-2 an ordinary failed rewrite that restores cleanly does not seal the endpoint", async () => {
      const lifecycle = newLifecycle(await disposableStateRoot(), emptyTurn);
      await lifecycle.start();
      const port = lifecycleExpectedPort(lifecycle);
      const configPath = await configRoot();
      const base = portsFor(lifecycle, configPath);

      const installed = await base.spec();
      await applyFarolModelConfigBlock(configPath, installed!);
      const before = await lifecycle.runtimeState.currentToken();

      const rotated = await lifecycle.rotateAndRewrite({
        ...base,
        apply: async () => {
          throw new Error("config write crashed");
        },
      });

      expect(rotated).toEqual({
        ok: false,
        code: "FAROL_MODEL_ROTATE_BLOCK_NOT_UPDATED",
      });
      // The restore worked, so the endpoint is exactly as the rotation
      // found it — listening, and accepting the literal the config
      // carries. Nothing was sealed by an ordinary refusal.
      expect(lifecycle.status().state).toBe("listening");
      const old = await postTurn(port, before);
      expect(old.status).toBe(200);
      await old.text();
      expect(lifecycle.status().state).toBe("connected");
    });

    it("refuses before the token moves when the endpoint is not running", async () => {
      const lifecycle = newLifecycle(await disposableStateRoot(), emptyTurn);
      const configPath = await configRoot();
      await expect(
        lifecycle.rotateAndRewrite(portsFor(lifecycle, configPath)),
      ).resolves.toEqual({ ok: false, code: "MODEL_ENDPOINT_UNAVAILABLE" });
    });
  });

  it("start() is idempotent while already running", async () => {
    const stateRoot = await disposableStateRoot();
    const lifecycle = newLifecycle(stateRoot);
    await lifecycle.start();
    const first = lifecycleExpectedPort(lifecycle);
    await lifecycle.start();
    expect(lifecycleExpectedPort(lifecycle)).toBe(first);
  });
});

function lifecycleExpectedPort(lifecycle: FarolModelLifecycle): number {
  const status = lifecycle.status();
  if (status.state !== "listening" && status.state !== "connected") {
    throw new Error(`expected a listening lifecycle, got ${status.state}`);
  }
  return status.port;
}
