import type {
  InstalledUpdateRelaunchOptions,
  waitForInstalledUpdateRelaunch,
} from "../../../src/apps/desktop/installed-update-runtime";

// The installed-update relaunch observation that main hands the startup fence:
// the wait over the launch arguments, with the physical copier an update uses
// to place the app. The copy refuses to overwrite and keeps symlinks and
// timestamps verbatim. The user-data path is read each time the observation
// runs, as main read it inside its own thunk. Nothing here retries.

export type UpdateRelaunchPorts = Readonly<{
  wait: typeof waitForInstalledUpdateRelaunch;
  args: readonly string[];
  directory: string;
  userData: () => string;
  build: InstalledUpdateRelaunchOptions["build"];
  files: NonNullable<InstalledUpdateRelaunchOptions["physicalFiles"]>;
}>;

export function createUpdateRelaunchObserver(
  ports: UpdateRelaunchPorts,
): () => ReturnType<typeof waitForInstalledUpdateRelaunch> {
  return () =>
    ports.wait({
      args: ports.args,
      directory: ports.directory,
      userData: ports.userData(),
      build: ports.build,
      physicalFiles: ports.files,
      copyApp: (source, destination) =>
        ports.files.cp(source, destination, {
          recursive: true,
          force: false,
          errorOnExist: true,
          verbatimSymlinks: true,
          preserveTimestamps: true,
        }),
    });
}
