// Pinned native compiler metadata for iteration plans, never acceptance or emit.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { parse } from "@babel/parser";
import { API } from "typescript/unstable/sync";
import { version } from "typescript";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const inside = (root, name) =>
  name === root || name.startsWith(root + path.sep);
const git = (root, ...args) =>
  execFileSync(
    "git",
    [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-C",
      root,
      ...args,
    ],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_OPTIONAL_LOCKS: "0",
        LC_ALL: "C",
      },
    },
  );

export function snapshot(root) {
  const files = git(
    root,
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
  )
    .split("\0")
    .filter(Boolean)
    .sort();
  const hashes = {};
  for (const file of files) {
    const absolute = path.resolve(root, file);
    if (!inside(root, absolute) || file.split("/").includes(".git"))
      throw Error("GRAPH_PATH_REFUSED");
    if (!fs.existsSync(absolute)) {
      hashes[file] = null;
      continue;
    }
    if (
      fs.realpathSync(absolute) !== absolute ||
      !fs.statSync(absolute).isFile()
    )
      throw Error("GRAPH_SOURCE_REDIRECT");
    hashes[file] = sha(fs.readFileSync(absolute));
  }
  return { head: git(root, "rev-parse", "HEAD").trim(), files: hashes };
}

// Opaque loading prevents narrow selection even if ordinary imports resolve.
export function dynamicLoads(text, file) {
  const result = [];
  let ast;
  try {
    ast = parse(text, {
      sourceType: "unambiguous",
      plugins: ["typescript", "jsx"],
      createImportExpressions: true,
    });
  } catch {
    return ["PARSE_UNSUPPORTED"];
  }
  function walk(node) {
    if (!node || typeof node !== "object") return;
    // Native SourceFile.imports does not describe CommonJS dependencies. Treat
    // API references as opaque without depending on call/member/optional syntax.
    const name =
      node.type === "Identifier"
        ? node.name
        : node.type === "StringLiteral"
          ? node.value
          : null;
    if (["require", "module"].includes(name)) result.push("COMMONJS_LOAD");
    if (["createRequire", "getBuiltinModule"].includes(name))
      result.push("COMMONJS_FACTORY");
    if (["eval", "Function"].includes(name)) result.push("DYNAMIC_LOAD");
    if (
      node.type === "ImportDeclaration" &&
      ["module", "node:module"].includes(node.source?.value)
    )
      result.push("COMMONJS_FACTORY");
    if (
      node.type === "ImportExpression" &&
      node.source?.type !== "StringLiteral"
    )
      result.push("DYNAMIC_IMPORT");
    for (const [key, value] of Object.entries(node)) {
      if (["loc", "start", "end", "extra", "comments", "tokens"].includes(key))
        continue;
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") walk(value);
    }
  }
  walk(ast.program);
  return [...new Set(result)].sort();
}

