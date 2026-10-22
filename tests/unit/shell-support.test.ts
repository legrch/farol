import { describe, expect, it, vi } from "vitest";
import {
  bindShellSupportDeclaration,
  parseShellSupportDeclaration,
  type ShellSupportDeclaration,
} from "../../apps/desktop/bridge/shell-support.ts";

// Synthetic value fixtures only. No filesystem, native processes, qualification
// issuer, runtime/provider, package, or Shell activation is exercised.
function fixture(): ShellSupportDeclaration {
  return {
    schema: "farol-shell-support/1",
    core: {
      schema: "farol-core-artifact/1",
      build: {
        buildId: "release:accepted/1",
        sourceSHA: "a".repeat(40),
        sourceTreeDigest: "b".repeat(64),
        platform: { goos: "darwin", goarch: "arm64" },
      },
      binary: { path: "farol-backend", size: 64, sha256: "c".repeat(64) },
    },
    qualification: {
      releaseId: "shell:accepted-1",
      sha256: "d".repeat(64),
      osBuild: "25A123",
      compilerSHA256: "e".repeat(64),
      compiler: "approved-roots-seatbelt-v1",
      filesystemClass: "local-apfs-no-nested-mounts-v1",
      hostTrust: "protected-host-pathnames-v1",
      network: "none",
    },
    mechanism: { path: "/usr/bin/sandbox-exec", sha256: "f".repeat(64) },
    imports: [
      { path: "/usr/share/sandbox/dyld-support.sb", sha256: "1".repeat(64) },
      {
        path: "/System/Library/Sandbox/Profiles/system.sb",
        sha256: "2".repeat(64),
      },
    ],
    executables: [
      { path: "/bin/bash", sha256: "3".repeat(64) },
      { path: "/usr/bin/git", sha256: "4".repeat(64) },
    ],
    watchdog: {
      relativePath:
        "Contents/Frameworks/Electron Runtime.app/Contents/MacOS/Electron",
      sha256: "5".repeat(64),
      sourceSHA256: "6".repeat(64),
    },
    runtime: {
      version: "44.4.2",
      treeDigestVersion: "farol.tree-digest/v2",
      treeSHA256: "7".repeat(64),
      distributionSHA256: "8".repeat(64),
    },
  };
}
function at(value: unknown, path: string): Record<string, unknown> {
  let current = value;
  for (const key of path.split(".").filter(Boolean))
    current = (current as Record<string, unknown>)[key];
  return current as Record<string, unknown>;
}
function changed(path: string, value: unknown): ShellSupportDeclaration {
  const result = fixture();
  const parts = path.split(".");
  const key = parts.pop();
  if (key === undefined) throw new Error("invalid test path");
  at(result, parts.join("."))[key] = value;
  return result;
}
function invalid(value: unknown): void {
  expect(() => parseShellSupportDeclaration(value)).toThrow(
    "invalid_shell_support_declaration",
  );
}
const records = [
  "",
  "core",
  "core.build",
  "core.build.platform",
  "core.binary",
  "qualification",
  "mechanism",
  "imports.0",
  "imports.1",
  "executables.0",
  "executables.1",
  "watchdog",
  "runtime",
];
const leaves = records.flatMap((path) =>
  Object.entries(at(fixture(), path))
    .filter(([, value]) => typeof value !== "object")
    .map(([key]) => [path, key] as const),
);
const digestPaths = [
  "core.build.sourceTreeDigest",
  "core.binary.sha256",
  "qualification.sha256",
  "qualification.compilerSHA256",
  "mechanism.sha256",
  "imports.0.sha256",
  "imports.1.sha256",
  "executables.0.sha256",
  "executables.1.sha256",
  "watchdog.sha256",
  "watchdog.sourceSHA256",
  "runtime.treeSHA256",
  "runtime.distributionSHA256",
];

