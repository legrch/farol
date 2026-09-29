export type ReleaseChannel = "stable" | "owner-beta";

type Version = Readonly<{
  major: bigint;
  minor: bigint;
  patch: bigint;
  prerelease: readonly string[];
}>;

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9A-Za-z-][0-9A-Za-z-]*))*))?$/u;

export function parseReleaseVersion(value: unknown): Version | null {
  if (typeof value !== "string" || value.length > 128) return null;
  const match = SEMVER.exec(value);
  if (!match) return null;
  const prerelease = match[4]?.split(".") ?? [];
  if (
    prerelease.some(
      (part) => /^\d+$/u.test(part) && part.length > 1 && part.startsWith("0"),
    )
  )
    return null;
  return {
    major: BigInt(match[1]!),
    minor: BigInt(match[2]!),
    patch: BigInt(match[3]!),
    prerelease,
  };
}

export function compareReleaseVersions(
  left: string,
  right: string,
): number | null {
  const a = parseReleaseVersion(left);
  const b = parseReleaseVersion(right);
  if (!a || !b) return null;
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return (
      Number(a.prerelease.length === 0) - Number(b.prerelease.length === 0)
    );
  }
  for (
    let i = 0;
    i < Math.max(a.prerelease.length, b.prerelease.length);
    i += 1
  ) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNumeric = /^\d+$/u.test(x);
    const yNumeric = /^\d+$/u.test(y);
    if (xNumeric && yNumeric) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

export function versionBelongsToChannel(
  version: string,
  channel: ReleaseChannel,
): boolean {
  const parsed = parseReleaseVersion(version);
  if (!parsed) return false;
  if (channel === "stable") return parsed.prerelease.length === 0;
  return (
    parsed.prerelease[0] === "owner" &&
    parsed.prerelease[1] === "beta" &&
    parsed.prerelease.length === 3 &&
    /^\d+$/u.test(parsed.prerelease[2]!)
  );
}
