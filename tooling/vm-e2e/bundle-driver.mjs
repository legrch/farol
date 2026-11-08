// Host-side staging tool that bundles an e2e entry into ONE self-contained
// driver.bundle.mjs for the closed-contour VM executor (farol.vm-e2e/1), per
// the packet-4 design in E2E-VM-EXECUTOR-PLAN.md: the guest has no Node and no
// node_modules, so the driver ships as a self-contained bundle staged via the
// read-only artifacts share, and results flow back through the exchange
// mailbox. The tool records digests in manifest.json; it never embeds secret
// material and never copies the Node runtime (the copy decision belongs to the
// VM staging step, out of scope here).
//
// Prototype scope: this proves the bundling/staging shape on the host only.
// It is NOT guest evidence, NOT network containment evidence, and claims no
// VM qualification.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chooseRuntime } from "../vm-entry.mjs";

export const TOOL_VERSION = "farol.vm-e2e/1";
export const BUNDLE_FILE = "driver.bundle.mjs";
export const MANIFEST_FILE = "manifest.json";
export const MANIFEST_SCHEMA = "farol.vm-e2e.driver-manifest/1";

const NODE_PREFIX = "node:";
const BUNDLERS = ["auto", "esbuild", "inline"];
const ENTRY_EXTENSIONS = /\.(?:mjs|js)$/u;
// Top-level declarations only: repo style keeps function-local declarations
// indented, so an unindented match means a module-scope binding.
const TOP_LEVEL_DECLARATION =
  /^(?:const|let|var|async function|function|class)\s+([A-Za-z_$][\w$]*)/u;
// Bounded inline bundler input: single-line, double-quoted import statements
// in the listed forms only. Anything else fails closed.
const IMPORT_FORMS = [
  /^import\s+"([^"]+)"\s*;?$/u,
  /^import\s+([A-Za-z_$][\w$]*)\s*,\s*\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+"([^"]+)"\s*;?$/u,
  /^import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+"([^"]+)"\s*;?$/u,
  /^import\s+([A-Za-z_$][\w$]*)\s*,\s*\{([^}]*)\}\s+from\s+"([^"]+)"\s*;?$/u,
  /^import\s+([A-Za-z_$][\w$]*)\s+from\s+"([^"]+)"\s*;?$/u,
  /^import\s+\{([^}]*)\}\s+from\s+"([^"]+)"\s*;?$/u,
];

function spawnEnv() {
  return Object.fromEntries(
    ["HOME", "USER", "TMPDIR", "PATH"]
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]),
  );
}

function readDeclaredVersions(root) {
  const versions = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  )
    .engines.node.split("||")
    .map((x) => x.trim());
  if (!versions.every((x) => /^\d+\.\d+\.\d+$/.test(x))) {
    throw new Error("DECLARED_NODE_VERSIONS_INVALID");
  }
  return versions;
}

// The declared-runtime selection is the vm-entry.mjs chooseRuntime contract:
// prefer the running Node when it matches the declared engines, otherwise probe
// the known install locations, and never install a toolchain automatically.
// vm-entry.mjs guards its CLI entry, so the helper imports cleanly here.
export function selectDeclaredRuntime(root) {
  const versions = readDeclaredVersions(root);
  return chooseRuntime(
    process.versions.node,
    process.execPath,
    versions,
    os.homedir(),
    (binary) => {
      const result = spawnSync(binary, ["--version"], {
        encoding: "utf8",
        env: spawnEnv(),
        timeout: 3000,
      });
      return result.status === 0
        ? result.stdout.trim().replace(/^v/, "")
        : null;
    },
  );
}

function probeEsbuild(root, nodePath, env) {
  const wrapper = path.join(root, "node_modules", "esbuild", "bin", "esbuild");
  const declared = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  ).devDependencies?.esbuild;
  if (!declared) {
    return { available: false, reason: "esbuild is not in devDependencies" };
  }
  if (!fs.existsSync(wrapper)) {
    return {
      available: false,
      reason: "esbuild wrapper missing at node_modules/esbuild/bin/esbuild",
    };
  }
  const probe = spawnSync(nodePath, [wrapper, "--version"], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 20000,
  });
  const version = String(probe.stdout ?? "").trim();
  if (probe.error || probe.status !== 0 || !/^\d+\.\d+\.\d+/u.test(version)) {
    const detail = probe.error
      ? String(probe.error.message ?? probe.error)
      : "exit " + probe.status + ": " + String(probe.stderr ?? "").trim();
    return { available: false, reason: "esbuild binary did not run: " + detail };
  }
  return { available: true, version, wrapper };
}