describe("strict Shell support value parsing", () => {
  it("accepts the qualified kernel mount class but does not substitute it for legacy support", () => {
    const next = changed(
      "qualification.filesystemClass",
      "system-apfs-kernel-mount-boundaries-v1",
    );
    expect(parseShellSupportDeclaration(next)).toEqual(next);
    expect(() =>
      bindShellSupportDeclaration(next, fixture(), fixture().core),
    ).toThrow();
    invalid(changed("qualification.filesystemClass", "any-local-filesystem"));
  });

  it("copies and deeply freezes every record and array", () => {
    const input = fixture();
    const parsed = parseShellSupportDeclaration(input);
    expect(parsed).toEqual(input);
    for (const path of [...records, "imports", "executables"]) {
      expect(at(parsed, path)).not.toBe(at(input, path));
      expect(Object.isFrozen(at(parsed, path))).toBe(true);
    }
    at(input, "core.binary").size = 100;
    at(input, "imports.0").sha256 = "9".repeat(64);
    at(input, "runtime").version = "45.0.0";
    expect(parsed).toEqual(fixture());
    expect(() => {
      at(parsed, "qualification").osBuild = "25A124";
    }).toThrow();
    expect(() => {
      at(parsed, "imports")["0"] = {};
    }).toThrow();
  });
  it("accepts own data records with null prototypes and arbitrary key order", () => {
    const input = fixture();
    for (const path of records) Object.setPrototypeOf(at(input, path), null);
    const reordered = Object.fromEntries(Object.entries(input).reverse());
    expect(
      bindShellSupportDeclaration(reordered, fixture(), fixture().core),
    ).toEqual(fixture());
  });
  it.each([undefined, null, false, 1, "{}", [], {}, new Date()])(
    "rejects non-declarations %#",
    invalid,
  );
  it.each(records)(
    "rejects unknown/symbol/hidden/prototype fields at %s",
    (path) => {
      for (const key of [
        "unexpected",
        Symbol("unexpected"),
        "__proto__",
        "constructor",
        "toJSON",
      ]) {
        const input = fixture();
        Object.defineProperty(at(input, path), key, {
          value: "extra",
          enumerable: true,
        });
        invalid(input);
      }
      const hidden = fixture();
      Object.defineProperty(at(hidden, path), "hidden", { value: 1 });
      invalid(hidden);
      const inherited = fixture();
      Object.setPrototypeOf(at(inherited, path), { extra: 1 });
      invalid(inherited);
    },
  );
  it.each(leaves)(
    "rejects missing, hidden, accessor and malformed %s.%s without getter execution",
    (path, key) => {
      const missing = fixture();
      delete at(missing, path)[key];
      invalid(missing);
      const hidden = fixture();
      Object.defineProperty(at(hidden, path), key, { enumerable: false });
      invalid(hidden);
      const input = fixture();
      const get = vi.fn(() => {
        throw new Error("getter must not run");
      });
      Object.defineProperty(at(input, path), key, { get, enumerable: true });
      invalid(input);
      expect(get).not.toHaveBeenCalled();
      for (const value of [undefined, null, {}, []])
        invalid(changed([path, key].filter(Boolean).join("."), value));
    },
  );
  it.each(records.filter(Boolean))(
    "rejects accessor and primitive record boundary %s",
    (path) => {
      const parts = path.split(".");
      const key = parts.pop()!;
      const input = fixture();
      const get = vi.fn();
      Object.defineProperty(at(input, parts.join(".")), key, {
        get,
        enumerable: true,
      });
      invalid(input);
      expect(get).not.toHaveBeenCalled();
      for (const value of [
        null,
        false,
        "record",
        [],
        Object.create({}) as unknown,
      ])
        invalid(changed(path, value));
    },
  );
  it("bounds cyclic and reflection-failure refusals", () => {
    const cyclic = fixture();
    at(cyclic, "").core = cyclic;
    invalid(cyclic);
    const pinCycle = fixture();
    at(pinCycle, "imports.0").path = pinCycle;
    invalid(pinCycle);
    invalid(
      new Proxy(fixture(), {
        ownKeys() {
          throw new Error("private exception");
        },
      }),
    );
    const revoked = Proxy.revocable(fixture(), {});
    revoked.revoke();
    invalid(revoked.proxy);
  });
  it.each(["imports", "executables"])(
    "rejects missing/accessor array boundary %s without invoking getters",
    (path) => {
      const input = fixture();
      delete at(input, "")[path];
      invalid(input);
      const get = vi.fn();
      Object.defineProperty(input, path, { get, enumerable: true });
      invalid(input);
      expect(get).not.toHaveBeenCalled();
    },
  );
  it.each(digestPaths)("rejects malformed or zero SHA-256 at %s", (path) => {
    for (const value of [
      "0".repeat(64),
      "A".repeat(64),
      "g".repeat(64),
      "a".repeat(63),
      "a".repeat(65),
      "a".repeat(64) + "\n",
    ])
      invalid(changed(path, value));
  });
  it.each([
    ["schema", "farol-shell-support/2"],
    ["core.schema", "farol-core-artifact/2"],
    ["core.build.platform.goos", "linux"],
    ["core.build.platform.goarch", "amd64"],
    ["core.binary.path", "bin/farol-backend"],
    ["core.binary.path", "farol-backend\n"],
    ["core.binary.size", 63],
    ["core.binary.size", 128 * 1024 * 1024 + 1],
    ["core.binary.size", 64.5],
    ["core.binary.size", NaN],
    ["core.binary.size", Infinity],
    ["core.build.sourceSHA", "0".repeat(40)],
    ["core.build.sourceSHA", "a".repeat(40) + "\n"],
    ["qualification.compiler", "other"],
    ["qualification.filesystemClass", "other"],
    ["qualification.hostTrust", "other"],
    ["qualification.network", "approved"],
    ["mechanism.path", "/bin/sandbox-exec"],
    ["watchdog.relativePath", "/" + fixture().watchdog.relativePath],
    ["runtime.treeDigestVersion", "farol.tree-digest/v1"],
  ])("rejects fixed class/range crossing %s %#", (path, value) =>
    invalid(changed(path as string, value)),
  );
  it("accepts inclusive binary size endpoints", () => {
    for (const size of [64, 128 * 1024 * 1024])
      expect(
        parseShellSupportDeclaration(changed("core.binary.size", size)).core
          .binary.size,
      ).toBe(size);
  });
  it.each([
    ["core.build.buildId", 128],
    ["qualification.releaseId", 160],
  ] as const)("enforces existing bounded ID syntax at %s", (path, maximum) => {
    for (const value of [
      "",
      "a".repeat(maximum + 1),
      "bad space",
      "id\n",
      "id\0",
      "é",
    ])
      invalid(changed(path, value));
    expect(
      parseShellSupportDeclaration(changed(path, "a".repeat(maximum))),
    ).toBeDefined();
  });
  it("keeps the Go release ID grammar distinct from the core build ID", () => {
    invalid(changed("qualification.releaseId", "shell:accepted/1"));
    expect(
      parseShellSupportDeclaration(
        changed("core.build.buildId", "release:accepted/1"),
      ).core.build.buildId,
    ).toBe("release:accepted/1");
  });
  it("matches exact Darwin build grammar including optional suffix", () => {
    for (const value of ["1A1", "123Z123456a"])
      expect(
        parseShellSupportDeclaration(changed("qualification.osBuild", value))
          .qualification.osBuild,
      ).toBe(value);
    for (const value of [
      "25*",
      "25a123",
      "1234A1",
      "25A1234567",
      "25A1AA",
      "25A1a\n",
      "25A1 ",
    ])
      invalid(changed("qualification.osBuild", value));
  });
  it("accepts canonical semver including prerelease/build and rejects aliases", () => {
    for (const value of [
      "0.0.0",
      "44.4.2-beta.1+build.01",
      "1.2.3-0alpha.0",
      "1.2.3+01",
    ])
      expect(
        parseShellSupportDeclaration(changed("runtime.version", value)).runtime
          .version,
      ).toBe(value);
    for (const value of [
      "v44.4.2",
      "44.4",
      "01.2.3",
      "1.02.3",
      "1.2.03",
      "1.2.3-01",
      "1.2.3-a..b",
      "1.2.3+",
      "1.2.3\n",
      "1.2.3-" + "a".repeat(128),
    ])
      invalid(changed("runtime.version", value));
  });
  it.each(["imports", "executables"])(
    "enforces dense own-data arrays with 1..16 entries at %s",
    (path) => {
      const get = vi.fn();
      const accessor = [...fixture().executables];
      Object.defineProperty(accessor, "0", { get, enumerable: true });
      const hidden = [...fixture().executables];
      Object.defineProperty(hidden, "0", { enumerable: false });
      const symbolic = [...fixture().executables];
      Object.defineProperty(symbolic, Symbol("pin"), { value: 1 });
      const extra = Object.assign([...fixture().executables], { extra: true });
      const custom = [...fixture().executables];
      Object.setPrototypeOf(custom, null);
      for (const value of [
        undefined,
        null,
        {},
        [],
        new Array(1),
        new Array(17),
        new Array(2 ** 32 - 1),
        accessor,
        hidden,
        symbolic,
        extra,
        custom,
      ])
        invalid(changed(path, value));
      expect(get).not.toHaveBeenCalled();
      const entries = Array.from({ length: 16 }, (_, index) => ({
        path:
          path === "imports"
            ? `/usr/share/sandbox/${index === 0 ? "dyld-support" : "import-" + index}.sb`
            : `/bin/tool-${index}`,
        sha256: "a".repeat(64),
      }));
      for (const length of [1, 16])
        expect(
          parseShellSupportDeclaration(changed(path, entries.slice(0, length)))[
            path as "imports" | "executables"
          ],
        ).toHaveLength(length);
      invalid(
        changed(path, [
          ...entries,
          { path: "/bin/extra", sha256: "b".repeat(64) },
        ]),
      );
    },
  );
  it.each(["imports.0.path", "executables.0.path"])(
    "rejects dirty absolute paths at %s",
    (path) => {
      for (const value of [
        "/",
        "bin/bash",
        "/bin//bash",
        "/bin/./bash",
        "/bin/../bash",
        "/bin/bash/",
        "/bin/ba\\sh",
        "/bin/ba:sh",
        "/bin/ba\0sh",
        "/bin/ba\nsh",
        "/bin/bash\n",
        "/bin/ba\u007fsh",
        "/bin/ba\u0085sh",
        "/" + "a".repeat(4096),
        "/usr/bin/sandbox-exec",
      ])
        invalid(changed(path, value));
    },
  );
  it("enforces direct OS .sb imports and exactly one dyld-support.sb", () => {
    for (const value of [
      "/tmp/dyld-support.sb",
      "/usr/share/sandbox/nested/dyld-support.sb",
      "/usr/share/sandbox-evil/dyld-support.sb",
      "/usr/share/sandbox/dyld-support.SB",
      "/usr/share/sandbox/other.sb",
    ])
      invalid(changed("imports.0.path", value));
    invalid(
      changed(
        "imports.1.path",
        "/System/Library/Sandbox/Profiles/dyld-support.sb",
      ),
    );
    expect(
      parseShellSupportDeclaration(
        changed(
          "imports.0.path",
          "/System/Library/Sandbox/Profiles/dyld-support.sb",
        ),
      ),
    ).toBeDefined();
  });
  it("rejects duplicate paths and inconsistent cross-list hashes", () => {
    for (const path of ["imports", "executables"] as const) {
      const entry = fixture()[path][0]!;
      invalid(changed(path, [entry, { ...entry }]));
      invalid(changed(path, [entry, { ...entry, sha256: "9".repeat(64) }]));
    }
    const input = fixture();
    at(input, "executables")["0"] = {
      ...input.imports[0],
      sha256: "9".repeat(64),
    };
    invalid(input);
    at(input, "executables")["0"] = { ...input.imports[0] };
    expect(parseShellSupportDeclaration(input)).toEqual(input);
  });
});

