import fs from "node:fs";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { desktopIdentity } from "../../src/apps/desktop/desktop-environment";

const shell = fs.readFileSync(
  new URL("../../src/ui/shell.ts", import.meta.url),
  "utf8",
);
const html = fs.readFileSync(
  new URL("../../src/ui/shell.html", import.meta.url),
  "utf8",
);

// Execute the actual renderer identity boundary and presentation statements.
// This DOM fixture proves source behavior, not Electron or installed app UI.
const identityFields = shell.slice(
  shell.indexOf("const bootstrapSchema = z.strictObject({"),
  shell.indexOf("  build: BuildIdentitySchema,"),
);
const identitySchema = runInNewContext(
  `${identityFields}}); bootstrapSchema;`,
  { z },
);
const applyIdentity = shell.slice(
  shell.indexOf("function applyProductIdentity(): void {"),
  shell.indexOf("const narrowSidebar ="),
);
const applicationRow = shell.match(
  /\[\s*"Application",([\s\S]*?)\n\s*\],/u,
)?.[1];

function present(environment: "preview" | "dev", overrides = {}) {
  const identity = desktopIdentity(
    environment,
    "/private/tmp/fixture-app-data",
  );
  const bootstrap = identitySchema.parse({
    schema: 3,
    productName: "Farol",
    bundleId: "io.github.legrch.farol",
    environment,
    displayName: identity.displayName,
    displayEdition: identity.displayEdition,
    applicationId: identity.applicationId,
    ...overrides,
  });
  const elements = new Map<
    string,
    {
      textContent: string;
      hidden: boolean;
      src: string;
      attributes: Map<string, string>;
      setAttribute(name: string, value: string): void;
    }
  >();
  for (const selector of [
    "#brand-image",
    "#product-brand",
    "#brand-name",
    "#brand-edition",
    "#setup-product-name",
    "#setup-product-edition",
  ]) {
    elements.set(selector, {
      textContent: "",
      hidden: true,
      src: "",
      attributes: new Map(),
      setAttribute(name, value) {
        this.attributes.set(name, value);
      },
    });
  }
  const document = { title: "", documentElement: { dataset: {} } };
  expect(applicationRow).toBeDefined();
  const application = runInNewContext(
    transformSync(
      `let displayProductName = "Farol"; let displayEdition = "";\n${applyIdentity}\napplyProductIdentity();\n[${applicationRow}][0];`,
      { loader: "ts" },
    ).code,
    {
      bootstrap,
      document,
      required: (selector: string) => elements.get(selector),
    },
    { timeout: 1000 },
  );
  return { document, elements, application };
}

describe("desktop display identity in the shell", () => {
  it.each([
    [
      "preview",
      "Farol",
      "",
      "Farol",
      "Farol · io.github.legrch.farol",
      "farol-mark.svg",
    ],
    [
      "dev",
      "Farol Dev",
      "Development",
      "Farol Dev · Development",
      "Farol Dev · Development · local.farol.dev",
      "farol-dev-mark.svg",
    ],
  ] as const)(
    "presents %s without empty separators or badges",
    (environment, name, edition, title, application, mark) => {
      const result = present(environment);
      expect(result.document.title).toBe(title);
      expect(result.application).toBe(application);
      expect(result.elements.get("#brand-image")?.src).toBe(mark);
      expect(
        result.elements.get("#product-brand")?.attributes.get("aria-label"),
      ).toBe(edition ? `${name}, ${edition}` : name);
      for (const selector of ["#brand-name", "#setup-product-name"]) {
        expect(result.elements.get(selector)?.textContent).toBe(name);
      }
      for (const selector of ["#brand-edition", "#setup-product-edition"]) {
        expect(result.elements.get(selector)?.textContent).toBe(edition);
        expect(result.elements.get(selector)?.hidden).toBe(edition === "");
      }
    },
  );

  it.each([
    ["preview", { displayEdition: "Development" }],
    ["dev", { displayEdition: "" }],
    ["preview", { displayName: "Farol Dev" }],
    ["dev", { applicationId: "io.github.legrch.farol" }],
  ] as const)(
    "rejects inconsistent %s display identity",
    (environment, overrides) => {
      expect(() => present(environment, overrides)).toThrow(
        "UI_DESKTOP_IDENTITY_INVALID",
      );
    },
  );

  it.each([
    { displayEdition: "Developer Preview" },
    { displayEdition: "Preview" },
    { productName: "Legacy Product" },
    { bundleId: "local.farol.dev" },
    { unexpected: true },
  ])("rejects invalid bootstrap identity: %j", (overrides) => {
    expect(() => present("preview", overrides)).toThrow();
  });

  it("starts with neutral production branding before bootstrap", () => {
    expect(html).toContain("<title>Farol</title>");
    expect(html).not.toContain("Developer Preview");
    expect(html).toMatch(/id="product-brand"\s+aria-label="Farol"/u);
    for (const id of ["brand-edition", "setup-product-edition"]) {
      expect(html).toMatch(
        new RegExp(`id="${id}"[^>]*\\bhidden\\b[^>]*>\\s*<`, "u"),
      );
    }
  });
});
