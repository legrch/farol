// Static, data-only command discovery. Never evaluate Task variables or run tasks.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import prettier from "prettier";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const safeKey = (key) => {
  if (
    typeof key !== "string" ||
    ["__proto__", "constructor", "prototype"].includes(key)
  )
    throw Error("YAML_KEY_UNSUPPORTED");
  return key;
};

export async function decodeYaml(text) {
  const { ast } = await prettier.__debug.parse(text, { parser: "yaml" });
  const documents = ast.children.filter((n) => n.type === "document");
  if (documents.length !== 1) throw Error("YAML_DOCUMENT_COUNT");
  const body = documents[0].children.find((n) => n.type === "documentBody");
  const anchors = new Map();
  function decode(n) {
    if (!n) return null;
    if (n.tag) throw Error("YAML_TAG_UNSUPPORTED");
    let result;
    if (
      [
        "mappingKey",
        "mappingValue",
        "sequenceItem",
        "flowSequenceItem",
        "documentBody",
      ].includes(n.type)
    ) {
      if (n.children.length > 1) throw Error("YAML_WRAPPER_UNSUPPORTED");
      result = decode(n.children[0]);
    } else if (["mapping", "flowMapping"].includes(n.type)) {
      const own = Object.create(null),
        merges = [];
      for (const item of n.children) {
        if (
          !["mappingItem", "flowMappingItem"].includes(item.type) ||
          item.children.length !== 2
        )
          throw Error("YAML_MAPPING_UNSUPPORTED");
        const key = safeKey(decode(item.children[0]));
        const value = decode(item.children[1]);
        if (key === "<<")
          merges.push(...(Array.isArray(value) ? value : [value]));
        else {
          if (Object.hasOwn(own, key)) throw Error("YAML_DUPLICATE_KEY:" + key);
          own[key] = value;
        }
      }
      if (merges.some((m) => !object(m))) throw Error("YAML_MERGE_INVALID");
      result = Object.assign(Object.create(null), ...merges.toReversed(), own);
    } else if (["sequence", "flowSequence"].includes(n.type))
      result = n.children.map(decode);
    else if (n.type === "alias") {
      if (!anchors.has(n.value)) throw Error("YAML_ALIAS_UNRESOLVED");
      result = structuredClone(anchors.get(n.value));
    } else if (
      ["quoteDouble", "quoteSingle", "blockLiteral", "blockFolded"].includes(
        n.type,
      )
    )
      result = n.value;
    else if (n.type === "plain") {
      result = n.value;
      if (/^(true|false)$/i.test(result))
        result = result.toLowerCase() === "true";
      else if (/^(null|~)$/i.test(result)) result = null;
      else if (/^-?(0|[1-9][0-9]*)$/u.test(result)) result = Number(result);
    } else throw Error("YAML_NODE_UNSUPPORTED:" + n.type);
    if (n.anchor) {
      if (anchors.has(n.anchor.value)) throw Error("YAML_ANCHOR_DUPLICATE");
      anchors.set(n.anchor.value, result);
    }
    return result;
  }
  return decode(body);
}

function git(root, ...args) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
  );
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    LC_ALL: "C",
  });
  return execFileSync(
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
    { env, encoding: "utf8" },
  );
}

