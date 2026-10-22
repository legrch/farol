import { desktopIdentity } from "../src/apps/desktop/desktop-environment.ts";

// One import surface for test/launcher identities. Values stay product-owned.
export * from "../src/apps/desktop/desktop-environment.ts";
export * from "../src/apps/desktop/dev-profile-directory.ts";

const product = desktopIdentity("preview", "/");
export const productName = product.displayName;
export const productBundleName = `${product.applicationName}.app`;
export const testUserDataLeaf = `${productName} user-data`;
