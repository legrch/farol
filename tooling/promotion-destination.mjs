import fs from "node:fs/promises";
import path from "node:path";

const APP_NAME = "Farol Next Preview.app";

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
  try {
    await fs.mkdir(expectedParent, { mode: 0o755 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const [homeInfo, parentInfo, realHome, realParent] = await Promise.all([
    fs.lstat(resolvedHome),
    fs.lstat(expectedParent),
    fs.realpath(resolvedHome),
    fs.realpath(expectedParent),
  ]);
  const effectiveUser = process.geteuid?.();
  if (
    !homeInfo.isDirectory() ||
    homeInfo.isSymbolicLink() ||
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