export function typescriptGraph(
  root,
  configNames = ["tsconfig.json", "tsconfig.renderer.json"],
) {
  if (version !== "7.0.2") throw Error("GRAPH_COMPILER_VERSION_UNQUALIFIED");
  root = fs.realpathSync(root);
  const compilerRoot = fs.realpathSync(
    path.resolve(import.meta.dirname, "../../node_modules/typescript"),
  );
  const librariesRoot = path.dirname(compilerRoot);
  const permitted = (file) => {
    const absolute = path.resolve(file);
    if (!inside(root, absolute) && !inside(librariesRoot, absolute))
      return false;
    try {
      return (
        inside(root, fs.realpathSync(absolute)) ||
        inside(librariesRoot, fs.realpathSync(absolute))
      );
    } catch {
      return false;
    }
  };
  const api = new API({
    cwd: root,
    fs: {
      readFile: (file) =>
        permitted(file) && fs.statSync(file).isFile()
          ? fs.readFileSync(file, "utf8")
          : null,
      fileExists: (file) => permitted(file) && fs.statSync(file).isFile(),
      directoryExists: (file) =>
        permitted(file) && fs.statSync(file).isDirectory(),
      realpath: (file) =>
        permitted(file) ? fs.realpathSync(file) : path.resolve(file),
      getAccessibleEntries: (dir) => {
        if (!permitted(dir) || !fs.statSync(dir).isDirectory())
          return { files: [], directories: [] };
        const entries = fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.name !== ".git" && !e.isSymbolicLink());
        return {
          files: entries.filter((e) => e.isFile()).map((e) => e.name),
          directories: entries
            .filter((e) => e.isDirectory())
            .map((e) => e.name),
        };
      },
    },
  });
  const edges = [],
    gaps = [],
    configs = [],
    inputHashes = {};
  let current;
  try {
    const names = configNames.map((n) => path.resolve(root, n));
    for (const name of names)
      if (!inside(root, name) || !permitted(name))
        throw Error("GRAPH_CONFIG_REFUSED");
    current = api.updateSnapshot({ openProjects: names });
    for (const name of names) {
      const project = current.getProject(name);
      if (!project) throw Error("GRAPH_PROJECT_MISSING");
      configs.push({
        file: path.relative(root, name),
        options: project.compilerOptions,
      });
      for (const diagnostic of project.program.getConfigFileParsingDiagnostics())
        gaps.push({
          file: path.relative(root, name),
          reason: "COMPILER_CONFIG_DIAGNOSTIC",
          code: diagnostic.code,
        });
      const files = project.program.getSourceFileNames();
      const exact = new Map(files.map((f) => [f, f]));
      const folded = new Map();
      for (const file of files) {
        const key = file.toLowerCase();
        folded.set(key, [...(folded.get(key) ?? []), file]);
      }
      const physical = (file) =>
        exact.get(file) ??
        (folded.get(file.toLowerCase())?.length === 1
          ? folded.get(file.toLowerCase())[0]
          : null);
      for (const file of files) {
        if (
          !inside(root, file) ||
          file.includes(path.sep + "node_modules" + path.sep)
        )
          continue;
        const relative = path.relative(root, file);
        const source = project.program.getSourceFile(file);
        if (!source) {
          gaps.push({ file: relative, reason: "COMPILER_SOURCE_MISSING" });
          continue;
        }
        inputHashes[relative] = sha(source.text);
        for (const reason of relative.endsWith(".json")
          ? []
          : dynamicLoads(source.text, relative))
          gaps.push({ file: relative, reason });
        if (
          source.referencedFiles.length ||
          source.moduleAugmentations.length ||
          source.ambientModuleNames.length
        )
          gaps.push({
            file: relative,
            reason: "AMBIENT_OR_REFERENCE_DEPENDENCY",
          });
        const symbols = project.checker.getSymbolAtLocation(source.imports);
        for (let i = 0; i < source.imports.length; i++) {
          const imported = source.imports[i].text;
          const declarations = symbols[i]?.declarations ?? [];
          if (!declarations.length) {
            gaps.push({
              file: relative,
              reason: "MODULE_UNRESOLVED",
              import: imported,
            });
            continue;
          }
          for (const declaration of declarations) {
            const target = physical(declaration.path);
            if (!target) {
              gaps.push({
                file: relative,
                reason: "MODULE_DECLARATION_UNRESOLVED",
                import: imported,
              });
              continue;
            }
            if (
              inside(root, target) &&
              !target.includes(path.sep + "node_modules" + path.sep)
            )
              edges.push({
                from: relative,
                to: path.relative(root, target),
                kind: "typescript-native-module",
                config: path.relative(root, name),
              });
          }
        }
      }
    }
  } finally {
    current?.dispose();
    api.close();
  }
  return {
    compiler: "typescript@" + version + "/unstable/sync",
    configs,
    inputHashes,
    edges: [...new Map(edges.map((e) => [JSON.stringify(e), e])).values()].sort(
      (a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), "en"),
    ),
    gaps: [...new Map(gaps.map((e) => [JSON.stringify(e), e])).values()].sort(
      (a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), "en"),
    ),
    limits: [
      "Pinned unstable API; version drift refuses",
      "Imports use compiler project/config resolution; runtime resources and feature ownership still require mapping",
      "Unconfigured scripts and globals must broaden selection",
    ],
  };
}