describe("binding to independently supplied expectations", () => {
  it("binds the entire declaration and separate core as immutable copied values", () => {
    const actual = fixture(),
      expected = fixture(),
      core = fixture().core;
    const bound = bindShellSupportDeclaration(actual, expected, core);
    expect(bound).toEqual(actual);
    for (const path of [...records, "imports", "executables"]) {
      expect(Object.isFrozen(at(bound, path))).toBe(true);
      expect(at(bound, path)).not.toBe(at(expected, path));
      expect(at(bound, path)).not.toBe(at(actual, path));
    }
    at(core, "binary").sha256 = "9".repeat(64);
    at(expected, "qualification").osBuild = "25A124";
    expect(bound).toEqual(fixture());
  });
  const crossings: [string, unknown][] = [
    ...digestPaths.map((path): [string, unknown] => [path, "9".repeat(64)]),
    ["core.build.buildId", "other-build"],
    ["core.build.sourceSHA", "9".repeat(40)],
    ["core.binary.size", 65],
    ["qualification.releaseId", "other-release"],
    ["qualification.osBuild", "25A124"],
    ["imports.1.path", "/usr/share/sandbox/other.sb"],
    ["executables.0.path", "/bin/zsh"],
    ["executables.1.path", "/usr/bin/other"],
    ["runtime.version", "44.4.3"],
  ];
  it.each(crossings)(
    "refuses valid semantic crossing %s on either side",
    (path, value) => {
      const crossed = changed(path, value);
      expect(parseShellSupportDeclaration(crossed)).toBeDefined();
      expect(() =>
        bindShellSupportDeclaration(crossed, fixture(), fixture().core),
      ).toThrow("shell_support_binding_mismatch");
      expect(() =>
        bindShellSupportDeclaration(fixture(), crossed, fixture().core),
      ).toThrow("shell_support_binding_mismatch");
    },
  );
  it.each(["imports", "executables"] as const)(
    "pins list membership and ordering for %s",
    (path) => {
      for (const entries of [
        fixture()[path].slice(0, 1),
        [...fixture()[path]].reverse(),
      ])
        expect(() =>
          bindShellSupportDeclaration(
            changed(path, entries),
            fixture(),
            fixture().core,
          ),
        ).toThrow("shell_support_binding_mismatch");
    },
  );
  it.each(crossings.filter(([path]) => path.startsWith("core.")))(
    "refuses separate core expectation crossing %s even with equal support inputs",
    (path, value) => {
      expect(() =>
        bindShellSupportDeclaration(
          fixture(),
          fixture(),
          changed(path, value).core,
        ),
      ).toThrow("shell_support_binding_mismatch");
    },
  );
  it("strictly parses each input before comparing", () => {
    const bad = { ...fixture(), extra: true };
    expect(() =>
      bindShellSupportDeclaration(bad, fixture(), fixture().core),
    ).toThrow("invalid_shell_support_declaration");
    expect(() =>
      bindShellSupportDeclaration(fixture(), bad, fixture().core),
    ).toThrow("invalid_shell_support_declaration");
    for (const core of [
      null,
      { ...fixture().core, extra: true },
      changed("core.binary.path", "other").core,
    ])
      expect(() =>
        bindShellSupportDeclaration(fixture(), fixture(), core),
      ).toThrow("invalid_shell_support_core_expectation");
  });
  it("rejects accessors in expected support and separate expected core", () => {
    const get = vi.fn();
    const expected = fixture();
    Object.defineProperty(expected.qualification, "sha256", {
      get,
      enumerable: true,
    });
    expect(() =>
      bindShellSupportDeclaration(fixture(), expected, fixture().core),
    ).toThrow("invalid_shell_support_declaration");
    const core = fixture().core;
    Object.defineProperty(core.binary, "sha256", { get, enumerable: true });
    expect(() =>
      bindShellSupportDeclaration(fixture(), fixture(), core),
    ).toThrow("invalid_shell_support_core_expectation");
    expect(get).not.toHaveBeenCalled();
  });
  it("compares copied values without invoking inherited serialization getters", () => {
    const get = vi.fn(() => {
      throw new Error("serialization getter must not run");
    });
    const previous = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "toJSON",
    );
    try {
      Object.defineProperty(Object.prototype, "toJSON", {
        get,
        configurable: true,
      });
      const bound = bindShellSupportDeclaration(
        fixture(),
        fixture(),
        fixture().core,
      );
      expect(bound.qualification.osBuild).toBe("25A123");
      expect(get).not.toHaveBeenCalled();
    } finally {
      if (previous) Object.defineProperty(Object.prototype, "toJSON", previous);
      else Reflect.deleteProperty(Object.prototype, "toJSON");
    }
  });
  it("does not turn untrusted self-comparison into a qualification receipt", () => {
    const untrusted = fixture();
    const value = bindShellSupportDeclaration(
      untrusted,
      untrusted,
      untrusted.core,
    );
    expect(Object.keys(value)).toEqual(Object.keys(untrusted));
    expect(value).toEqual(untrusted);
    expect(value).not.toHaveProperty("qualified");
    expect(value).not.toHaveProperty("authority");
  });
});

