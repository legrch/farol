import {
  GITHUB_RELEASES_API,
  GITHUB_RELEASE_REPOSITORY,
} from "../../domain/github-release-contract";

const CDN_HOST = "release-assets.githubusercontent.com";

export function httpsUrl(value: string): URL | null {
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

export function initialKind(value: string): "api" | "asset" | null {
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

export function cdnUrl(value: string): boolean {
  const url = httpsUrl(value);
  return url !== null && url.hostname === CDN_HOST && url.pathname.length > 1;
}

export function validLimit(value: number, ceiling: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= ceiling;
}

export function redirected(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}
