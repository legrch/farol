import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  type FileHandle,
} from "node:fs/promises";
import { get as httpsGet, type RequestOptions } from "node:https";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { PackageVerificationError } from "./update-package-verifier";
import {
  GITHUB_RELEASES_API,
  GITHUB_RELEASE_REPOSITORY,
  MAX_ARCHIVE_BYTES,
  MAX_MANIFEST_BYTES,
  MAX_RELEASES_JSON_BYTES,
  type DownloadedArchive,
  type FetchedJson,
  type GithubReleasePorts,
  type ReleaseManifest,
  type PortFailure,
  type VerifiedPackage,
} from "../../domain/github-release-contract";

const CDN_HOST = "release-assets.githubusercontent.com";
const STAGING_NAME = "github-updates";
const JSON_TIMEOUT_MS = 30_000;
const ARCHIVE_TIMEOUT_MS = 15 * 60_000;
const HEADERS = Object.freeze({
  "User-Agent": "Farol-Update/1",
  Accept: "application/vnd.github+json",
  "Accept-Encoding": "identity",
});

export type TransportFailure = PortFailure &
  Readonly<{
    certainty: "known" | "unknown";
    reason:
      | "invalid_url"
      | "redirect"
      | "http_status"
      | "network"
      | "invalid_json"
      | "content_length"
      | "content_encoding"
      | "stream"
      | "limit"
      | "private_state"
      | "stage_cleanup"
      | "invalid_handle"
      | "verification";
  }>;
export type TransportResult<T> =
  Readonly<{ ok: true; value: T }> | TransportFailure;

export type HttpsResponse = Readonly<{
  statusCode: number;
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  body: AsyncIterable<Uint8Array>;
  complete(): boolean;
  destroy(): void;
}>;
export type OpenHttps = (
  url: string,
  headers: Readonly<Record<string, string>>,
  timeoutMs: number,
) => Promise<HttpsResponse>;

export type GithubUpdateTransport = GithubReleasePorts &
  Readonly<{
    fetchJson(
      url: string,
      maxBytes: number,
    ): Promise<TransportResult<FetchedJson>>;
    download(
      url: string,
      maxBytes: number,
    ): Promise<TransportResult<DownloadedArchive>>;
    verifyPackage(
      handle: string,
      manifest: ReleaseManifest,
    ): Promise<TransportResult<VerifiedPackage>>;
    discard(handle: string): Promise<TransportResult<void>>;
  }>;

function fail(
  kind: PortFailure["kind"],
  reason: TransportFailure["reason"],
  certainty: "known" | "unknown" = "known",
): TransportFailure {
  return { ok: false, kind, reason, certainty };
}

function header(value: string | readonly string[] | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function httpsUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash
      ? url
      : null;
  } catch {
    return null;
  }
}

