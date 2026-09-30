import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { Duplex } from "node:stream";
import WebSocket, { type ClientOptions } from "ws";

type Failure = "pipe_failed" | "invalid_protocol" | "closed";

/** WebSocket over the exact admitted proxy's pipes. No socket or dial fallback. */
export class CodexProxyWebSocket {
  readonly opened: Promise<void>;
  private readonly stream: Duplex;
  private readonly socket: WebSocket;
  private stopped = false;
  private rejectOpen: (error: Error) => void = () => {};
  private readonly writes = new Set<(error?: Error) => void>();
  private pipeEndTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    child: ChildProcessWithoutNullStreams,
    private readonly maxMessageBytes: number,
    private readonly maxBufferedBytes: number,
    onMessage: (message: Buffer) => void,
    private readonly onFailure: (failure: Failure) => void,
  ) {
    const data = (chunk: Buffer) => {
      if (!this.stream.push(chunk)) child.stdout.pause();
    };
    const end = () => {
      if (this.socket.readyState === WebSocket.CLOSING) {
        this.stream.push(null);
        return;
      }
      // stdout EOF commonly precedes the same child's exit event. Give that
      // event a bounded observation window before classifying a broken pipe.
      this.pipeEndTimer = setTimeout(() => this.failed("pipe_failed"), 100);
      this.pipeEndTimer.unref?.();
    };
    this.stream = new Duplex({
      read: () => child.stdout.resume(),
      write: (chunk, encoding, done) => {
        try {
          child.stdin.write(chunk, encoding, done);
        } catch {
          done(new Error("CODEX_PROXY_PIPE_FAILED"));
        }
      },
      final: (done) => child.stdin.end(done),
      destroy: (error, done) => {
        child.stdout.off("data", data);
        child.stdout.off("end", end);
        done(error);
      },
    });
    child.stdout.on("data", data);
    child.stdout.once("end", end);
    let resolveOpen: () => void = () => {};
    this.opened = new Promise<void>((resolve, reject) => {
      resolveOpen = resolve;
      this.rejectOpen = reject;
    });
    this.socket = new WebSocket("ws://codex-app-server/rpc", {
      // Node HTTP accepts a Duplex here; @types/ws specializes it to net.Socket.
      createConnection: (() => this.stream) as unknown as NonNullable<
        ClientOptions["createConnection"]
      >,
      followRedirects: false,
      perMessageDeflate: false,
      autoPong: false,
      maxPayload: maxMessageBytes,
      skipUTF8Validation: false,
    });
    this.socket.once("open", resolveOpen);
    this.socket.on("error", () => this.failed("invalid_protocol"));
    this.socket.once("close", () => this.failed("closed"));
    this.socket.on("message", (data, binary) => {
      if (this.stopped) return;
      if (binary || !Buffer.isBuffer(data)) {
        this.failed("invalid_protocol");
        return;
      }
      onMessage(data);
    });
    this.socket.on("ping", (data) => {
      if (!this.canWrite(data.length + 14)) return;
      try {
        this.socket.pong(data, true, (error) => {
          if (error) this.failed("pipe_failed");
        });
      } catch {
        this.failed("pipe_failed");
      }
    });
  }

  private failed(failure: Failure): void {
    if (this.stopped) return;
    this.onFailure(failure);
    this.close();
  }

  private canWrite(frameBytes: number): boolean {
    if (this.stopped) return false;
    if (
      this.socket.readyState !== WebSocket.OPEN ||
      this.socket.bufferedAmount + frameBytes > this.maxBufferedBytes
    ) {
      this.failed("pipe_failed");
      return false;
    }
    return true;
  }

  send(message: string): Promise<void> {
    if (!this.canWrite(Buffer.byteLength(message) + 14))
      return Promise.reject(new Error("CODEX_PROXY_PIPE_FAILED"));
    if (Buffer.byteLength(message) > this.maxMessageBytes) {
      this.failed("invalid_protocol");
      return Promise.reject(new Error("CODEX_PROXY_FRAME_TOO_LARGE"));
    }
    return new Promise((resolve, reject) => {
      const done = (error?: Error) => {
        if (!this.writes.delete(done)) return;
        if (error) {
          this.failed("pipe_failed");
          reject(new Error("CODEX_PROXY_PIPE_FAILED"));
        } else resolve();
      };
      this.writes.add(done);
      try {
        this.socket.send(message, { binary: false, compress: false }, done);
      } catch {
        done(new Error("CODEX_PROXY_PIPE_FAILED"));
      }
    });
  }

  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.pipeEndTimer);
    this.rejectOpen(new Error("CODEX_PROXY_WEBSOCKET_UNAVAILABLE"));
    for (const done of this.writes) done(new Error("CODEX_PROXY_PIPE_FAILED"));
    this.socket.terminate();
    this.stream.destroy();
  }
}
