import fs from "node:fs/promises";
import { z } from "zod";
import {
  findGithubReleaseManifest,
  parseGithubReleaseManifest,
} from "../../modules/release/app/github-release";
import type { ReleaseManifest } from "../../modules/release/domain/github-release-contract";
import type { BuildIdentity } from "../../pkg/build-info/identity";

// First-launch adoption of a copy that was dragged into a slot rather than
// installed by the owner tool. The pure pieces live here so the ordinary
// desktop runtime (user slot, at the first update check) and the pre-ready
// startup observer (shared slot, at launch) apply the same record, the same
// build-to-manifest comparison and the same refusal codes.
//
// The record holds what the published release manifest said about this exact
// build, once. It is honestly trust on first use: it detects a corrupt or
// partial copy, the wrong version and later drift, not a deliberately tampered
// download. It is never a PromotionReceipt.

export const SHARED_SLOT = "/Applications/Farol.app";
export const ADOPTED_BASELINE_FILE = "adopted-baseline.json";

export const AdoptedBaseline = z.strictObject({
  schema: z.literal("farol.next.adopted-baseline/1"),
  slot: z.string().max(4096),
  userData: z.string().max(4096),
  manifest: z.unknown(),
  adoptedAt: z.string().max(64),
});

export type AdoptedExpectation = Readonly<{
  digest: string;
  version: string;
  buildId: string;
}>;
export type AdoptionChannel = "stable" | "owner-beta";
export type AdoptionOutcome<T> =
  Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; code: string }>;

export function adoptionChannel(
  build: Pick<BuildIdentity, "updateChannel">,
): AdoptionChannel {
  return build.updateChannel === "github-stable" ? "stable" : "owner-beta";
}

/** A dirty, unversioned or non-GitHub build can never be adopted. */
export function adoptionBuildEligible(
  build: Pick<BuildIdentity, "sourceDirty" | "buildVersion" | "updateChannel">,
): boolean {
  return (
    !build.sourceDirty &&
    !!build.buildVersion &&
    ["github-stable", "github-owner-beta"].includes(build.updateChannel)
  );
}

/** The published manifest must describe exactly the running build. */
export function manifestDescribesRunningBuild(
  manifest: ReleaseManifest,
  build: BuildIdentity,
): boolean {
  return (
    manifest.buildId === build.buildId &&
    manifest.sourceCommit === build.sourceCommit &&
    manifest.sourceTreeDigest === build.sourceTreeDigest &&
    manifest.version === build.version &&
    manifest.buildVersion === build.buildVersion &&
    manifest.channel === adoptionChannel(build)
  );
}

// True only when lstat proves the name does not exist (ENOENT). Any other
// outcome, including an existing file whose JSON content is null, is presence.
export async function recordAbsent(file: string): Promise<boolean> {
  try {
    await fs.lstat(file);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

export type AdoptedRecordState =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "expected"; expected: AdoptedExpectation }>
  // Valid for this slot and profile but describing another published build,
  // for example a newer release dragged over the old copy. The digest is that
  // of the exact bytes, so only an unchanged record may be replaced.
  | Readonly<{ kind: "superseded"; digest: string | null }>;

type RecordReader = (
  file: string,
  privateMode: boolean,
  observeDigest: (digest: string) => void,
) => Promise<unknown | null>;

/**
 * Read and classify the adopted record. Absence needs real absence: a present
 * file holding JSON null, a record that does not parse, one with an invalid
 * manifest or one that names another slot or profile is tampered or foreign,
 * and throws UPDATE_ACCEPTED_SOURCE_UNCONFIRMED. It is never adopted over.
 */
export async function readAdoptedRecord(input: {
  file: string;
  slot: string;
  userData: string;
  build: BuildIdentity;
  read: RecordReader;
  absent: (file: string) => Promise<boolean>;
}): Promise<AdoptedRecordState> {
  const unconfirmed = () => new Error("UPDATE_ACCEPTED_SOURCE_UNCONFIRMED");
  let digest: string | undefined;
  let raw: unknown | null;
  try {
    raw = await input.read(input.file, true, (value) => {
      digest = value;
    });
  } catch {
    // Real absence is null, not an error. A present record that cannot be read
    // or decoded (malformed JSON, wrong type, unsafe file) is tampered.
    throw unconfirmed();
  }
  if (raw === null) {
    if (await input.absent(input.file)) return { kind: "absent" };
    throw unconfirmed();
  }
  const record = AdoptedBaseline.safeParse(raw);
  if (!record.success) throw unconfirmed();
  const parsed = parseGithubReleaseManifest(record.data.manifest);
  if (
    !parsed.ok ||
    record.data.slot !== input.slot ||
    record.data.userData !== input.userData
  )
    throw unconfirmed();
  if (!manifestDescribesRunningBuild(parsed.value, input.build))
    return { kind: "superseded", digest: digest ?? null };
  return {
    kind: "expected",
    expected: {
      digest: parsed.value.artifactSha256,
      version: parsed.value.version,
      buildId: input.build.buildId,
    },
  };
}

/**
 * Ask the published releases which manifest describes the running build. The
 * failure codes are the closed vocabulary shown to the user and the updater.
 */
export async function resolveAdoptionManifest(input: {
  build: BuildIdentity;
  fetchJson: Parameters<typeof findGithubReleaseManifest>[2]["fetchJson"];
}): Promise<AdoptionOutcome<ReleaseManifest>> {
  let found;
  try {
    found = await findGithubReleaseManifest(
      {
        version: input.build.version,
        buildVersion: input.build.buildVersion!,
      },
      adoptionChannel(input.build),
      { fetchJson: input.fetchJson },
    );
  } catch {
    return { ok: false, code: "UPDATE_ADOPTION_NETWORK_FAILURE" };
  }
  if (!found.ok)
    return { ok: false, code: `UPDATE_ADOPTION_${found.code.toUpperCase()}` };
  if (!manifestDescribesRunningBuild(found.value, input.build))
    return { ok: false, code: "UPDATE_ADOPTION_RELEASE_MISMATCH" };
  return { ok: true, value: found.value };
}

export function adoptedRecordFor(input: {
  slot: string;
  userData: string;
  manifest: ReleaseManifest;
}): z.infer<typeof AdoptedBaseline> {
  return {
    schema: "farol.next.adopted-baseline/1",
    slot: input.slot,
    userData: input.userData,
    manifest: input.manifest,
    adoptedAt: new Date().toISOString(),
  };
}

/**
 * Publish the record with one atomic rename. When it replaces a superseded
 * record, only that exact unchanged record is replaced: a changed or vanished
 * file belongs to another writer and is left for the caller to validate.
 * Returns whether this call published.
 */
export async function publishAdoptedRecord(input: {
  file: string;
  record: z.infer<typeof AdoptedBaseline>;
  replacing: string | null;
  read: RecordReader;
  write: (file: string, value: unknown) => Promise<void>;
}): Promise<boolean> {
  if (input.replacing !== null) {
    let current: string | undefined;
    const existing = await input.read(input.file, true, (value) => {
      current = value;
    });
    if (existing === null || current !== input.replacing) return false;
  }
  // A concurrent writer can only publish an equally validated record for this
  // running build and slot, so the last writer wins safely.
  await input.write(input.file, input.record);
  return true;
}