export function goGraph(records, root) {
  root = fs.realpathSync(root);
  const packages = new Map(),
    gaps = [];
  for (const record of records) {
    if (
      !record ||
      typeof record.ImportPath !== "string" ||
      typeof record.Dir !== "string" ||
      !inside(root, record.Dir)
    )
      throw Error("GRAPH_GO_METADATA_INVALID");
    if (record.Error || record.DepsErrors?.length || record.Incomplete)
      gaps.push({
        package: record.ImportPath,
        reason: "GO_METADATA_INCOMPLETE",
      });
    const files = [
      ...new Set(
        [
          "GoFiles",
          "CgoFiles",
          "IgnoredGoFiles",
          "TestGoFiles",
          "XTestGoFiles",
          "EmbedFiles",
          "TestEmbedFiles",
          "XTestEmbedFiles",
        ].flatMap((key) => record[key] ?? []),
      ),
    ];
    const inputs = files
      .map((f) => {
        const full = path.resolve(record.Dir, f);
        if (!inside(root, full)) throw Error("GRAPH_GO_INPUT_ESCAPE");
        return path.relative(root, full);
      })
      .sort();
    const existing = packages.get(record.ImportPath);
    if (existing && existing.dir !== path.relative(root, record.Dir))
      throw Error("GRAPH_GO_PACKAGE_COLLISION");
    packages.set(record.ImportPath, {
      path: record.ImportPath,
      dir: path.relative(root, record.Dir),
      files: [...new Set([...(existing?.files ?? []), ...inputs])].sort(),
      imports: [
        ...new Set([
          ...(existing?.imports ?? []),
          ...(record.Imports ?? []),
          ...(record.TestImports ?? []),
          ...(record.XTestImports ?? []),
        ]),
      ].sort(),
    });
  }
  return {
    packages: [...packages.values()].sort((a, b) =>
      a.path.localeCompare(b.path, "en"),
    ),
    gaps,
  };
}

const runtimeModules = {
  "go.mod": "github.com/legrch/farol",
  "resources/native/go/go.mod": "farol.local/native",
};

// Go's ./... also walks non-Go dependency directories such as node_modules.
// Iteration metadata asks only for source-owned package directories. The full
// core gate retains its original ./... discovery, including dependency files.
export function goRuntimePatterns(source, moduleFile) {
  if (!Object.hasOwn(runtimeModules, moduleFile) || !source?.files)
    throw Error("GO_RUNTIME_MODULE_UNQUALIFIED");
  const moduleDirectory = path.posix.dirname(moduleFile);
  const moduleFiles = Object.keys(source.files).filter(
    (file) => path.posix.basename(file) === "go.mod" && source.files[file],
  );
  if (!moduleFiles.includes(moduleFile))
    throw Error("GO_RUNTIME_INPUT_UNBOUND");
  const directories = new Set();
  for (const [file, digest] of Object.entries(source.files)) {
    if (!file.endsWith(".go") || digest === null) continue;
    if (
      !/^[a-f0-9]{64}$/u.test(digest ?? "") ||
      path.posix.isAbsolute(file) ||
      /[\\\x00-\x1f]/u.test(file) ||
      file.split("/").some((part) => ["", ".", "..", ".git"].includes(part))
    )
      throw Error("GO_RUNTIME_SOURCE_PATH_UNQUALIFIED");
    const owner = moduleFiles
      .filter((name) => {
        const directory = path.posix.dirname(name);
        return directory === "." || file.startsWith(directory + "/");
      })
      .sort((a, b) => b.length - a.length)[0];
    if (owner !== moduleFile) continue;
    const relative = path.posix.relative(
      moduleDirectory,
      path.posix.dirname(file),
    );
    directories.add(relative ? "./" + relative : ".");
  }
  if (!directories.size) throw Error("GO_RUNTIME_PACKAGES_EMPTY");
  return [...directories].sort();
}

