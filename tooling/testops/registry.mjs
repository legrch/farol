// Read-only adapter over the existing source-scope registry. No test execution.
import fs from "node:fs";
import { discoverTests } from "../test-scopes.mjs";
import { classifyTests, planTests, scopes } from "../test-scope-plan.mjs";
import {
  cloudDeferredFiles,
  cloudMixedFiles,
} from "../cloud-test-prerequisites.mjs";

const files = discoverTests();
const classified = classifyTests(files);
const standalone = fs
  .readdirSync("tests/e2e")
  .filter((p) => p.endsWith(".e2e.mjs"))
  .sort();
process.stdout.write(
  JSON.stringify(
    {
      schema: 1,
      kind: "source-registration-inventory",
      acceptance: false,
      classified,
      plans: Object.fromEntries(
        scopes.map((scope) => [scope, planTests(scope, files)]),
      ),
      cloudDeferredFiles,
      cloudMixedFiles,
      standalone: standalone.map((p) => "tests/e2e/" + p),
    },
    null,
    2,
  ) + "\n",
);
