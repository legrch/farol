# Design-lab font provenance

These fonts are used only by the nonshipping design lab, and only by the Watch Rail direction's
type study. Every file is an unmodified copy from the npm registry package named below, fetched on
2026-09-15 with `npm pack`, which verified the registry integrity hash. Each family is licensed
under the SIL Open Font License 1.1; the license travels with the files. The CSS gives them local
aliases (`Farol Geist`, `Farol Plex Sans`, and so on) without modifying the font software.
No system font file is copied.

| File                                            | Package                                     | Integrity of the package tarball                                                                  | SHA-256 of the file                                                |
| ----------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `geist/Geist-Variable.woff2`                    | `geist@1.7.2` (`dist/fonts/geist-sans`)     | `sha512-Gu5lDFa3pLRyoBlBPf0QIFHVdWAnpco7fS1bJm41jyLPFoguBgiubseUN2oLXMgqZ7uxAxDoXcHMhCY/fOTTgg==` | `a369fcf5628ea2aa4e1b9e2ec6a5b3624e365bda588e1f0f2f12b564f728fbb8` |
| `geist/GeistMono-Variable.woff2`                | `geist@1.7.2` (`dist/fonts/geist-mono`)     | same tarball                                                                                      | `fba8f577f38a2bbcbe818efa6348dd58f36303a10b8737c42fefad275be563ab` |
| `geist/OFL.txt`                                 | `geist@1.7.2` (`LICENSE.txt`)               | same tarball                                                                                      | `930853ee1daa68554d9e35c8a9175affb74f699fad9a5da6ee5ebe76379d9137` |
| `ibm-plex/ibm-plex-sans-latin-400-normal.woff2` | `@fontsource/ibm-plex-sans@5.3.0` (`files`) | `sha512-CbE4CbbEEZJX860XyUiRpsksXIQR8Rp2XDva2VO53NJox9tVNtusrysd2x5YkUEY3ErQ66W1IiiQL8/wihhw5w==` | `3b646991d30055a93a4ecc499713d4347953a74a947ecab435ab72070cbdab0e` |
| `ibm-plex/ibm-plex-sans-latin-500-normal.woff2` | same package                                | same tarball                                                                                      | `0717336fb31fcdcde4b8deb3675bb4a0f7f6d484864afcd6751ac29975962203` |
| `ibm-plex/ibm-plex-sans-latin-600-normal.woff2` | same package                                | same tarball                                                                                      | `8960851d691c054ed38e259bdcf1a6190d157b4203ed5bb32c632a863fb8ec2f` |
| `ibm-plex/OFL-IBM-Plex-Sans.txt`                | same package (`LICENSE`)                    | same tarball                                                                                      | `d0283623ef57e722fd0eb688a8041589670c608ab780cd3612d06ba6f153d3fd` |
| `ibm-plex/ibm-plex-mono-latin-400-normal.woff2` | `@fontsource/ibm-plex-mono@5.3.0` (`files`) | `sha512-eTgnZjZEGk1QtD3ZstF+Vclo2HLAni8YMy34/DxllwZvyz1lR/1RF/xTiAquOBO7MvqBx8D2Ig2WCPMVfdZu7Q==` | `08949f728dc52d528e69b1667d15c89a5686a4ee9a296ff90983985f99c380f7` |
| `ibm-plex/ibm-plex-mono-latin-500-normal.woff2` | same package                                | same tarball                                                                                      | `01d285447409c8a588692162439a038b8cbd7871309ee20267b0d2d91c6e8e22` |
| `ibm-plex/OFL-IBM-Plex-Mono.txt`                | same package (`LICENSE`)                    | same tarball                                                                                      | `23b0a9d0c6d3f140a0b77e483c5cfa6bba574325ef5cb189ed9f2fec4884533f` |

Upstream projects: Geist by Vercel with basement.studio (`github.com/vercel/geist-font`); IBM Plex
by IBM, packaged by Fontsource (`github.com/fontsource/font-files`). The IBM Plex files are the
Latin subset only, which covers the lab's English interface; other scripts fall back to the system
font.

The IBM Plex files here are the Latin subset. Geist's coverage beyond Latin is not verified in
this lab. Labels outside a bundled face's coverage fall back to the system font.

Production use is not decided. Adopting any of these families in the product needs the owner's
visual decision and the same licence notice in the shipped application.
