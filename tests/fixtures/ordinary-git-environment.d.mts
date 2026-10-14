/** Test-only reference fixture. Does not grant product workspace authority. */
export interface GitFixtureResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}
export interface OrdinaryGitEnvironment {
  readonly root: string;
  readonly home: string;
  readonly repository: string;
  readonly writer: string;
  readonly scratch: string;
  readonly canary: string;
  readonly gitDirectory: string;
  readonly commonDirectory: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly expected: Readonly<Record<string, string>>;
  runGit(
    args: string[],
    options?: { cwd?: string; env?: Readonly<Record<string, string>> },
  ): GitFixtureResult;
  mustGit(
    args: string[],
    options?: { cwd?: string; env?: Readonly<Record<string, string>> },
  ): GitFixtureResult;
  dispose(): Promise<void>;
}
export function createOrdinaryGitEnvironment(options?: {
  parent?: string;
  managedWriter?: boolean;
}): Promise<OrdinaryGitEnvironment>;