function bundleWithEsbuild({ entryPath, tempPath, wrapper, nodePath, root, env, targetMajor }) {
  const result = spawnSync(
    nodePath,
    [
      wrapper,
      entryPath,
      "--bundle",
      "--format=esm",
      "--platform=node",
      "--target=node" + targetMajor,
      "--outfile=" + tempPath,
      "--log-level=warning",
    ],
    { cwd: root, env, encoding: "utf8", timeout: 120000 },
  );
  if (result.error) {
    throw new Error(
      "E2E_BUNDLE_ESBUILD_FAILED: " + String(result.error.message ?? result.error),
    );
  }
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr]
      .filter((x) => x)
      .join("\n")
      .trim();
    const unresolved = /Could not resolve\s+"([^"]+)"/u.exec(output);
    if (unresolved) {
      throw new Error("E2E_BUNDLE_UNRESOLVED_IMPORT: " + unresolved[1]);
    }
    throw new Error(
      "E2E_BUNDLE_ESBUILD_FAILED: esbuild exited " +
        result.status +
        ": " +
        output.slice(-400),
    );
  }
  if (!fs.existsSync(tempPath)) {
    throw new Error(
      "E2E_BUNDLE_ESBUILD_FAILED: esbuild reported success without writing the bundle",
    );
  }
}

function parseNamedList(text, what) {
  return text
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => {
      const match = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/u.exec(item);
      if (!match) {
        throw new Error(
          "E2E_BUNDLE_UNSUPPORTED_SYNTAX: " + what + " list item: " + item,
        );
      }
      return { imported: match[1], local: match[2] ?? match[1] };
    });
}

function parseImportLine(line) {
  for (let index = 0; index < IMPORT_FORMS.length; index += 1) {
    const match = IMPORT_FORMS[index].exec(line);
    if (match) return { form: index, match, specifier: match[match.length - 1] };
  }
  return null;
}

function importBindingNames(parsed) {
  const { form, match } = parsed;
  if (form === 1) return [match[1], match[2]];
  if (form === 2) return [match[1]];
  if (form === 3) {
    return [match[1], ...parseNamedList(match[2], "import").map((x) => x.local)];
  }
  if (form === 4) return [match[1]];
  if (form === 5) return parseNamedList(match[1], "import").map((x) => x.local);
  return [];
}

function rewriteRelativeImport(parsed, moduleId) {
  const target = JSON.stringify(moduleId);
  const { form, match } = parsed;
  if (form === 0) return ["__mod(" + target + ");"];
  const defaultBinding =
    form === 1 || form === 3 || form === 4
      ? ["const " + match[1] + " = __mod(" + target + ").default;"]
      : [];
  if (form === 1) {
    return [...defaultBinding, "const " + match[2] + " = __mod(" + target + ");"];
  }
  if (form === 2) return ["const " + match[1] + " = __mod(" + target + ");"];
  if (form === 3 || form === 5) {
    const list = parseNamedList(form === 3 ? match[2] : match[1], "import");
    const destructure =
      "const { " +
      list
        .map((x) => (x.imported === x.local ? x.local : x.imported + ": " + x.local))
        .join(", ") +
      " } = __mod(" +
      target +
      ");";
    return [...defaultBinding, destructure];
  }
  return defaultBinding;
}

