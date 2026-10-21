// New packages use Farol; schema 5 retains its explicit legacy app name.
// Only these explicit package generations are accepted, never an arbitrary
// basename supplied by a release manifest or workspace.
export const PRODUCT_APP_NAME = "Farol.app";
export const LEGACY_APP_NAME = "Farol Next Preview.app";
export const PACKAGE_SCHEMA = 6;
export const GO_PACKAGE_SCHEMA = 7;

export function packageLayout(schema) {
  if (schema === GO_PACKAGE_SCHEMA)
    return Object.freeze({
      appName: PRODUCT_APP_NAME,
      displayName: "Farol",
      branded: true,
      core: true,
    });
  if (schema === 5)
    return Object.freeze({
      appName: LEGACY_APP_NAME,
      displayName: LEGACY_APP_NAME.slice(0, -4),
      branded: false,
    });
  if (schema === PACKAGE_SCHEMA)
    return Object.freeze({
      appName: PRODUCT_APP_NAME,
      displayName: "Farol",
      branded: true,
    });
  throw new Error("PACKAGE_MANIFEST_SCHEMA_INVALID");
}
