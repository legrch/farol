import { createHash } from "node:crypto";
import path from "node:path";
import { BridgeError } from "./client.ts";
import { bindShellSupportDeclaration } from "./shell-support.ts";

export interface ShellLaunchHost {
  readonly profileId: string;
  readonly hostLifetimeId: string;
  readonly childLaunchId: string;
  // The host must separately qualify this exact app bundle and its full bytes.
  readonly appRoot: Readonly<{ path: string; device: string; inode: string }>;
  readonly watchdogSource: Uint8Array;
}

// Pure projection of already trusted host selections. Equality is not an issuer
// and this encoder performs no filesystem/package/platform qualification. Its
// bytes are delivered only to the attested child's private inherited descriptor.
export function encodeShellLaunch(
  actual: unknown,
  independentlyTrustedExpected: unknown,
  expectedCore: unknown,
  host: ShellLaunchHost,
): Uint8Array {
  const refuse = (): never => {
    throw new BridgeError("refused", "invalid_shell_launch_metadata");
  };
  const support = bindShellSupportDeclaration(
    actual,
    independentlyTrustedExpected,
    expectedCore,
  );
  const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u;
  for (const value of [host.profileId, host.hostLifetimeId, host.childLaunchId])
    if (typeof value !== "string" || id.exec(value)?.[0] !== value) refuse();
  const root = host.appRoot.path;
  if (
    typeof root !== "string" ||
    root.length > 4096 ||
    root === "/" ||
    !path.isAbsolute(root) ||
    path.resolve(root) !== root ||
    /[\u0000-\u001f\u007f-\u009f\\:]/u.test(root)
  )
    refuse();
  for (const value of [host.appRoot.device, host.appRoot.inode])
    if (
      typeof value !== "string" ||
      /^[1-9][0-9]{0,19}$/u.exec(value)?.[0] !== value ||
      BigInt(value) > 18446744073709551615n
    )
      refuse();
  if (
    !(host.watchdogSource instanceof Uint8Array) ||
    host.watchdogSource.byteLength === 0 ||
    host.watchdogSource.byteLength > 64 * 1024
  )
    refuse();
  const source = Buffer.from(host.watchdogSource);
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(source);
  } catch {
    refuse();
  }
  if (
    createHash("sha256").update(source).digest("hex") !==
    support.watchdog.sourceSHA256
  )
    refuse();
  const pin = (value: Readonly<{ path: string; sha256: string }>) => ({
    Path: value.path,
    SHA256: value.sha256,
  });
  const bytes = Buffer.from(
    JSON.stringify({
      Schema: "farol-shell-launch/1",
      BuildID: support.core.build.buildId,
      ProfileID: host.profileId,
      HostLifetimeID: host.hostLifetimeId,
      ChildLaunchID: host.childLaunchId,
      Support: {
        ReleaseID: support.qualification.releaseId,
        QualificationSHA256: support.qualification.sha256,
        CompilerSHA256: support.qualification.compilerSHA256,
        OS: support.core.build.platform.goos,
        OSBuild: support.qualification.osBuild,
        Architecture: support.core.build.platform.goarch,
        Compiler: support.qualification.compiler,
        FilesystemClass: support.qualification.filesystemClass,
        HostTrust: support.qualification.hostTrust,
        Backend: {
          Path: path.join(root, "Contents/Resources/app/farol-backend"),
          SHA256: support.core.binary.sha256,
        },
        Watchdog: {
          Path: path.join(root, support.watchdog.relativePath),
          SHA256: support.watchdog.sha256,
        },
        Mechanism: pin(support.mechanism),
        WatchdogSourceSHA256: support.watchdog.sourceSHA256,
        Imports: support.imports.map(pin),
        Executables: support.executables.map(pin),
        ...(support.gitRuntimeResources
          ? {
              GitRuntimeResources: {
                Git: pin(support.gitRuntimeResources.git),
                Files: support.gitRuntimeResources.files.map(pin),
                ...(support.gitRuntimeResources.python
                  ? {
                      Python: {
                        Files:
                          support.gitRuntimeResources.python.files.map(pin),
                        Directories:
                          support.gitRuntimeResources.python.directories.map(
                            (d) => ({ Path: d.path, Entries: [...d.entries] }),
                          ),
                      },
                    }
                  : {}),
                Directories: support.gitRuntimeResources.directories.map(
                  (d) => ({ Path: d.path, Entries: [...d.entries] }),
                ),
              },
            }
          : {}),
        ProtectedBundle: {
          Path: root,
          Identity: {
            Device: host.appRoot.device,
            Inode: host.appRoot.inode,
          },
        },
      },
      WatchdogSourceBase64: source.toString("base64"),
    }),
  );
  if (bytes.length > 256 * 1024) refuse();
  return bytes;
}
