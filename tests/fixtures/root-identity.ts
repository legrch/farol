import { lstatSync } from "node:fs";

// The identity a real folder has now, as the owner's verification would record
// it. A path that does not exist gets an identity no folder has, so a request
// built for it is refused by the identity check rather than by accident.
export function approvedRootOf(
  root: string,
): Readonly<{ path: string; device: string; inode: string }> {
  try {
    const measured = lstatSync(root, { bigint: true });
    return {
      path: root,
      device: String(measured.dev),
      inode: String(measured.ino),
    };
  } catch {
    return { path: root, device: "0", inode: "0" };
  }
}

export function rootIdentityOf(
  root: string,
): Readonly<{ device: string; inode: string }> {
  const { device, inode } = approvedRootOf(root);
  return { device, inode };
}

// For tests whose workspace ports are fakes: the identity only satisfies the
// approval shape and proves nothing about a real folder.
export const SYNTHETIC_ROOT_IDENTITY = Object.freeze({
  device: "1",
  inode: "2",
});
