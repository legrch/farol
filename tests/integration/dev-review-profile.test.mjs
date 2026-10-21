import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFreshReviewProfile,
  createOwnerFreshReviewProfile,
} from "../../tooling/dev.mjs";
import {
  desktopAppDataPath,
  desktopIdentity,
  desktopEnvironment,
  desktopProfileEnvironment,
} from "../../src/apps/desktop/desktop-environment";

// Disposable filesystem fixtures only. Never resolves the real owner appData,
// launches Electron, builds Go, reads host credentials, or makes provider calls.
const fixtures = [];
afterEach(() => {
  for (const root of fixtures.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
// Synthetic profile UUID, deliberately recognizable as test data.
const token = "00000000-0000-4000-8000-000000000001";
const receiptName = ".farol-dev-review-profile";
function fixture() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "farol-dev-review-fixture-")),
  );
  fixtures.push(root);
  fs.chmodSync(root, 0o700);
  return root;
}
function admit(root, marker) {
  return desktopAppDataPath("dev", root, {
    enabled: false,
    override: undefined,
    acceptanceProfile: marker,
  });
}

describe("fresh disposable review profile producer/consumer", () => {
  it("rejects an overridden HOME before creating anything in either disposable home", () => {
    const systemHome = fixture();
    const overriddenHome = fixture();
    expect(() =>
      createOwnerFreshReviewProfile(
        { HOME: overriddenHome },
        () => systemHome,
        "darwin",
      ),
    ).toThrow("DEV_REVIEW_PROFILE_HOME_INVALID");
    expect(fs.readdirSync(overriddenHome)).toEqual([]);
    expect(fs.readdirSync(systemHome)).toEqual([]);
  });
  it("uses only the independently resolved owner home without changing it", () => {
    const systemHome = fixture();
    const appData = path.join(systemHome, "Library", "Application Support");
    fs.mkdirSync(appData, { recursive: true, mode: 0o700 });
    const environment = { HOME: systemHome };
    const review = createOwnerFreshReviewProfile(
      environment,
      () => systemHome,
      "darwin",
    );
    expect(path.dirname(path.dirname(review.appData))).toBe(appData);
    expect(environment).toEqual({ HOME: systemHome });
    expect(admit(appData, review.marker)).toBe(review.appData);
  });
  it("rejects unsupported platforms before a home resolver or filesystem call", () => {
    expect(() =>
      createOwnerFreshReviewProfile(
        {},
        () => {
          throw new Error("MUST_NOT_RESOLVE");
        },
        "linux",
      ),
    ).toThrow("DEV_REVIEW_PROFILE_PLATFORM_INVALID");
  });

  it("admits the existing main.ts call shape with real HOME retained and no E2E marker", () => {
    const root = fixture();
    const review = createFreshReviewProfile(root, token);
    const source = fs.readFileSync(
      new URL("../../src/apps/desktop/main.ts", import.meta.url),
      "utf8",
    );
    const begin = source.indexOf("const buildEnvironment =");
    const end = source.indexOf("const declaredDesktopIdentity =", begin);
    expect(begin).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(begin);
    const env = {
      HOME: "/Users/fixture-owner",
      FAROL_ENVIRONMENT: "dev",
      FAROL_ACCEPTANCE_PROFILE: review.marker,
    };
    const selected = runInNewContext(
      transformSync(`${source.slice(begin, end)}\ndesktopAppData;`, {
        loader: "ts",
      }).code,
      {
        process: { env },
        desktopEnvironment,
        desktopProfileEnvironment,
        desktopAppDataPath,
        app: {
          getPath: (name) => {
            expect(name).toBe("appData");
            return root;
          },
        },
        terminateDesktopStartup: (error) => {
          throw error;
        },
      },
      { timeout: 1000 },
    );
    expect(selected).toBe(review.appData);
    expect(env.HOME).toBe("/Users/fixture-owner");
  });

  it("mints an isolated identity, admits it once, and retains it without touching neighboring owner-shaped fixtures", () => {
    const root = fixture();
    for (const name of [
      "Farol Dev",
      "Farol DEV",
      "Farol Dev Acceptance",
      "Farol",
    ]) {
      // Case-insensitive filesystems collapse the first two fixture names.
      fs.mkdirSync(path.join(root, name), { recursive: true });
      fs.writeFileSync(path.join(root, name, "sentinel"), "untouched");
    }
    const review = createFreshReviewProfile(root, token);
    expect(review.appData).toBe(path.join(root, "Farol Dev Review", token));
    expect(admit(root, review.marker)).toBe(review.appData);
    expect(desktopIdentity("dev", review.appData).userData).toBe(
      review.userData,
    );
    expect(() => admit(root, review.marker)).toThrow(
      "DESKTOP_REVIEW_PROFILE_INVALID",
    );
    expect(
      fs.readFileSync(path.join(review.appData, receiptName), "utf8"),
    ).toBe(token);
    expect(
      fs.existsSync(path.join(review.appData, ".farol-dev-review-opened")),
    ).toBe(true);
    for (const name of [
      "Farol Dev",
      "Farol DEV",
      "Farol Dev Acceptance",
      "Farol",
    ]) {
      expect(fs.readFileSync(path.join(root, name, "sentinel"), "utf8")).toBe(
        "untouched",
      );
    }
  });
  it("generates distinct review leaves while retaining prior identities", () => {
    const root = fixture();
    const first = createFreshReviewProfile(root);
    const second = createFreshReviewProfile(root);
    expect(first.marker).not.toBe(second.marker);
    expect(fs.existsSync(first.appData)).toBe(true);
    expect(admit(root, second.marker)).toBe(second.appData);
  });
  it("refuses an existing leaf without overwriting or deleting it", () => {
    const root = fixture();
    const review = createFreshReviewProfile(root, token);
    expect(() => createFreshReviewProfile(root, token)).toThrow(
      `review:${token}; appData: ${review.appData}`,
    );
    expect(
      fs.readFileSync(path.join(review.appData, receiptName), "utf8"),
    ).toBe(token);
  });
  it("refuses appData writable by another user before creating a namespace", () => {
    const root = fixture();
    fs.chmodSync(root, 0o777);
    expect(() => createFreshReviewProfile(root, token)).toThrow(
      "DEV_REVIEW_PROFILE_ROOT_UNSAFE",
    );
    expect(fs.readdirSync(root)).toEqual([]);
  });
  it("refuses an unsafe namespace without repairing it", () => {
    const root = fixture();
    const namespace = path.join(root, "Farol Dev Review");
    fs.mkdirSync(namespace, { mode: 0o755 });
    fs.chmodSync(namespace, 0o755);
    expect(() => createFreshReviewProfile(root, token)).toThrow(
      "DEV_REVIEW_PROFILE_ROOT_UNSAFE",
    );
    expect(fs.readdirSync(namespace)).toEqual([]);
    expect(fs.statSync(namespace).mode & 0o777).toBe(0o755);
  });
  it("refuses a symlink namespace and does not access its target contents", () => {
    const root = fixture();
    const target = fixture();
    fs.symlinkSync(target, path.join(root, "Farol Dev Review"));
    expect(() => createFreshReviewProfile(root, token)).toThrow(
      "DEV_REVIEW_PROFILE_ROOT_UNSAFE",
    );
    expect(fs.readdirSync(target)).toEqual([]);
  });
  it.each(["", "../owner", "00000000-0000-0000-0000-000000000000"])(
    "refuses a caller-selected invalid token %s",
    (token) => {
      const root = fixture();
      expect(() => createFreshReviewProfile(root, token)).toThrow(
        "DEV_REVIEW_PROFILE_INVALID",
      );
      expect(fs.readdirSync(root)).toEqual([]);
    },
  );
  it("refuses missing profiles rather than falling back to ordinary Dev", () => {
    const root = fixture();
    expect(() => admit(root, `review:${token}`)).toThrow(
      "DESKTOP_REVIEW_PROFILE_INVALID",
    );
    expect(fs.readdirSync(root)).toEqual([]);
  });
  it.each([
    "parent-permissions",
    "leaf-permissions",
    "receipt-permissions",
    "receipt-mismatch",
    "receipt-symlink",
    "receipt-hardlink",
    "preexisting-state",
    "leaf-symlink",
  ])("rejects mutated profile admission: %s", (mutation) => {
    const root = fixture();
    const review = createFreshReviewProfile(root, token);
    const receipt = path.join(review.appData, receiptName);
    if (mutation === "parent-permissions") fs.chmodSync(root, 0o777);
    if (mutation === "leaf-permissions") fs.chmodSync(review.appData, 0o755);
    if (mutation === "receipt-permissions") fs.chmodSync(receipt, 0o644);
    if (mutation === "receipt-mismatch")
      fs.writeFileSync(receipt, "b".repeat(token.length));
    if (mutation === "receipt-symlink") {
      fs.unlinkSync(receipt);
      fs.symlinkSync(path.join(root, "missing"), receipt);
    }
    if (mutation === "receipt-hardlink")
      fs.linkSync(receipt, path.join(root, "linked-receipt"));
    if (mutation === "preexisting-state")
      fs.mkdirSync(path.join(review.appData, "Farol Dev"));
    if (mutation === "leaf-symlink") {
      const target = fixture();
      fs.rmSync(review.appData, { recursive: true });
      fs.symlinkSync(target, review.appData);
    }
    expect(() => admit(root, review.marker)).toThrow(
      "DESKTOP_REVIEW_PROFILE_INVALID",
    );
    expect(
      fs.existsSync(path.join(review.appData, ".farol-dev-review-opened")),
    ).toBe(false);
  });
});
