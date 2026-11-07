import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = fs.readFileSync(
  new URL("./inspect.js", import.meta.url),
  "utf8",
);
function inspect(paths, frontPath, windows) {
  const identity = { name: "TestProduct" };
  const apps = paths.map((path, i) => ({
    bundleURL: { path: { js: path } },
    processIdentifier: i + 100,
  }));
  const context = {
    ObjC: { import() {}, castRefToObject: (x) => x },
    $: {
      NSWorkspace: {
        sharedWorkspace: {
          runningApplications: {
            count: apps.length,
            objectAtIndex: (i) => apps[i],
          },
          frontmostApplication: { bundleURL: { path: { js: frontPath } } },
        },
      },
      CGWindowListCopyWindowInfo: () => windows,
      NSJSONSerialization: { dataWithJSONObjectOptionsError: (x) => x },
      NSString: {
        stringWithContentsOfFileEncodingError: () => ({
          js: JSON.stringify(identity),
        }),
        alloc: { initWithDataEncoding: (x) => ({ js: JSON.stringify(x) }) },
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return JSON.parse(context.run(["unused.json"]));
}
const window = (pid) => ({
  kCGWindowOwnerPID: pid,
  kCGWindowLayer: 0,
  kCGWindowBounds: { Width: 1180, Height: 705 },
});

test("counts nested runtime after the outer launcher exits", () => {
  const runtime =
    "/Applications/TestProduct.app/Contents/Frameworks/Runtime.app";
  assert.deepEqual(inspect([runtime], runtime, [window(100)]), {
    pids: [100],
    windows: 1,
    foreground: true,
  });
});

test("does not count a prefix collision or unrelated application", () => {
  const foreign = "/Applications/TestProduct.app-other/Contents/Runtime.app";
  assert.deepEqual(inspect([foreign], foreign, [window(100)]), {
    pids: [],
    windows: 0,
    foreground: false,
  });
});

test("distinguishes a background process and duplicate normal windows", () => {
  const app = "/Applications/TestProduct.app";
  assert.deepEqual(
    inspect([app], "/Applications/Terminal.app", [window(100), window(100)]),
    {
      pids: [100],
      windows: 2,
      foreground: false,
    },
  );
});

test("one app window can belong to a nested runtime beside its outer launcher", () => {
  const root = "/Applications/TestProduct.app";
  const runtime = root + "/Contents/Frameworks/Runtime.app";
  assert.deepEqual(inspect([root, runtime], runtime, [window(101)]), {
    pids: [100, 101],
    windows: 1,
    foreground: true,
  });
});
