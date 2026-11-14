// Where a JavaScript/TypeScript test may live (ADR-0002, decision 7). Suites
// live under `tests/`; a co-located test sits beside its subject under a source
// root as `name.test.ts(x)` next to `name.ts(x)`. Scope discovery, the scope
// planner and the build input guard read this one rule; the two Vitest configs
// state the same globs and tests/unit/test-scope-plan.test.mjs keeps them equal.

/** Source roots that may hold co-located tests. */
export const colocatedRoots = Object.freeze(["src", "apps/desktop"]);

/** Co-located tests here need a DOM and run with vitest.renderer.config.ts. */
export const rendererRoots = Object.freeze([
  "src/ui/renderer",
  "apps/desktop/renderer",
]);

// Any test-named JavaScript/TypeScript file, as tooling/check-architecture.mjs
// names it. Only `.test.ts` and `.test.tsx` are admitted beside source.
const testName = /\.test\.[cm]?[jt]sx?$/u;
const colocatedName = /\.test\.tsx?$/u;

const under = (file, roots) =>
  roots.some((root) => file.startsWith(root + "/"));

/** A repository-relative POSIX path names a test file. */
export function isTestSource(file) {
  return testName.test(file);
}

/** A test-named file under a co-located root, admitted or not. */
export function isColocatedTestCandidate(file) {
  return under(file, colocatedRoots) && isTestSource(file);
}

/** An admitted co-located test: `.test.ts` or `.test.tsx` under a source root. */
export function isColocatedTest(file) {
  return under(file, colocatedRoots) && colocatedName.test(file);
}

/** A co-located test that runs with the renderer (DOM) configuration. */
export function isColocatedRendererTest(file) {
  return isColocatedTest(file) && under(file, rendererRoots);
}

/** Build inputs are production source: a test file never enters a bundle. */
export function assertNotTestInput(file) {
  if (!file.startsWith("node_modules/") && isTestSource(file))
    throw new Error(`BUILD_INPUT_TEST_SOURCE:${file}`);
}