// Transforms one module into the body of a bundled module function. Returns
// the rewritten body lines (emitted verbatim, unindented, so multi-line
// string literals survive), the node: import lines to hoist, the relative
// import edges, and the export registrations.
function parseInlineModule(source, id, boundary, modulePath) {
  const body = [];
  const nodeImports = [];
  const edges = [];
  const exportNames = [];
  const declared = new Set();
  let defaultExport = null;
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (/^import\b/u.test(line)) {
      const parsed = parseImportLine(line);
      if (!parsed) {
        throw new Error(
          "E2E_BUNDLE_UNSUPPORTED_SYNTAX: import statement in " +
            id +
            ": " +
            line,
        );
      }
      const { specifier } = parsed;
      if (specifier.startsWith(NODE_PREFIX)) {
        nodeImports.push(line);
        continue;
      }
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
        throw new Error("E2E_BUNDLE_UNRESOLVED_IMPORT: " + specifier);
      }
      const resolved = path.resolve(path.dirname(modulePath), specifier);
      const inside = path.relative(boundary, resolved);
      if (inside.startsWith("..") || path.isAbsolute(inside)) {
        throw new Error(
          "E2E_BUNDLE_IMPORT_OUTSIDE_ROOT: " + specifier + " in " + id,
        );
      }
      const target = fs.statSync(resolved, { throwIfNoEntry: false });
      if (!target || !target.isFile() || !ENTRY_EXTENSIONS.test(resolved)) {
        throw new Error("E2E_BUNDLE_IMPORT_MISSING: " + specifier + " in " + id);
      }
      edges.push(resolved);
      body.push(...rewriteRelativeImport(parsed, inside.split(path.sep).join("/")));
      continue;
    }
    if (/^export\b/u.test(line)) {
      if (/^export\s+(?:\*|\{[^}]*\}\s*from\s)/u.test(line)) {
        throw new Error(
          "E2E_BUNDLE_UNSUPPORTED_SYNTAX: re-export in " + id + ": " + line,
        );
      }
      const decl = /^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/u.exec(line);
      const fn = /^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/u.exec(line);
      const cls = /^export\s+class\s+([A-Za-z_$][\w$]*)/u.exec(line);
      const list = /^export\s+\{([^}]*)\}\s*;?$/u.exec(line);
      const defNamedFn = /^export\s+default\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/u.exec(line);
      const defNamedCls = /^export\s+default\s+class\s+([A-Za-z_$][\w$]*)/u.exec(line);
      const defExpr = /^export\s+default\s+(.+?)\s*;?$/u.exec(line);
      if (decl || fn || cls) {
        const name = (decl ?? fn ?? cls)[1];
        declared.add(name);
        exportNames.push(name);
        body.push(line.replace(/^export\s+/u, ""));
        continue;
      }
      if (list) {
        for (const item of parseNamedList(list[1], "export")) {
          body.push("__exports." + item.local + " = " + item.imported + ";");
        }
        continue;
      }
      if (defNamedFn || defNamedCls) {
        const name = (defNamedFn ?? defNamedCls)[1];
        declared.add(name);
        defaultExport = name;
        body.push(line.replace(/^export\s+default\s+/u, ""));
        continue;
      }
      if (defExpr) {
        if (/^(?:async\s+)?(?:function|class)\b/u.test(defExpr[1])) {
          throw new Error(
            "E2E_BUNDLE_UNSUPPORTED_SYNTAX: anonymous default export in " +
              id +
              ": " +
              line,
          );
        }
        declared.add("__default_export");
        defaultExport = "__default_export";
        body.push("const __default_export = " + defExpr[1] + ";");
        continue;
      }
      throw new Error(
        "E2E_BUNDLE_UNSUPPORTED_SYNTAX: export statement in " + id + ": " + line,
      );
    }
    const bare = TOP_LEVEL_DECLARATION.exec(raw);
    if (bare) {
      declared.add(bare[1]);
      if (bare[1].startsWith("__")) {
        throw new Error(
          "E2E_BUNDLE_UNSUPPORTED_SYNTAX: reserved top-level name in " +
            id +
            ": " +
            bare[1],
        );
      }
    }
    // Non-statement lines are emitted verbatim so multi-line string and
    // template literals survive the transform unchanged.
    body.push(raw);
  }
  for (const name of exportNames) body.push("__exports." + name + " = " + name + ";");
  if (defaultExport) body.push("__exports.default = " + defaultExport + ";");
  return { id, body, nodeImports, edges, declared };
}

function collectInlineModules(entryPath) {
  const boundary = path.dirname(entryPath);
  const modules = new Map();
  const visiting = new Set();
  const visit = (modulePath) => {
    const id = path.relative(boundary, modulePath).split(path.sep).join("/");
    if (modules.has(id)) return;
    if (visiting.has(id)) {
      throw new Error("E2E_BUNDLE_UNSUPPORTED_CYCLE: " + id);
    }
    visiting.add(id);
    const parsed = parseInlineModule(
      fs.readFileSync(modulePath, "utf8"),
      id,
      boundary,
      modulePath,
    );
    for (const edge of parsed.edges) visit(edge);
    visiting.delete(id);
    modules.set(id, parsed);
  };
  visit(entryPath);
  return { modules, boundary };
}

