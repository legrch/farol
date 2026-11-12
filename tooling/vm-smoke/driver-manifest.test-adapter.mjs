// Test-only filesystem adapter for the actual guest validation logic. No shell,
// guest, network, app, or staged executable is run. The pre-fix branch evaluates
// guest.sh's actual embedded read_field expression to preserve a behavioral RED.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import vm from "node:vm";

const stage = process.argv[2];
const source = fs.readFileSync(path.join(stage, "guest.sh"), "utf8");
const io = {
  stat(file) {
    const s = fs.lstatSync(file);
    return {
      mode: s.mode,
      links: s.nlink,
      size: s.size,
      device: s.dev,
      inode: s.ino,
      modified: s.mtimeMs,
      changed: s.ctimeMs,
    };
  },
  read(file, limit) {
    const fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    try {
      const b = Buffer.alloc(limit + 1);
      const size = fs.readSync(fd, b, 0, b.length, 0);
      if (size > limit) throw Error("MANIFEST_TOO_LARGE");
      return b.subarray(0, size).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  },
  sha256(file) {
    return crypto
      .createHash("sha256")
      .update(fs.readFileSync(file))
      .digest("hex");
  },
};
let launches = 0;
let error = null;
let consumer;
try {
  const invocation =
    '/usr/bin/osascript -l JavaScript "$stage/driver-manifest.js" "$stage"';
  if (source.includes(invocation)) {
    const validation = source.indexOf(invocation);
    const launch = source.indexOf('"$node_bin" "$bundle"', validation);
    if (launch < validation) throw Error("VALIDATION_NOT_BEFORE_LAUNCH");
    const context = vm.createContext({});
    vm.runInContext(
      fs.readFileSync(path.join(stage, "driver-manifest.js"), "utf8"),
      context,
    );
    context.validateStagedDriver(stage, io);
    consumer = "production-driver-manifest.js";
  } else {
    consumer = "production-legacy-read_field";
    const phase = source.slice(source.indexOf("  e2e)"));
    const expression =
      /read_field\(\) \{ \/usr\/bin\/osascript -l JavaScript -e '([^']+)'/.exec(
        phase,
      )?.[1];
    const fields = [
      ...phase.matchAll(/read_field "\$manifest" ([a-z0-9_]+)/g),
    ].map((m) => m[1]);
    if (!expression || fields.length !== 2)
      throw Error("UNSUPPORTED_GUEST_CONSUMER");
    const context = vm.createContext({
      ObjC: { import() {} },
      $: {
        NSString: {
          stringWithContentsOfFileEncodingError: (file) => ({
            js: io.read(file, 65536),
          }),
        },
      },
    });
    vm.runInContext(expression, context);
    for (const [i, file] of ["driver.bundle.mjs", "node"].entries()) {
      if (
        io.sha256(path.join(stage, file)) !==
        context.run([path.join(stage, "driver.manifest.json"), fields[i]])
      ) {
        throw Error("LEGACY_DIGEST_MISMATCH");
      }
    }
  }
  // Only a spy follows validation. Never execute the staged Node or bundle.
  launches += 1;
} catch (caught) {
  error = String(caught.message ?? caught);
}
process.stdout.write(JSON.stringify({ launches, error, consumer }) + "\n");
