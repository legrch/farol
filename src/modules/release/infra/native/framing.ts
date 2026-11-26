import { fail, header, type TransportFailure } from "./failure";

export type HttpsResponse = Readonly<{
  statusCode: number;
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  body: AsyncIterable<Uint8Array>;
  complete(): boolean;
  destroy(): void;
}>;

export function lengthFailure(
  response: HttpsResponse,
  limit: number,
): TransportFailure | null {
  const encoding = header(response.headers["content-encoding"]);
  if (encoding !== null && encoding.toLowerCase() !== "identity")
    return fail("network_failure", "content_encoding");
  const raw = response.headers["content-length"];
  if (raw === undefined) return null;
  const length = header(raw);
  if (length === null || !/^(0|[1-9][0-9]*)$/u.test(length))
    return fail("network_failure", "content_length");
  return BigInt(length) > BigInt(limit) ? fail("oversize", "limit") : null;
}
