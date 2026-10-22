import { productBundleName } from "./harness-identity.ts";
import fs from "node:fs/promises";
import path from "node:path";
import { PRODUCT_APP_NAME } from "./package-layout.mjs";

const APP_NAME = PRODUCT_APP_NAME;

export function trustedOwnerHome(userInfo, effectiveUid) {
  if (
    !userInfo ||
    typeof userInfo.homedir !== "string" ||
    !path.isAbsolute(userInfo.homedir) ||
    !Number.isSafeInteger(userInfo.uid) ||
    !Number.isSafeInteger(effectiveUid) ||
    userInfo.uid !== effectiveUid
  ) {
    throw new Error("PROMOTION_OWNER_IDENTITY_INVALID");
  }
  const home = path.resolve(userInfo.homedir);
  if (home === path.parse(home).root) {
    throw new Error("PROMOTION_OWNER_IDENTITY_INVALID");
  }
  return home;
}

export function assertPromotionDestination({
  home,
  source,
  destination = `/Applications/${productBundleName}`,
}) {
  const resolvedHome = path.resolve(home);
  const resolvedSource = path.resolve(source);
  const resolvedDestination = destination;
  const parent =
    destination === `/Applications/${productBundleName}`
      ? "/Applications"
      : path.join(resolvedHome, "Applications");
  if (
    !path.isAbsolute(resolvedDestination) ||
    path.normalize(resolvedDestination) !== resolvedDestination ||
    path.basename(resolvedDestination) !== APP_NAME ||
    path.dirname(resolvedDestination) !== parent
  ) {
    throw new Error("PROMOTION_DESTINATION_OUTSIDE_OWNER_APPLICATIONS");
  }
  if (resolvedSource === resolvedDestination) {
    throw new Error("PROMOTION_DESTINATION_IS_SOURCE");
  }
  return {
    destination: resolvedDestination,
    parent,
    receipt: `${resolvedDestination}.receipt.json`,
  };
}

export async function preparePromotionParent(home, parent) {
  const resolvedHome = path.resolve(home);
  if (parent === "/Applications") {
    const before = await fs.lstat(parent);
    assertSharedApplicationsParent(before, await fs.realpath(parent));
    const after = await fs.lstat(parent);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mode !== after.mode ||
      before.uid !== after.uid ||
      before.gid !== after.gid
    )
      throw new Error("PROMOTION_PARENT_TYPE_INVALID");
    return parent;
  }
  const expectedParent = path.join(resolvedHome, "Applications");
  if (path.resolve(parent) !== expectedParent) {
    throw new Error("PROMOTION_PARENT_OUTSIDE_OWNER_APPLICATIONS");
  }
  let homeInfo;
  let realHome;
  try {
    [homeInfo, realHome] = await Promise.all([
      fs.lstat(resolvedHome),
      fs.realpath(resolvedHome),
    ]);
  } catch {
    throw new Error("PROMOTION_HOME_TYPE_INVALID");
  }
  const effectiveUser = process.geteuid?.();
  if (
    !homeInfo.isDirectory() ||
    homeInfo.isSymbolicLink() ||
    (effectiveUser !== undefined && homeInfo.uid !== effectiveUser) ||
    (homeInfo.mode & 0o022) !== 0
  ) {
    throw new Error("PROMOTION_HOME_TYPE_INVALID");
  }
  const realHomeInfo = await fs.lstat(realHome);
  if (
    realHomeInfo.dev !== homeInfo.dev ||
    realHomeInfo.ino !== homeInfo.ino ||
    !realHomeInfo.isDirectory() ||
    realHomeInfo.isSymbolicLink()
  ) {
    throw new Error("PROMOTION_HOME_TYPE_INVALID");
  }
  const realExpectedParent = path.join(realHome, "Applications");
  try {
    await fs.mkdir(realExpectedParent, { mode: 0o755 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const [currentHomeInfo, parentInfo, currentRealHome, realParent] =
    await Promise.all([
      fs.lstat(resolvedHome),
      fs.lstat(realExpectedParent),
      fs.realpath(resolvedHome),
      fs.realpath(realExpectedParent),
    ]);
  if (
    currentHomeInfo.dev !== homeInfo.dev ||
    currentHomeInfo.ino !== homeInfo.ino ||
    currentRealHome !== realHome
  ) {
    throw new Error("PROMOTION_HOME_TYPE_INVALID");
  }
  if (
    !parentInfo.isDirectory() ||
    parentInfo.isSymbolicLink() ||
    (effectiveUser !== undefined && parentInfo.uid !== effectiveUser) ||
    (parentInfo.mode & 0o022) !== 0 ||
    path.dirname(realParent) !== realHome ||
    path.basename(realParent) !== "Applications"
  ) {
    throw new Error("PROMOTION_PARENT_TYPE_INVALID");
  }
  return realParent;
}

// macOS's standard administrator group has the stable numeric ID 80.
// This exception applies only to the canonical shared parent, never owned files.
export function assertSharedApplicationsParent(info, realParent) {
  if (
    realParent !== "/Applications" ||
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== 0 ||
    (info.mode & 0o002) !== 0 ||
    ((info.mode & 0o020) !== 0 && info.gid !== 80)
  )
    throw new Error("PROMOTION_PARENT_TYPE_INVALID");
}
