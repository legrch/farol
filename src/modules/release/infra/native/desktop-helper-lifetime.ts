import { fstatSync } from "node:fs";
import { Socket } from "node:net";
import type {
  InstalledHelperLifetime,
  InstalledUpdateRequest,
} from "./installed-update-helper";

const LIMIT = 4096;

/** The launcher inherits only these two private pipes into Electron. These are
 * unrelated to the helper's request/ACK/lease/continue fd3/4/5/6. */
export function createDesktopHelperLifetime(): InstalledHelperLifetime {
  try {
    if (
      process.platform !== "darwin" ||
      process.env.FAROL_DESKTOP_LIFETIME !== "1" ||
      !fstatSync(7).isFIFO() ||
      !fstatSync(8).isFIFO()
    )
      return unavailable;
    const send = new Socket({ fd: 7, readable: false, writable: true });
    const receive = new Socket({ fd: 8, readable: true, writable: false });
    send.unref();
    receive.unref();
    return lifetimeChannel(send, receive);
  } catch {
    return unavailable;
  }
}

const unavailable: InstalledHelperLifetime = {
  available: () => false,
  retain: async () => {
    throw new Error("UPDATE_HELPER_LIFETIME_UNAVAILABLE");
  },
};

// Exported for actual-pipe regressions; production supplies only inherited fds.
export function lifetimeChannel(
  send: Socket,
  receive: Socket,
): InstalledHelperLifetime {
  let failed = false;
  let pending: {
    frame: string;
    deadlineAt: number;
    complete(error?: Error): void;
  } | null = null;
  let bytes = Buffer.alloc(0);
  const fail = () => {
    failed = true;
    pending?.complete(new Error("UPDATE_HELPER_LIFETIME_UNKNOWN"));
    send.destroy();
    receive.destroy();
  };
  for (const stream of [send, receive]) {
    stream.on("error", fail);
    stream.on("close", fail);
  }
  receive.on("end", fail);
  receive.on("data", (chunk: Buffer) => {
    if (failed) return;
    if (!pending || bytes.length + chunk.length > LIMIT) {
      fail();
      return;
    }
    bytes = Buffer.concat([bytes, chunk]);
    const newline = bytes.indexOf(10);
    if (newline < 0) return;
    // Echo must match the whole original frame. No unrelated, trailing or
    // duplicate ACK can advance another operation.
    if (
      Date.now() >= pending.deadlineAt ||
      newline !== bytes.length - 1 ||
      bytes.toString("utf8") !== pending.frame
    ) {
      fail();
      return;
    }
    bytes = Buffer.alloc(0);
    pending.complete();
  });
  return {
    available: () => !failed && !send.destroyed && !receive.destroyed,
    retain: async (request, helper, deadlineAt) => {
      if (failed || pending || deadlineAt <= Date.now()) {
        throw new Error("UPDATE_HELPER_LIFETIME_UNAVAILABLE");
      }
      const frame = bindingFrame(request, helper, deadlineAt);
      if (Buffer.byteLength(frame) > LIMIT)
        throw new Error("UPDATE_HELPER_LIFETIME_INVALID");
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(fail, Math.max(1, deadlineAt - Date.now()));
        pending = {
          frame,
          deadlineAt,
          complete: (error) => {
            clearTimeout(timer);
            pending = null;
            if (error) reject(error);
            else resolve();
          },
        };
        send.write(frame, (error) => {
          if (error) fail();
        });
      });
    },
  };
}

function bindingFrame(
  request: InstalledUpdateRequest,
  helper: Readonly<{ pid: number; processStart: string }>,
  deadlineAt: number,
): string {
  const build = (value: InstalledUpdateRequest["source"]) => ({
    buildId: value.buildId,
    digest: value.digest,
    version: value.version,
  });
  return (
    JSON.stringify({
      schema: "farol.desktop-helper-lifetime/1",
      operationId: request.operationId,
      action: request.action,
      installLocation: request.installLocation ?? "legacy",
      source: build(request.source),
      target: build(request.target),
      predecessor: { pid: request.pid, processStart: request.processStart },
      helper: { pid: helper.pid, processStart: helper.processStart },
      deadlineAt,
    }) + "\n"
  );
}