// A single DEFAULT/race context must not union in ignored native/OS inputs.
// These records describe compiler membership, never permission to execute it.
export function goRuntimeGraph(records, root, source, moduleFile) {
  root = fs.realpathSync(root);
  if (
    !Object.hasOwn(runtimeModules, moduleFile) ||
    !source?.files ||
    Array.isArray(source.files)
  )
    throw Error("GO_RUNTIME_MODULE_UNQUALIFIED");
  const moduleName = runtimeModules[moduleFile];
  const moduleRoot = path.dirname(path.join(root, moduleFile));
  const input = (relative) => {
    if (
      typeof relative !== "string" ||
      path.isAbsolute(relative) ||
      /[\\\x00-\x1f]/u.test(relative) ||
      relative.split("/").some((part) => ["", ".", "..", ".git"].includes(part))
    )
      throw Error("GO_RUNTIME_INPUT_PATH_REFUSED");
    const absolute = path.join(root, relative);
    if (
      !Object.hasOwn(source.files, relative) ||
      !/^[a-f0-9]{64}$/u.test(source.files[relative] ?? "")
    )
      throw Error("GO_RUNTIME_INPUT_UNBOUND");
    if (
      fs.realpathSync(absolute) !== absolute ||
      !fs.lstatSync(absolute).isFile()
    )
      throw Error("GO_RUNTIME_INPUT_REDIRECT");
    const digest = sha(fs.readFileSync(absolute));
    if (source.files[relative] !== digest)
      throw Error("GO_RUNTIME_INPUT_CHANGED");
    return { path: relative, sha256: digest };
  };
  input(moduleFile);
  const packages = [],
    gaps = [],
    seen = new Set();
  for (const record of records) {
    if (
      !record ||
      typeof record.Dir !== "string" ||
      !inside(moduleRoot, record.Dir) ||
      fs.realpathSync(record.Dir) !== record.Dir ||
      record.ForTest ||
      record.Module?.Path !== moduleName ||
      record.Module?.Main !== true ||
      record.Module?.GoMod !== path.join(root, moduleFile)
    )
      throw Error("GO_RUNTIME_PACKAGE_UNQUALIFIED");
    const local = path.relative(moduleRoot, record.Dir);
    const expected = moduleName + (local ? "/" + local : "");
    if (record.ImportPath !== expected || seen.has(expected))
      throw Error("GO_RUNTIME_PACKAGE_DUPLICATE_OR_MISMATCH");
    seen.add(expected);
    if (record.Error || record.DepsErrors?.length || record.Incomplete)
      gaps.push({
        package: expected,
        reason: "GO_RUNTIME_METADATA_INCOMPLETE",
      });
    const names = (field) => {
      const list = record[field] ?? [];
      if (
        !Array.isArray(list) ||
        list.some((name) => typeof name !== "string") ||
        new Set(list).size !== list.length
      )
        throw Error("GO_RUNTIME_FILE_LIST_INVALID");
      return list.map((name) => {
        if (
          path.isAbsolute(name) ||
          /[\\\x00-\x1f]/u.test(name) ||
          name.split("/").some((part) => ["", ".", "..", ".git"].includes(part))
        )
          throw Error("GO_RUNTIME_INPUT_PATH_REFUSED");
        return path.relative(root, path.join(record.Dir, name));
      });
    };
    const tests = [...names("TestGoFiles"), ...names("XTestGoFiles")];
    if (
      new Set(tests).size !== tests.length ||
      tests.some((name) => !name.endsWith("_test.go"))
    )
      throw Error("GO_RUNTIME_TEST_MEMBERSHIP_INVALID");
    const ignored = names("IgnoredGoFiles");
    if (tests.some((name) => ignored.includes(name)))
      throw Error("GO_RUNTIME_ACTIVE_IGNORED_COLLISION");
    const active = [
      ...new Set(
        [
          "GoFiles",
          "CgoFiles",
          "CFiles",
          "CXXFiles",
          "MFiles",
          "HFiles",
          "FFiles",
          "SFiles",
          "SwigFiles",
          "SwigCXXFiles",
          "SysoFiles",
          "EmbedFiles",
          "TestEmbedFiles",
          "XTestEmbedFiles",
        ]
          .flatMap(names)
          .concat(tests),
      ),
    ].sort();
    if (active.some((name) => ignored.includes(name)))
      throw Error("GO_RUNTIME_ACTIVE_IGNORED_COLLISION");
    if (
      (record.CgoFiles?.length ?? 0) ||
      (record.SwigFiles?.length ?? 0) ||
      (record.SwigCXXFiles?.length ?? 0)
    )
      gaps.push({
        package: expected,
        reason: "GO_RUNTIME_CGO_OR_SWIG_UNQUALIFIED",
      });
    const inputs = [...new Set([...active, ...ignored])].sort().map(input);
    packages.push({
      path: expected,
      dir: path.relative(root, record.Dir),
      module: moduleFile,
      files: active,
      testFiles: tests.sort(),
      ignoredFiles: ignored.sort(),
      inputs,
    });
  }
  if (!packages.length) throw Error("GO_RUNTIME_PACKAGES_EMPTY");
  return {
    packages: packages.sort((a, b) => a.path.localeCompare(b.path, "en")),
    gaps,
  };
}

