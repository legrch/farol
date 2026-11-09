// Guest-side admission for the actual Runner.stage_driver manifest. The pure
// validateStagedDriver function is also exercised with a test filesystem adapter.
// JXA uses only fixed macOS utilities, NEVER the staged Node being verified.
function driverRequire(condition, code) {
  if (!condition) throw Error(code);
}

function driverKeys(value, keys, code) {
  driverRequire(value !== null && typeof value === "object" && !Array.isArray(value), code);
  driverRequire(Object.keys(value).sort().join(",") === keys.slice().sort().join(","), code);
}

function validateDriverManifest(value) {
  driverKeys(value, ["schema", "tool", "entry", "bundler", "bundle", "node", "staged"], "DRIVER_MANIFEST_FIELDS_INVALID");
  driverRequire(value.schema === "farol.vm-e2e.driver-manifest/1" &&
    value.tool === "farol.vm-e2e/1" && value.staged === true, "DRIVER_MANIFEST_SCHEMA_INVALID");
  driverRequire(typeof value.entry === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(?:mjs|js)$/.test(value.entry) &&
    (value.bundler === "inline" || value.bundler === "esbuild"), "DRIVER_MANIFEST_ENTRY_INVALID");
  driverKeys(value.bundle, ["file", "bytes", "sha256"], "DRIVER_BUNDLE_FIELDS_INVALID");
  driverKeys(value.node, ["path", "size", "sha256"], "DRIVER_NODE_FIELDS_INVALID");
  driverRequire(value.bundle.file === "driver.bundle.mjs" && value.node.path === "node", "DRIVER_STAGED_PATH_INVALID");
  [value.bundle.sha256, value.node.sha256].forEach(function (hash) {
    driverRequire(typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash), "DRIVER_DIGEST_INVALID");
  });
  [value.bundle.bytes, value.node.size].forEach(function (size) {
    driverRequire(Number.isSafeInteger(size) && size > 0 && size <= 2 * 1024 * 1024 * 1024, "DRIVER_SIZE_INVALID");
  });
  return value;
}

function driverRegular(info, limit) {
  driverRequire((info.mode & 0o170000) === 0o100000 && info.links === 1 &&
    Number.isSafeInteger(info.size) && info.size > 0 && info.size <= limit, "DRIVER_FILE_UNSAFE");
}

function driverUnchanged(before, after) {
  ["mode", "links", "size", "device", "inode", "modified", "changed"].forEach(function (key) {
    driverRequire(before[key] === after[key], "DRIVER_FILE_CHANGED");
  });
}

function validateStagedDriver(stage, io) {
  const directory = io.stat(stage);
  driverRequire((directory.mode & 0o170000) === 0o040000, "DRIVER_STAGE_UNSAFE");
  const manifestPath = stage + "/driver.manifest.json";
  const before = io.stat(manifestPath);
  driverRegular(before, 65536);
  const value = validateDriverManifest(JSON.parse(io.read(manifestPath, 65536)));
  driverUnchanged(before, io.stat(manifestPath));
  [["driver.bundle.mjs", value.bundle.bytes, value.bundle.sha256],
    ["node", value.node.size, value.node.sha256]].forEach(function (item) {
    const file = stage + "/" + item[0];
    const info = io.stat(file);
    driverRegular(info, 2 * 1024 * 1024 * 1024);
    driverRequire(info.size === item[1], "DRIVER_SIZE_MISMATCH");
    if (item[0] === "node") driverRequire((info.mode & 0o111) !== 0, "DRIVER_NODE_NOT_EXECUTABLE");
    driverRequire(io.sha256(file) === item[2], "DRIVER_DIGEST_MISMATCH");
    driverUnchanged(info, io.stat(file));
  });
  return value;
}

// Only osascript calls run. Loading this file for a pure test has no OS effects.
function run(argv) {
  driverRequire(argv.length === 1, "DRIVER_STAGE_ARGUMENT_REQUIRED");
  ObjC.import("Foundation");
  function command(binary, args) {
    const task = $.NSTask.alloc.init;
    const output = $.NSPipe.pipe;
    task.launchPath = binary;
    task.arguments = args;
    task.environment = { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C" };
    task.standardOutput = output;
    task.standardError = $.NSFileHandle.fileHandleWithNullDevice;
    task.launch;
    const bytes = output.fileHandleForReading.readDataToEndOfFile;
    task.waitUntilExit;
    driverRequire(task.terminationStatus === 0, "DRIVER_SYSTEM_CHECK_FAILED");
    return $.NSString.alloc.initWithDataEncoding(bytes, $.NSUTF8StringEncoding).js.trim();
  }
  const io = {
    stat: function (file) {
      // stat's default is lstat, not -L: reject links before reading any payload.
      const fields = command("/usr/bin/stat", ["-f", "%p:%l:%z:%d:%i:%m:%c", file]).split(":");
      driverRequire(fields.length === 7 && fields.every(function (x) { return /^\d+$/.test(x); }), "DRIVER_STAT_INVALID");
      return { mode: parseInt(fields[0], 8), links: Number(fields[1]), size: Number(fields[2]),
        device: fields[3], inode: fields[4], modified: fields[5], changed: fields[6] };
    },
    read: function (file, limit) {
      const handle = $.NSFileHandle.fileHandleForReadingAtPath(file);
      driverRequire(handle && !handle.isNil(), "DRIVER_MANIFEST_UNREADABLE");
      try {
        const data = handle.readDataOfLength(limit + 1);
        driverRequire(Number(data.length) <= limit, "DRIVER_MANIFEST_TOO_LARGE");
        const text = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
        driverRequire(typeof text === "string", "DRIVER_MANIFEST_ENCODING_INVALID");
        return text;
      } finally { handle.closeFile; }
    },
    sha256: function (file) {
      const output = command("/usr/bin/shasum", ["-a", "256", file]);
      driverRequire(/^[a-f0-9]{64}\s/.test(output), "DRIVER_HASH_OUTPUT_INVALID");
      return output.slice(0, 64);
    },
  };
  validateStagedDriver(argv[0], io);
  return "VERIFIED";
}
