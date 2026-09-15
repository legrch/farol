import fs from "node:fs/promises";
import path from "node:path";

const APP_NAME = "Farol Next Preview.app";

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

export function assertPromotionDestination({ home, source, destination }) {
  const resolvedHome = path.resolve(home);
  const resolvedSource = path.resolve(source);
  const resolvedDestination = path.resolve(destination);
  const parent = path.join(resolvedHome, "Applications");
  if (
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
