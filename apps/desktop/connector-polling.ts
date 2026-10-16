import type { ComputerConnectorPollingSamples } from "./bridge/wire.ts";

const maximumBytes = 256 * 1024;
const metrics = {
  commands_poll_cycles_total: "cycles",
  commands_poll_errors_total: "errors",
  commands_poll_last_successful_timestamp_seconds: "lastSuccessMillis",
} as const;

// Boundary parsing only. Go classifies recency; neither these numbers nor a
// local successful HTTP response prove external availability or attachment.
export function parseConnectorPollingMetrics(
  text: string,
): ComputerConnectorPollingSamples {
  if (Buffer.byteLength(text, "utf8") > maximumBytes) return Object.freeze({});
  const lines = text.split("\n");
  if (lines.length > 4096) return Object.freeze({});
  const samples = new Map<string, string[]>();
  for (const line of lines) {
    const match =
      /^([a-zA-Z_][a-zA-Z0-9_]*)(?:\{[^}]*\})?\s+(\S+)(?:\s|$)/u.exec(line);
    if (!match || !Object.hasOwn(metrics, match[1]!)) continue;
    const values = samples.get(match[1]!) ?? [];
    values.push(match[2]!);
    samples.set(match[1]!, values);
  }
  const result: {
    cycles?: string;
    errors?: string;
    lastSuccessMillis?: string;
  } = {};
  for (const [name, key] of Object.entries(metrics)) {
    const values = samples.get(name);
    // Multiple series are ambiguous for this observation; never pick the
    // freshest label or combine unrelated polling channels into a positive.
    if (
      values?.length !== 1 ||
      !/^\+?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/u.test(
        values[0]!,
      )
    )
      continue;
    const number = Number(values[0]);
    const converted =
      key === "lastSuccessMillis" ? Math.floor(number * 1000) : number;
    if (
      !Number.isSafeInteger(converted) ||
      converted < 0 ||
      (number > 0 && converted === 0)
    )
      continue;
    result[key] = String(converted);
  }
  return Object.freeze(result);
}

// Only the runtime's original private loopback locator reaches this adapter.
// No redirect, credential, discovery, restart or unbounded response body.
export async function readConnectorPollingMetrics(
  base: string,
): Promise<ComputerConnectorPollingSamples> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const url = new URL(base);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      !url.port ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      return Object.freeze({});
    const response = await fetch(new URL("/metrics", url), {
      redirect: "error",
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      return Object.freeze({});
    }
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maximumBytes) return Object.freeze({});
      chunks.push(part.value);
    }
    return parseConnectorPollingMetrics(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } catch {
    return Object.freeze({});
  } finally {
    await reader?.cancel().catch(() => undefined);
  }
}
