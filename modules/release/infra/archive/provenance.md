# Archive source transfer

This unwired package transfers only the archive files leased by the integration
owner from frozen source `a47c9ccea1a00eb210f675f71a0690fc3be6c857`. The complete old release range
is not incorporated or accepted by this transfer. Existing resource consumers,
root module, command dispatcher, build attestation and retirement remain with
Core/Lead. The previous updater stays on its existing route until integrated parity.

The mechanical changes are the package name (`archive`), explicit platform build
tags/short filenames, and the Python development oracle lookup. Algorithms and
regression vectors are retained. The oracle stays at its existing repository path
until Lead transfers that source; executing it is required to claim differential
parity, even though the retained optional-oracle tests can skip when unavailable.

| Frozen source                                                    | Destination         | Original source SHA-256                                            |
| ---------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------ |
| `resources/native/go/internal/releasearchive/archive.go`         | `archive.go`        | `c88aa827158002115bc049a1093d82f4ebfe70f7f52feffcf104ed16fd716fed` |
| `resources/native/go/internal/releasearchive/archive_test.go`    | `archive_test.go`   | `2231696f7c0afb6b293630849701766aa938abac515c60c6e5492decd812ff2f` |
| `resources/native/go/internal/releasearchive/directory.go`       | `directory.go`      | `47fcdeb44d819f95c1c4e8dd18cdde6ff3a87647fedb73b69e48b5a7aeaaa8c9` |
| `resources/native/go/internal/releasearchive/directory_test.go`  | `directory_test.go` | `917bfbf8062b955d3676088f9ad737de3b44b1ddfe66908684e4995a7c827e31` |
| `resources/native/go/internal/releasearchive/identity_darwin.go` | `darwin.go`         | `d5c32eeb632e8adc1dc91effa3a2b4427f39e9f99602e5e9c0f813e772a9ca0e` |
| `resources/native/go/internal/releasearchive/identity_linux.go`  | `linux.go`          | `5cdc1d004d9f2ca2eac008519f37633b073b8f412a8eb9b9968f4ab2e3c77ac5` |
| `resources/native/go/internal/releasearchive/parity_test.go`     | `parity_test.go`    | `b282408b16dc9dee12aaef8b649e3a6bba2bdf05f8c8d7eddd9cc32b0e59d104` |
| `resources/native/go/internal/releasearchive/plan.go`            | `plan.go`           | `411e4759932a686201d067079e7ad0bcec960291be2a33b9fdee874b0e15032c` |
| `resources/native/go/internal/releasearchive/stage.go`           | `stage.go`          | `36d9ee544dfc30c64b630504ef5614a4fc7193088bacb23809a4ee6098d51f5f` |

Retained dependency baseline: Go `1.26.2`, `golang.org/x/text v0.28.0` and its
checksums from the frozen native module. Notices are copied byte for byte. No
nested Release module or independent CLI is introduced. The old command's four
argv/JSON/refusal vectors remain a Core dispatcher integration requirement.

`Run` still owns bounded extraction/staging only. It proves neither complete
package verification nor first-install/update admission. Package/import/root
command changes require a freshly measured executable digest and matching pins;
the old compiled digest is not transferred as a promise about new bytes.