// Emits the self-contained bundle. Body lines are emitted unindented on
// purpose: re-indenting could alter multi-line string literals.
function emitInlineBundle(entryId, entryName, modules) {
  const parts = [];
  parts.push("// Farol vm-e2e in-guest driver bundle (" + TOOL_VERSION + ").");
  parts.push("// Entry: " + entryName + ". Bundler: bounded-inline.");
  parts.push(
    "// Relative imports are inlined; only node: builtins remain external. Generated by tooling/vm-e2e/bundle-driver.mjs; do not edit.",
  );
  parts.push(
    "// Prototype scope: proves bundling/staging shape; NOT guest evidence; no VM qualification.",
  );
  const bound = new Map();
  const importLines = [];
  for (const mod of modules.values()) {
    for (const line of mod.nodeImports) {
      const parsed = parseImportLine(line);
      for (const name of importBindingNames(parsed)) {
        const existing = bound.get(name);
        if (existing === undefined) {
          bound.set(name, parsed.specifier);
        } else if (existing !== parsed.specifier) {
          throw new Error(
            "E2E_BUNDLE_UNSUPPORTED_SYNTAX: node import binding collision: " + name,
          );
        }
      }
      if (!importLines.includes(line)) importLines.push(line);
    }
  }
  for (const mod of modules.values()) {
    for (const name of mod.declared) {
      if (bound.has(name)) {
        throw new Error(
          "E2E_BUNDLE_UNSUPPORTED_SYNTAX: node import binding collision: " + name,
        );
      }
    }
  }
  parts.push(...importLines);
  parts.push("const __cache = new Map();");
  parts.push("function __mod(id) {");
  parts.push("  let exports = __cache.get(id);");
  parts.push("  if (exports === undefined) {");
  parts.push("    const define = __defs[id];");
  parts.push("    if (define === undefined) {");
  parts.push('      throw new Error("E2E_BUNDLE_MODULE_MISSING: " + id);');
  parts.push("    }");
  parts.push("    exports = {};");
  parts.push("    __cache.set(id, exports);");
  parts.push("    define(exports);");
  parts.push("  }");
  parts.push("  return exports;");
  parts.push("}");
  parts.push("const __defs = {");
  for (const mod of modules.values()) {
    parts.push("  " + JSON.stringify(mod.id) + ": (__exports) => {");
    parts.push(...mod.body);
    parts.push("  },");
  }
  parts.push("};");
  parts.push("__mod(" + JSON.stringify(entryId) + ");");
  return parts.join("\n") + "\n";
}