export function jsonObjects(text) {
  const result = [];
  let start = -1,
    depth = 0,
    quoted = false,
    escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (start < 0) {
      if (/\s/u.test(c)) continue;
      if (c !== "{") throw Error("GO_JSON_STREAM_INVALID");
      start = i;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      result.push(JSON.parse(text.slice(start, i + 1)));
      start = -1;
    }
  }
  if (start >= 0 || !result.length) throw Error("GO_JSON_STREAM_INCOMPLETE");
  return result;
}

export function collectGo(root, source, options) {
  if (options.runtime !== undefined && options.runtime !== "linux-arm64-race")
    throw Error("GRAPH_GO_RUNTIME_CONTEXT_UNQUALIFIED");
  const executable = fs.realpathSync(options.go);
  if (
    !/^[a-f0-9]{64}$/u.test(options.goSha256) ||
    sha(fs.readFileSync(executable)) !== options.goSha256
  )
    throw Error("GRAPH_GO_BINARY_MISMATCH");
  const cache = fs.realpathSync(options.cache);
  if (!inside(path.join(root, "_output"), cache))
    throw Error("GRAPH_CACHE_MUST_BE_TASK_OWNED");
  const moduleCache = path.join(cache, "go-mod-cache");
  if (!fs.statSync(moduleCache).isDirectory())
    throw Error("GRAPH_MODULE_CACHE_MISSING");
  const records = [],
    observations = [];
  const runtime = {
    schema: 1,
    kind: "go-runtime-plan-input",
    acceptance: false,
    executionAllowed: false,
    goos: "linux",
    goarch: "arm64",
    race: true,
    cgo: "1",
    tags: [],
    packages: [],
    gaps: [],
    observations: [],
  };
  const tags =
    "farol_native_root_scoped,farol_native_mount_boundaries,farol_native_process,farol_native_process_observer";
  for (const file of Object.keys(source.files)
    .filter((f) => path.basename(f) === "go.mod")
    .sort()) {
    for (const goos of ["darwin", "linux"]) {
      const args = ["list", "-e", "-json", "-tags=" + tags, "./..."];
      const env = {
        PATH: path.dirname(executable) + ":/usr/bin:/bin",
        GOENV: "off",
        GOTOOLCHAIN: "local",
        GOWORK: "off",
        GOPROXY: "off",
        GOSUMDB: "off",
        GOFLAGS: "-mod=readonly -p=2",
        GOMAXPROCS: "2",
        CGO_ENABLED: "0",
        GOOS: goos,
        GOARCH: "arm64",
        GOMODCACHE: moduleCache,
        GOCACHE: path.join(cache, "go-build-cache"),
        GOPATH: path.join(cache, "gopath"),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        LC_ALL: "C",
      };
      const bytes = execFileSync(executable, args, {
        cwd: path.dirname(path.join(root, file)),
        env,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        timeout: 60000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      records.push(...jsonObjects(bytes));
      observations.push({
        module: file,
        goos,
        goarch: "arm64",
        tags,
        command: [executable, ...args],
        sha256: sha(bytes),
      });
    }
    if (options.runtime === "linux-arm64-race") {
      const patterns = goRuntimePatterns(source, file);
      const args = ["list", "-e", "-json", "-race", ...patterns];
      const env = {
        PATH: path.dirname(executable) + ":/usr/bin:/bin",
        GOENV: "off",
        GOTOOLCHAIN: "local",
        GOWORK: "off",
        GOPROXY: "off",
        GOSUMDB: "off",
        GOFLAGS: "-mod=readonly -p=2",
        GOMAXPROCS: "2",
        CGO_ENABLED: "1",
        GOOS: "linux",
        GOARCH: "arm64",
        GOMODCACHE: moduleCache,
        GOCACHE: path.join(cache, "go-build-cache"),
        GOPATH: path.join(cache, "gopath"),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        LC_ALL: "C",
      };
      const bytes = execFileSync(executable, args, {
        cwd: path.dirname(path.join(root, file)),
        env,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        timeout: 60000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const active = goRuntimeGraph(jsonObjects(bytes), root, source, file);
      const expectedDirectories = patterns
        .map((pattern) =>
          path.relative(
            root,
            path.resolve(path.dirname(path.join(root, file)), pattern),
          ),
        )
        .sort();
      if (
        JSON.stringify(active.packages.map((item) => item.dir).sort()) !==
        JSON.stringify(expectedDirectories)
      )
        throw Error("GO_RUNTIME_PACKAGE_MEMBERSHIP_MISMATCH");
      runtime.packages.push(...active.packages);
      runtime.gaps.push(...active.gaps);
      runtime.observations.push({
        module: file,
        discovery: "source-owned-package-directories",
        patterns,
        command: [executable, ...args],
        sha256: sha(bytes),
      });
    }
  }
  if (
    !observations.length ||
    sha(fs.readFileSync(executable)) !== options.goSha256
  )
    throw Error("GRAPH_GO_PROVENANCE_CHANGED");
  const graph = goGraph(records, root);
  const knownTags = new Set(["darwin", "linux", ...tags.split(",")]);
  for (const file of Object.keys(source.files).filter(
    (f) => f.endsWith(".go") && source.files[f],
  )) {
    const bytes = fs.readFileSync(path.join(root, file), "utf8");
    const constraint = bytes.match(/^\/\/go:build (.+)$/mu)?.[1];
    if (
      constraint &&
      (constraint.match(/[A-Za-z_][A-Za-z0-9_]*/gu) ?? []).some(
        (tag) => !knownTags.has(tag),
      )
    )
      graph.gaps.push({ file, reason: "GO_BUILD_CONSTRAINT_UNQUALIFIED" });
    if (/\bimport\s*(?:\([^)]*)?"C"/su.test(bytes))
      graph.gaps.push({ file, reason: "CGO_NOT_MODELED" });
  }
  return {
    ...graph,
    observations,
    binarySha256: options.goSha256,
    ...(options.runtime ? { runtime } : {}),
    limits: [
      "go list metadata only, not test execution or cross-platform qualification",
      "Both supported OS targets plus declared native tags; CGO disabled and arm64 only",
      "Executable pin binds selected bytes, not full SDK or vendor provenance",
    ],
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    const options = {};
    for (let i = 2; i < process.argv.length; i += 2) {
      const key = {
        "--go": "go",
        "--go-sha256": "goSha256",
        "--cache": "cache",
        "--go-runtime": "runtime",
      }[process.argv[i]];
      if (!key || options[key] || !process.argv[i + 1])
        throw Error("GRAPH_ARGUMENT_INVALID");
      options[key] = process.argv[i + 1];
    }
    const goOptions = ["go", "goSha256", "cache"].filter((name) =>
      Object.hasOwn(options, name),
    ).length;
    if ((goOptions && goOptions !== 3) || (options.runtime && goOptions !== 3))
      throw Error("GRAPH_GO_OPTIONS_INCOMPLETE");
    if (options.runtime && options.runtime !== "linux-arm64-race")
      throw Error("GRAPH_GO_RUNTIME_CONTEXT_UNQUALIFIED");
    const root = fs.realpathSync(path.resolve(import.meta.dirname, "../.."));
    const before = snapshot(root);
    const graph = typescriptGraph(root);
    const go = options.go ? collectGo(root, before, options) : null;
    const after = snapshot(root);
    if (JSON.stringify(before) !== JSON.stringify(after))
      throw Error("GRAPH_SOURCE_CHANGED");
    process.stdout.write(
      JSON.stringify(
        {
          schema: 1,
          kind: "compiler-graph-plan-input",
          acceptance: false,
          executionAllowed: false,
          source: before,
          typescript: graph,
          go,
        },
        null,
        2,
      ) + "\n",
    );
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        status: "BLOCKED",
        reason: error.message,
        acceptance: false,
      }) + "\n",
    );
    process.exitCode = 2;
  }
}