function gitResourceFixture() {
  const base = fixture();
  const git = {
    path: "/Library/Developer/CommandLineTools/usr/bin/git",
    sha256: "a".repeat(64),
  };
  const data = "/Library/Developer/CommandLineTools/usr/share/git-core";
  return {
    ...base,
    qualification: {
      ...base.qualification,
      filesystemClass: "system-apfs-kernel-mount-boundaries-v1" as const,
    },
    executables: [...base.executables, git],
    gitRuntimeResources: {
      git: { ...git },
      files: [
        { path: data + "/gitconfig", sha256: "b".repeat(64) },
        { path: data + "/templates/description", sha256: "c".repeat(64) },
      ],
      directories: [{ path: data + "/templates", entries: ["description"] }],
    },
  };
}
describe("finite build-selected Git runtime data", () => {
  it("admits only the exact independently pinned optional system attributes file", () => {
    const input = gitResourceFixture();
    const path =
      "/Library/Developer/CommandLineTools/usr/share/git-core/gitattributes";
    input.gitRuntimeResources.files.unshift({ path, sha256: "d".repeat(64) });
    expect(
      parseShellSupportDeclaration(input).gitRuntimeResources!.files[0],
    ).toEqual({ path, sha256: "d".repeat(64) });
    input.gitRuntimeResources.files[0]!.path = path + ".backup";
    invalid(input);
  });

  it("freezes the selected files and directory listings", () => {
    const input = gitResourceFixture();
    const result = parseShellSupportDeclaration(input);
    expect(result.gitRuntimeResources).toEqual(input.gitRuntimeResources);
    input.gitRuntimeResources.files[0]!.sha256 = "e".repeat(64);
    input.gitRuntimeResources.directories[0]!.entries[0] = "changed";
    expect(result.gitRuntimeResources!.files[0]!.sha256).toBe("b".repeat(64));
    expect(result.gitRuntimeResources!.directories[0]!.entries).toEqual([
      "description",
    ]);
  });
  it.each([
    ["gitRuntimeResources.git.path", "/usr/bin/git"],
    ["gitRuntimeResources.git.sha256", "e".repeat(64)],
    ["gitRuntimeResources.files.0.path", "/Library/Developer/private"],
    ["gitRuntimeResources.files.0.sha256", "0".repeat(64)],
    ["gitRuntimeResources.directories.0.path", "/Library/Developer"],
    ["gitRuntimeResources.directories.0.entries", []],
    [
      "gitRuntimeResources.directories.0.entries",
      ["description", "unexpected"],
    ],
    ["gitRuntimeResources.directories.0.entries", ["../description"]],
    ["qualification.filesystemClass", "local-apfs-no-nested-mounts-v1"],
  ])("rejects crossed or expanded %s", (path, value) => {
    const input = gitResourceFixture();
    const parts = path.split(".");
    const key = parts.pop()!;
    at(input, parts.join("."))[key] = value;
    invalid(input);
  });
  it("does not evaluate resource or array accessors", () => {
    for (const array of [false, true]) {
      const input = gitResourceFixture();
      const get = vi.fn(() => []);
      if (array)
        Object.defineProperty(input.gitRuntimeResources.files, "0", {
          get,
          enumerable: true,
        });
      else
        Object.defineProperty(input.gitRuntimeResources, "files", {
          get,
          enumerable: true,
        });
      invalid(input);
      expect(get).not.toHaveBeenCalled();
    }
  });
});