// Final gate for both bundlers: the staged bundle may import node: builtins
// only, so the guest run needs no node_modules resolution at all.
export function assertNoHostImports(text) {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (/^import\b/u.test(line)) {
      const specifiers = [...line.matchAll(/["']([^"']+)["']/gu)].map((m) => m[1]);
      if (specifiers.length === 0 || specifiers.some((s) => !s.startsWith(NODE_PREFIX))) {
        throw new Error(
          "E2E_BUNDLE_OUTPUT_IMPORT_REMAINS: " + (specifiers[0] ?? line.slice(0, 80)),
        );
      }
    }
    for (const match of line.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/gu)) {
      if (!match[1].startsWith(NODE_PREFIX)) {
        throw new Error("E2E_BUNDLE_OUTPUT_IMPORT_REMAINS: " + match[1]);
      }
    }
    if (/^export\b/u.test(line)) {
      const from = /\bfrom\s*["']([^"']+)["']/u.exec(line);
      if (from && !from[1].startsWith(NODE_PREFIX)) {
        throw new Error("E2E_BUNDLE_OUTPUT_IMPORT_REMAINS: " + from[1]);
      }
    }
  }
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// Bundles `entry` into `outputDir` and writes manifest.json. Returns the
// manifest object. `bundler` selects the strategy: "auto" (default) uses
// esbuild when available and honestly reports the fallback otherwise;
// "esbuild" and "inline" pin one strategy and fail closed if it is
// unavailable.
export function bundleDriver({ entry, outputDir, root, bundler = "auto" }) {
  if (!BUNDLERS.includes(bundler)) {
    throw new Error("E2E_BUNDLE_BUNDLER_INVALID: " + bundler);
  }
  const entryPath = path.resolve(entry);
  const entryStat = fs.statSync(entryPath, { throwIfNoEntry: false });
  if (!entryStat || !entryStat.isFile() || !ENTRY_EXTENSIONS.test(entryPath)) {
    throw new Error("E2E_BUNDLE_ENTRY_MISSING: " + entryPath);
  }
  const output = path.resolve(outputDir);
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  const nodePath = selectDeclaredRuntime(root);
  const nodeStat = fs.statSync(nodePath);
  if (!nodeStat.isFile()) {
    throw new Error("DECLARED_NODE_RUNTIME_INVALID: " + nodePath);
  }
  const env = spawnEnv();
  const versions = readDeclaredVersions(root);
  const targetMajor = Math.min(...versions.map((v) => Number(v.split(".")[0])));
  const tempPath = path.join(
    output,
    "." + BUNDLE_FILE.replace(/\.mjs$/, "") + ".tmp.mjs",
  );
  let usedBundler;
  let esbuildVersion;
  if (bundler === "inline") {
    usedBundler = "inline";
  } else {
    const probe = probeEsbuild(root, nodePath, env);
    if (probe.available) {
      usedBundler = "esbuild";
      esbuildVersion = probe.version;
    } else if (bundler === "esbuild") {
      throw new Error("E2E_BUNDLER_ESBUILD_UNAVAILABLE: " + probe.reason);
    } else {
      process.stderr.write(
        "E2E_BUNDLER_ESBUILD_UNAVAILABLE: " +
          probe.reason +
          "; using the bounded inline bundler\n",
      );
      usedBundler = "inline";
    }
  }
  try {
    if (usedBundler === "esbuild") {
      bundleWithEsbuild({
        entryPath,
        tempPath,
        wrapper: path.join(root, "node_modules", "esbuild", "bin", "esbuild"),
        nodePath,
        root,
        env,
        targetMajor,
      });
    } else {
      const { modules } = collectInlineModules(entryPath);
      const entryId = path
        .relative(path.dirname(entryPath), entryPath)
        .split(path.sep)
        .join("/");
      fs.writeFileSync(
        tempPath,
        emitInlineBundle(entryId, path.basename(entryPath), modules),
        { mode: 0o600 },
      );
    }
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // The temp bundle may already be absent; a failed bundle leaves no residue.
    }
    throw error;
  }
  const text = fs.readFileSync(tempPath, "utf8");
  assertNoHostImports(text);
  fs.chmodSync(tempPath, 0o600);
  fs.renameSync(tempPath, path.join(output, BUNDLE_FILE));
  const bytes = fs.readFileSync(path.join(output, BUNDLE_FILE));
  const manifest = {
    schema: MANIFEST_SCHEMA,
    tool: TOOL_VERSION,
    entry: path.basename(entryPath),
    bundler: usedBundler,
    bundle: { file: BUNDLE_FILE, sha256: sha256Hex(bytes), bytes: bytes.length },
    node: {
      path: nodePath,
      size: nodeStat.size,
      sha256: sha256Hex(fs.readFileSync(nodePath)),
    },
  };
  if (usedBundler === "esbuild") {
    manifest.esbuild = { version: esbuildVersion };
  }
  const manifestPath = path.join(output, MANIFEST_FILE);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", {
    mode: 0o600,
  });
  fs.chmodSync(manifestPath, 0o600);
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const entry = process.argv[2];
  const outputDir = process.argv[3];
  if (!entry || !outputDir) {
    console.error(
      "usage: node tooling/vm-e2e/bundle-driver.mjs <entry.mjs> <output-dir>",
    );
    process.exitCode = 1;
  } else {
    try {
      const root = fileURLToPath(new URL("../../", import.meta.url));
      console.log(JSON.stringify(bundleDriver({ entry, outputDir, root }), null, 2));
    } catch (error) {
      console.error(String(error.message ?? error));
      process.exitCode = 1;
    }
  }
}