function initialKind(value: string): "api" | "asset" | null {
  if (value === GITHUB_RELEASES_API) return "api";
  const url = httpsUrl(value);
  if (!url || url.href !== value || url.hostname !== "github.com" || url.search)
    return null;
  const prefix = `/${GITHUB_RELEASE_REPOSITORY}/releases/download/`;
  const rest = url.pathname.startsWith(prefix)
    ? url.pathname.slice(prefix.length)
    : "";
  return /^v[0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(rest)
    ? "asset"
    : null;
}

function cdnUrl(value: string): boolean {
  const url = httpsUrl(value);
  return url !== null && url.hostname === CDN_HOST && url.pathname.length > 1;
}

function validLimit(value: number, ceiling: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= ceiling;
}

function lengthFailure(
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

function redirected(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

async function openPinned(
  url: string,
  client: OpenHttps,
  timeoutMs: number,
): Promise<
  TransportResult<{
    response: HttpsResponse;
    finalUrl: string;
    redirects: readonly string[];
  }>
> {
  const kind = initialKind(url);
  if (!kind) return fail("network_failure", "invalid_url");
  let response: HttpsResponse;
  try {
    response = await client(url, HEADERS, timeoutMs);
  } catch {
    return fail("network_failure", "network");
  }
  if (redirected(response.statusCode)) {
    const location = header(response.headers.location);
    response.destroy();
    if (kind !== "asset" || location === null || !cdnUrl(location))
      return fail("network_failure", "redirect");
    try {
      response = await client(location, HEADERS, timeoutMs);
    } catch {
      return fail("network_failure", "network");
    }
    if (response.statusCode !== 200) {
      const reason = redirected(response.statusCode)
        ? "redirect"
        : "http_status";
      response.destroy();
      return fail("network_failure", reason);
    }
    return {
      ok: true,
      value: { response, finalUrl: location, redirects: [url, location] },
    };
  }
  if (response.statusCode !== 200) {
    response.destroy();
    return fail("network_failure", "http_status");
  }
  return { ok: true, value: { response, finalUrl: url, redirects: [] } };
}

function wrap(message: IncomingMessage): HttpsResponse {
  return {
    statusCode: message.statusCode ?? 0,
    headers: message.headers,
    body: message,
    complete: () => message.complete,
    destroy: () => message.destroy(),
  };
}

// Node's HTTPS client does not follow redirects. TLS validation remains enabled.
export const openNativeHttps: OpenHttps = (url, headers, timeoutMs) =>
  new Promise((resolve, reject) => {
    const options: RequestOptions = {
      method: "GET",
      headers,
      rejectUnauthorized: true,
      agent: false,
    };
    const request = httpsGet(url, options, (response) => {
      response.once("close", () => clearTimeout(deadline));
      response.setTimeout(timeoutMs, () =>
        response.destroy(new Error("HTTPS response timeout")),
      );
      resolve(wrap(response));
    });
    const deadline = setTimeout(
      () => request.destroy(new Error("HTTPS total timeout")),
      timeoutMs,
    );
    request.setTimeout(timeoutMs, () =>
      request.destroy(new Error("HTTPS request timeout")),
    );
    request.once("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
  });

async function privateDirectory(directory: string): Promise<boolean> {
  try {
    if (!path.isAbsolute(directory) || path.normalize(directory) !== directory)
      return false;
    const stat = await lstat(directory);
    return (
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      (stat.mode & 0o077) === 0 &&
      stat.uid === process.getuid?.() &&
      (await realpath(directory)) === directory
    );
  } catch {
    return false;
  }
}

async function stageDirectory(root: string): Promise<string | null> {
  if (!(await privateDirectory(root))) return null;
  const directory = path.join(root, STAGING_NAME);
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") return null;
  }
  return (await privateDirectory(directory)) ? directory : null;
}

async function validStagedFile(
  directory: string,
  handle: string,
): Promise<boolean> {
  if (
    !(await privateDirectory(directory)) ||
    path.dirname(handle) !== directory ||
    !/^[a-f0-9-]{36}\.zip$/u.test(path.basename(handle))
  )
    return false;
  try {
    const stat = await lstat(handle);
    return (
      stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.nlink === 1 &&
      (stat.mode & 0o077) === 0 &&
      stat.uid === process.getuid?.()
    );
  } catch {
    return false;
  }
}

function sameOwnedFile(current: BigIntStats, issued: BigIntStats): boolean {
  return (
    current.isFile() &&
    issued.isFile() &&
    current.nlink === 1n &&
    current.uid === BigInt(process.getuid!()) &&
    (current.mode & 0o077n) === 0n &&
    current.dev === issued.dev &&
    current.ino === issued.ino &&
    current.size === issued.size &&
    current.mode === issued.mode &&
    current.mtimeNs === issued.mtimeNs &&
    current.ctimeNs === issued.ctimeNs
  );
}

export function createGithubUpdateTransport(
  options: Readonly<{
    privateStateDirectory: string;
    verifyPackage(
      handle: string,
      manifest: ReleaseManifest,
    ): Promise<VerifiedPackage>;
    openHttps?: OpenHttps;
  }>,
): GithubUpdateTransport {
  const client = options.openHttps ?? openNativeHttps;
  const issuedArchives = new Map<string, BigIntStats>();
  let emptySlot: { handle: string; identity: BigIntStats } | null = null;
  // Reclaim only bytes of the opened file. Unlinking a checked path would race
  // replacement. Keep one empty slot for subsequent checks in this lifetime.
  const emptyOpenedArchive = async (file: FileHandle, handle: string) => {
    await file.truncate(0);
    await file.sync();
    const identity = await file.stat({ bigint: true });
    if (
      !(await privateDirectory(path.dirname(handle))) ||
      !sameOwnedFile(await lstat(handle, { bigint: true }), identity)
    )
      throw new Error("UPDATE_STAGE_CHANGED");
    return { handle, identity };
  };
  return {
    async fetchJson(url, maxBytes) {
      const kind = initialKind(url);
      if (
        !kind ||
        !validLimit(
          maxBytes,
          kind === "api" ? MAX_RELEASES_JSON_BYTES : MAX_MANIFEST_BYTES,
        )
      )
        return fail("network_failure", "invalid_url");
      const opened = await openPinned(url, client, JSON_TIMEOUT_MS);
      if (!opened.ok) return opened;
      const { response, finalUrl, redirects } = opened.value;
      const invalidLength = lengthFailure(response, maxBytes);
      if (invalidLength) {
        response.destroy();
        return invalidLength;
      }
      let measured = 0;
      const chunks: Buffer[] = [];
      try {
        for await (const raw of response.body) {
          const chunk = Buffer.from(raw);
          measured += chunk.length;
          if (measured > maxBytes) {
            response.destroy();
            return fail("oversize", "limit");
          }
          chunks.push(chunk);
        }
        if (!response.complete()) return fail("interrupted", "stream");
        const declared = header(response.headers["content-length"]);
        if (declared !== null && BigInt(declared) !== BigInt(measured))
          return fail("interrupted", "content_length");
        return {
          ok: true,
          value: {
            value: JSON.parse(
              Buffer.concat(chunks).toString("utf8"),
            ) as unknown,
            finalUrl,
            redirects,
          },
        };
      } catch (error) {
        return fail(
          error instanceof SyntaxError
            ? "network_failure"
            : measured > 0
              ? "interrupted"
              : "network_failure",
          error instanceof SyntaxError ? "invalid_json" : "stream",
        );
      } finally {
        response.destroy();
      }
    },
    async download(url, maxBytes) {
      if (
        initialKind(url) !== "asset" ||
        !validLimit(maxBytes, MAX_ARCHIVE_BYTES)
      )
        return fail("network_failure", "invalid_url");
      const opened = await openPinned(url, client, ARCHIVE_TIMEOUT_MS);
      if (!opened.ok) return opened;
      const { response, finalUrl, redirects } = opened.value;
      const invalidLength = lengthFailure(response, maxBytes);
      if (invalidLength) {
        response.destroy();
        return invalidLength;
      }
      const directory = await stageDirectory(options.privateStateDirectory);
      if (!directory) {
        response.destroy();
        return fail("interrupted", "private_state");
      }
      const reusable = emptySlot;
      emptySlot = null;
      const handle =
        reusable?.handle ?? path.join(directory, `${randomUUID()}.zip`);
      let file;
      try {
        const closeOnExec =
          (Reflect.get(constants, "O_CLOEXEC") as number | undefined) ?? 0;
        file = await open(
          handle,
          constants.O_WRONLY |
            (reusable ? 0 : constants.O_CREAT | constants.O_EXCL) |
            constants.O_NOFOLLOW |
            constants.O_NONBLOCK |
            closeOnExec,
          0o600,
        );
        if (
          reusable &&
          !sameOwnedFile(await file.stat({ bigint: true }), reusable.identity)
        )
          throw new Error("UPDATE_STAGE_CHANGED");
      } catch {
        response.destroy();
        if (file) await file.close().catch(() => undefined);
        if (reusable) return fail("interrupted", "stage_cleanup", "unknown");
        return fail("interrupted", "private_state");
      }
      let bytes = 0;
      let issuedIdentity: BigIntStats | null = null;
      const digest = createHash("sha256");
      let result: TransportResult<DownloadedArchive> | null = null;
      try {
        for await (const raw of response.body) {
          const chunk = Buffer.from(raw);
          bytes += chunk.length;
          if (bytes > maxBytes) {
            response.destroy();
            result = fail("oversize", "limit");
            break;
          }
          let offset = 0;
          while (offset < chunk.length) {
            const written = await file.write(
              chunk,
              offset,
              chunk.length - offset,
            );
            if (written.bytesWritten < 1)
              throw new Error("stage write stopped");
            offset += written.bytesWritten;
          }
          digest.update(chunk);
        }
        if (result === null) {
          if (!response.complete()) result = fail("interrupted", "stream");
          else if (
            header(response.headers["content-length"]) !== null &&
            BigInt(header(response.headers["content-length"])!) !==
              BigInt(bytes)
          )
            result = fail("interrupted", "content_length");
          else {
            await file.sync();
            issuedIdentity = await file.stat({ bigint: true });
            result = {
              ok: true,
              value: {
                handle,
                size: bytes,
                sha256: digest.digest("hex"),
                finalUrl,
                redirects,
              },
            };
          }
        }
      } catch {
        result = fail(bytes > 0 ? "interrupted" : "network_failure", "stream");
      } finally {
        response.destroy();
        if (result && !result.ok) {
          try {
            emptySlot = await emptyOpenedArchive(file, handle);
          } catch {
            result = fail("interrupted", "stage_cleanup", "unknown");
          }
        }
        try {
          await file.close();
        } catch {
          emptySlot = null;
          result = fail("interrupted", "stage_cleanup", "unknown");
        }
      }
      if (!result.ok) return result;
      if (!issuedIdentity)
        return fail("interrupted", "stage_cleanup", "unknown");
      try {
        if (
          !(await privateDirectory(directory)) ||
          !sameOwnedFile(await lstat(handle, { bigint: true }), issuedIdentity)
        )
          return fail("interrupted", "private_state", "unknown");
      } catch {
        return fail("interrupted", "private_state", "unknown");
      }
      issuedArchives.set(handle, issuedIdentity);
      return result;
    },
    async discard(handle) {
      const issued = issuedArchives.get(handle);
      if (!issued) return fail("interrupted", "invalid_handle");
      const directory = path.join(options.privateStateDirectory, STAGING_NAME);
      if (!(await privateDirectory(directory)))
        return fail("interrupted", "stage_cleanup", "unknown");
      let file;
      try {
        file = await open(
          handle,
          constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        if (!sameOwnedFile(await file.stat({ bigint: true }), issued))
          throw new Error("UPDATE_STAGE_CHANGED");
        const reusable = await emptyOpenedArchive(file, handle);
        const closing = file;
        file = undefined;
        await closing.close();
        emptySlot = reusable;
        issuedArchives.delete(handle);
        return { ok: true, value: undefined };
      } catch {
        if (file) await file.close().catch(() => undefined);
        return fail("interrupted", "stage_cleanup", "unknown");
      }
    },
    async verifyPackage(handle, manifest) {
      const directory = await stageDirectory(options.privateStateDirectory);
      if (!directory || !(await validStagedFile(directory, handle)))
        return fail("package_mismatch", "invalid_handle");
      try {
        return {
          ok: true,
          value: await options.verifyPackage(handle, manifest),
        };
      } catch (error) {
        if (
          error instanceof PackageVerificationError &&
          error.code === "cleanup_unknown"
        )
          return fail("interrupted", "stage_cleanup", "unknown");
        return fail("package_mismatch", "verification");
      }
    },
  };
}