describe("finite CLT Python resource boundary", () => {
  const root =
    "/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9";
  function pythonFixture(): ShellSupportDeclaration {
    const value: ShellSupportDeclaration = gitResourceFixture();
    const library = root + "/lib/python3.9";
    return {
      ...value,
      executables: [
        ...value.executables,
        { path: root + "/bin/python3.9", sha256: "a".repeat(64) },
        {
          path: root + "/Resources/Python.app/Contents/MacOS/Python",
          sha256: "b".repeat(64),
        },
      ],
      gitRuntimeResources: {
        ...value.gitRuntimeResources!,
        python: {
          files: [
            root + "/Python3",
            library + "/codecs.py",
            library + "/encodings/__init__.py",
            library + "/encodings/utf_8.py",
            library + "/os.py",
          ].map((path) => ({ path, sha256: "c".repeat(64) })),
          directories: [
            { path: root + "/bin", entries: ["python3", "python3.9"] },
            { path: library, entries: ["codecs.py", "encodings", "os.py"] },
            {
              path: library + "/encodings",
              entries: ["__init__.py", "utf_8.py"],
            },
          ],
        },
      },
    };
  }
  it("freezes a finite standard library while retaining separate executable selection", () => {
    const input = pythonFixture();
    const parsed = parseShellSupportDeclaration(input);
    expect(parsed).toEqual(input);
    expect(Object.isFrozen(parsed.gitRuntimeResources!.python!.files[0])).toBe(
      true,
    );
  });
  it.each([
    "external-file",
    "external-dir",
    "external-interpreter",
    "site-packages",
    "missing-runtime",
    "missing-encoding",
    "getter",
  ])("refuses %s without broadening roots", (kind) => {
    const input = structuredClone(pythonFixture());
    const python = input.gitRuntimeResources!.python!;
    if (kind === "external-file")
      (python.files[0] as { path: string }).path = "/Users/foreign/lib.py";
    if (kind === "external-dir")
      (python.directories[0] as { path: string }).path = "/opt/homebrew/lib";
    if (kind === "external-interpreter")
      (
        input.executables[input.executables.length - 1] as { path: string }
      ).path = "/opt/homebrew/bin/python3";
    if (kind === "site-packages")
      (python.files[0] as { path: string }).path =
        root + "/lib/python3.9/site-packages/foreign.py";
    if (kind === "missing-runtime") (python.files as unknown[]).shift();
    if (kind === "missing-encoding") (python.files as unknown[]).splice(3, 1);
    const get = vi.fn();
    if (kind === "getter")
      Object.defineProperty(python, "files", { get, enumerable: true });
    invalid(input);
    expect(get).not.toHaveBeenCalled();
  });
});