export async function taskCatalog(root) {
  root = fs.realpathSync(root);
  const head = git(root, "rev-parse", "HEAD").trim();
  const trackedRaw = git(root, "ls-files", "-z");
  const tracked = new Set(trackedRaw.split("\0").filter(Boolean));
  const tasks = new Map(),
    aliases = new Map(),
    implicitAliases = new Map(),
    sources = {},
    defaults = {},
    gaps = [];
  const sourcePath = (name) => {
    if (
      !name ||
      path.isAbsolute(name) ||
      name.split("/").includes("..") ||
      /[\x00-\x1f\\]/u.test(name)
    )
      throw Error("SOURCE_PATH_INVALID");
    const file = path.join(root, name);
    if (fs.realpathSync(file) !== file || !fs.lstatSync(file).isFile())
      throw Error("SOURCE_REDIRECT_REFUSED");
    return file;
  };
  const text = (name) => {
    if (!tracked.has(name)) throw Error("UNTRACKED_SOURCE_REFUSED:" + name);
    const value = fs.readFileSync(sourcePath(name), "utf8");
    sources[name] = sha(value);
    return value;
  };
  async function visit(relative, namespace, inheritedDirectory, stack) {
    if (stack.includes(relative)) throw Error("TASK_INCLUDE_CYCLE");
    const document = await decodeYaml(text(relative));
    if (!object(document) || String(document.version) !== "3")
      throw Error("TASK_DOCUMENT_UNSUPPORTED");
    defaults[relative] = {
      namespace,
      dir: document.dir ?? inheritedDirectory,
      variables: document.vars ?? {},
      environment: document.env ?? {},
      dotenv: document.dotenv ?? [],
      run: document.run ?? "always",
      includes: document.includes ?? {},
    };
    for (const [includeName, raw] of Object.entries(document.includes ?? {})) {
      const include = typeof raw === "string" ? { taskfile: raw } : raw;
      if (!object(include) || typeof include.taskfile !== "string")
        throw Error("TASK_INCLUDE_UNSUPPORTED");
      if (
        include.taskfile.includes("{{") ||
        /^(https?:|git:)/u.test(include.taskfile)
      ) {
        gaps.push({
          source: relative,
          kind: "DYNAMIC_OR_REMOTE_INCLUDE",
          value: include.taskfile,
        });
        continue;
      }
      const name = path.posix.normalize(
        path.posix.join(path.posix.dirname(relative), include.taskfile),
      );
      if (!tracked.has(name)) {
        gaps.push({
          source: relative,
          kind: include.optional
            ? "OPTIONAL_UNTRACKED_INCLUDE"
            : "MISSING_REQUIRED_INCLUDE",
          value: name,
        });
        continue;
      }
      if (include.aliases)
        gaps.push({
          source: relative,
          kind: "INCLUDE_ALIAS_REQUIRES_RECONCILIATION",
          value: include.aliases,
        });
      if (include.excludes?.length)
        gaps.push({
          source: relative,
          kind: "INCLUDE_EXCLUSION_REQUIRES_RECONCILIATION",
          value: include.excludes,
        });
      await visit(
        name,
        include.flatten ? namespace : namespace + includeName + ":",
        include.dir ?? inheritedDirectory,
        [...stack, relative],
      );
    }
    for (const [name, raw] of Object.entries(document.tasks ?? {})) {
      const task = typeof raw === "string" ? { cmds: [raw] } : raw;
      if (!object(task)) throw Error("TASK_BODY_UNSUPPORTED");
      const id = namespace + name;
      if (tasks.has(id)) throw Error("TASK_DUPLICATE:" + id);
      if (task.aliases && !Array.isArray(task.aliases))
        throw Error("TASK_ALIASES_UNSUPPORTED");
      const record = {
        id,
        source: relative,
        namespace,
        dir: task.dir ?? document.dir ?? inheritedDirectory,
        aliases: task.aliases ?? [],
        deps: task.deps ?? [],
        commands: task.cmds ?? [],
        guards: {
          preconditions: task.preconditions ?? [],
          requires: task.requires ?? null,
          status: task.status ?? [],
          platforms: task.platforms ?? [],
        },
        variables: task.vars ?? {},
        environment: task.env ?? {},
        run: task.run ?? document.run ?? "always",
        internal: task.internal ?? false,
        effects: "NEEDS_SEMANTIC_AUDIT",
        resources: "NEEDS_SEMANTIC_AUDIT",
        timeout: task.timeout ?? null,
      };
      tasks.set(id, record);
      if (name === "default" && namespace)
        implicitAliases.set(namespace.slice(0, -1), id);
      for (const alias of record.aliases) {
        const key = namespace + alias;
        if (aliases.has(key)) throw Error("TASK_ALIAS_DUPLICATE:" + key);
        aliases.set(key, id);
      }
    }
  }
  await visit("Taskfile.yml", "", ".", []);
  for (const alias of aliases.keys())
    if (tasks.has(alias)) throw Error("TASK_ALIAS_COLLISION:" + alias);
  const edges = [],
    opaque = [];
  const resolve = (target, task) => {
    if (typeof target !== "string" || target.includes("{{")) return null;
    const name = target.startsWith(":")
      ? target.slice(1)
      : task.namespace + target;
    return tasks.has(name)
      ? name
      : (aliases.get(name) ?? implicitAliases.get(name) ?? null);
  };
  for (const task of tasks.values()) {
    for (const [kind, items] of [
      ["parallel-dependency", task.deps],
      ["ordered-command", task.commands],
    ]) {
      if (!Array.isArray(items)) throw Error("TASK_CALL_LIST_UNSUPPORTED");
      items.forEach((item, sequence) => {
        const deferred = object(item) && object(item.defer) ? item.defer : null;
        const target = object(item)
          ? (item.task ?? deferred?.task)
          : kind === "parallel-dependency"
            ? item
            : null;
        if (target !== null && target !== undefined) {
          const resolved = resolve(target, task);
          edges.push({
            from: task.id,
            target,
            resolved,
            kind: deferred ? "deferred-task" : kind,
            sequence,
            vars: object(item) ? ((deferred ?? item).vars ?? {}) : {},
            modifiers: object(item) ? item : {},
          });
          if (!resolved)
            gaps.push({
              source: task.source,
              task: task.id,
              kind: "TASK_TARGET_UNRESOLVED",
              value: target,
            });
        } else {
          const command =
            typeof item === "string" ? item : (item.cmd ?? item.defer);
          opaque.push({
            task: task.id,
            source: task.source,
            sequence,
            command,
            modifiers: object(item) ? item : {},
            resolution: "SHELL_NOT_EXECUTED",
          });
        }
      });
    }
  }
  const scripts = [];
  for (const file of [...tracked]
    .filter((p) => path.posix.basename(p) === "package.json")
    .sort()) {
    const document = JSON.parse(text(file));
    for (const [name, command] of Object.entries(document.scripts ?? {}))
      scripts.push({
        id: file + "#" + name,
        file,
        dir: path.posix.dirname(file),
        name,
        command,
      });
  }
  if (git(root, "rev-parse", "HEAD").trim() !== head)
    throw Error("CATALOG_SOURCE_CHANGED");
  for (const [file, digest] of Object.entries(sources))
    if (sha(fs.readFileSync(sourcePath(file))) !== digest)
      throw Error("CATALOG_SOURCE_CHANGED");
  if (git(root, "ls-files", "-z") !== trackedRaw)
    throw Error("CATALOG_INDEX_CHANGED");
  return {
    schema: 1,
    kind: "data-only-command-catalog",
    acceptance: false,
    executionAllowed: false,
    status: gaps.length ? "NEEDS_REVIEW" : "CATALOGED",
    root,
    head,
    workingMetadataSourceSha256: sha(JSON.stringify(sources)),
    sources,
    defaults,
    tasks: [...tasks.values()],
    aliases: Object.fromEntries(aliases),
    implicitAliases: Object.fromEntries(implicitAliases),
    edges,
    shellCallSites: opaque,
    npmScripts: scripts,
    gaps,
    limits: [
      "No variable, shell, condition or task evaluation",
      "Shell and script process/resource semantics require explicit audit",
      "No CI/test PASS follows from successful parsing",
    ],
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const root = process.argv[2];
  if (process.argv.length !== 3)
    throw Error("ONE_EXPLICIT_REPOSITORY_REQUIRED");
  process.stdout.write(JSON.stringify(await taskCatalog(root), null, 2) + "\n");
}
