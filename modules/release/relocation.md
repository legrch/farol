# Archive relocation plan

This map was inspected against active archive-owner commit
`a47c9ccea1a00eb210f675f71a0690fc3be6c857`. That observed commit is not an
ownership transfer or an accepted source base. Before execution, Lead must name
the accepted archive range, remaining findings/unknown operations and exact
transferred source paths. Core K0 must supply the root module/entry contract.

## Owned destination

| Existing source under `resources/native/go`                  | Release destination                                                     |
| ------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `internal/releasearchive/{archive,directory,plan,stage}.go`  | `modules/release/infra/archive/`, same filenames, `package archive`     |
| `internal/releasearchive/{archive,directory,parity}_test.go` | Same package; retain all assertions/cases                               |
| `internal/releasearchive/identity_darwin.go`                 | `modules/release/infra/archive/darwin.go`, explicit `//go:build darwin` |
| `internal/releasearchive/identity_linux.go`                  | `modules/release/infra/archive/linux.go`, explicit `//go:build linux`   |
| `THIRD_PARTY_NOTICES.txt`                                    | `modules/release/infra/archive/THIRD_PARTY_NOTICES.txt`                 |

The development Python oracle moves from `resources/native/update_archive.py` to
`modules/release/infra/archive/testdata/update_archive.py`. Go parity changes only
its lookup to that path. JS oracle regressions retain the same cases. The oracle
must actually run in the parity gate; the current optional-oracle `t.Skip` is not
evidence of Python/Go parity.

`go.mod`/`go.sum` merge into the Core-owned root module
`github.com/legrch/farol`, retaining Go `1.26.2` and `golang.org/x/text v0.28.0`
until Core accepts another dependency baseline. Do not create a nested Release
module. Importing the moved package uses
`github.com/legrch/farol/modules/release/infra/archive`.

The current `cmd/update-archive/{main.go,main_test.go}` supplies the exact CLI
behavior vectors. Core extracts its protocol-only wiring into the accepted root
`cmd/farol` dispatcher/boot adapter. The final mode/argv and exact boot file are
pending Core acceptance; this map creates no second executable or private command
protocol. Until that accepted consumer exists, the old active extractor stays in
place. Release can supply the moved `Run`/`Code` implementation independently.

## Compatibility freeze

- The archive consumer currently passes four positional arguments: archive,
  private stage, decimal size and lowercase SHA-256. Success emits only bounded
  JSON `{appPath, artifactPath}`. Refusal exits `1` with
  `ARCHIVE_REFUSED:<classified code>`; arbitrary OS/decompressor text remains
  `ARCHIVE_IO_FAILED`. Preserve Unicode decimal admission, not an ASCII-only port.
- Packaged output remains `update-archive.py`, with private bootstrap
  `.update_archive.py`, executable mode `0700` and direct native execution. These
  historical filenames do not make Python a runtime dependency.
- Retain admission before ZIP entry allocation, central/local header and data
  descriptor checks, CRC including zero CRC, CP437/UTF-8, unrestricted NFD/full
  casefold, symlink containment and no-follow descriptor identities. Cleanup can
  undo only owned inodes; unknown physical cleanup remains an obligation.
- Retain 2 GiB archive, 1 GiB expanded, 16 MiB central-directory, 100,000 tree/entry
  budget, non-ZIP64 single-volume policy, 128 path components, 4096-byte links and
  `max(compressed * 100, 1 MiB)` expansion ratio. The classic ZIP count admission
  is below the ZIP64 marker. Preserve 1..8 MiB helper, 2..65,536-byte artifact,
  checked-size-plus-sentinel reads, refusal at two abandoned stages or over 1024
  parent entries, and 600,000 ms / 8192-byte subprocess bounds.
- Keep both extractor app-generation cases. Current branded installed verifier
  admits schema 6 / `Farol.app`; historical published package schemas and receipts
  are not rewritten. Identity owns the coordinated final identity change.

## Shared patches requiring named ownership

| Owner     | Exact source seam                                                                                                                                                                                     |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core      | Root `go.mod`, `go.sum`; command/boot routing and platform-selection tests                                                                                                                            |
| Lead      | Retirement of `resources/native/go/**` and old oracle source, only after accepted transfer/parity                                                                                                     |
| Core/Lead | `tooling/native-archive-build.mjs`: root build cwd/entry, explicit bounded source/dependency closure and new binary attestation                                                                       |
| Core/Lead | `tooling/package.mjs`: notices source path; build resource/manifest integration                                                                                                                       |
| Lead      | `src/modules/release/infra/native/update-package-verifier.ts`: matching measured binary pin and accepted argv                                                                                         |
| Lead/Core | `tests/support/native-archive-fixture.mjs`, `tests/integration/update-archive.test.mjs`, `tests/integration/update-package-resource-types.test.mjs`: moved oracle/entry/pin and explicit Go discovery |
| Lead      | `src/apps/desktop/installed-update-runtime.ts`, `tests/integration/installed-update-runtime.test.ts`, `tests/e2e/update-stage-cleanup.e2e.mjs`: only the accepted consumer seam when changed          |
| Lead      | `docs/update-package-verifier.md`: active source/command references                                                                                                                                   |

No shared patch is applied by this preparation. The current TS verifier stays at
its original source path; moving an adapter into a Go subtree would not migrate
its behavior. Its later removal needs full Go package verification and native
physical-ASAR parity, not archive extraction alone.

## Byte identity and deletion exits

Package/import paths, platform filenames, the root module and entrypoint change
compiler inputs. Preserve algorithms while measuring/attesting new executable
bytes; do not promise the old binary digest. The observed old pin is
`0f60969f4acbaf57d2c628c69412f4f81f227a94e1d27c60d36356fe8ed9d4c7`.
Update build/runtime pins together only after independent review and measured
compiler/source/dependency identity. Keep the existing offline, readonly,
trimpath/build-ID and physical resource guards fail closed. Root source collection
must use a bounded closure, not recursively collect the whole repository.

Required transfer checks: mechanical diff and retained tests; root Go archive/CLI
suite; explicit Darwin/Linux file selection; Darwin disposable native archive and
executed Python differential oracle; archive/resource/consumer regressions;
`task ci:fast`; `git diff --check`; clean committed package and exact package
verification by the owner of that lane. While the old nested module remains,
explicitly run both Go suites. Linux compilation is not Darwin filesystem proof.

Lead accepts the exact integrated SHA before source retirement. Update state,
install/swap Python, recovery/restore intents, browser/native work admission and
current-alpha migration each retain their separate parity/deletion exit. No
installed mutation, publication or replay of an unknown operation is implied.
