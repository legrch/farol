# Pinned model/context consumer witness

This closes the missing **controlled I6 composition** witness. It does not wire
shipping boot or import another feature into the inference branch. All producer
code is assembled in a new disposable directory outside the product checkout.

Production sources actually invoked:

- MODELS `3b8aaff57ae3599e01e8edad1a7a71cd6daf5cd9`, tree
  `2a4923dafc4b4dacf21d079651843ee28d861a09`: `catalogue.Cache` and
  `modelselection.Resolve/RecheckBeforeStart`.
- CONTEXT `6d459925fc02c14b761fa3d1001038cf007be402`, tree
  `901ce3477f1f60e5002e9d3eff21c38a048ace60`:
  `contextcheckpoint.New/Prepare/Materialize`, including actual bounded selection
  and source hashing.
- INFERENCE: actual `inference.Service`, private `accountapproval.Grant`,
  `planresponses.ConsentFence`, operation deadline and public Responses
  builder/parser. Its production bytes remain those of
  `37a76f39d7ad94a3e1f27b438fa84d87fb985c3a`.

HTTP, current source/account, secret acquisition, journal and in-memory publication
ports are controlled. They contain only synthetic fixtures. Producer functions
are not mocked. Original source history is independent of the controlled response.

## Reproduce offline

Use clean task-owned source checkouts containing the exact commits above, the
declared Go 1.26.2 toolchain, and already available module/build caches. The script
does not clone, fetch, download modules or create a runner. `--output` must name
a new directory outside all three inputs; an existing receipt is never overwritten.

```sh
python3 docs/inference/consumerwitness.py \
  --inference-root /path/to/inference \
  --inference-ref FULL_TESTED_INFERENCE_COMMIT \
  --models-root /path/to/models \
  --context-root /path/to/context \
  --output /path/to/new-disposable-witness
```

`consumerpins.json` records the producer commits, trees and SHA-256 of all 32
selected public code/test/handoff files. Git lazy fetching is disabled. Only the
four specified producer code roots are overlaid in the disposable assembly, and
replacement of existing inference paths is refused. The fixture is copied there
as an external adapter test; no producer import exists in shipping inference code.

The resulting `manifest.json` hashes every assembled Go input, `go.mod`, `go.sum`,
the script, fixture and original test/vet logs. It records exact inference commit
and tree, producer pins, toolchain and offline settings. Ambient Go overlay,
modfile, workspace and persistent Go settings are disabled. Success requires all
nine declared witness tests to actually run and pass under race checking; an empty
test match fails. Targeted vet runs against the same assembly.

## Actual acceptance

The strengthened run passed nine top-level tests and 33 subcases. A 256-event
original history was bounded to 28 events, omitting 228 while preserving the old
mandatory UNKNOWN exchange and latest user intent. The actual HTTP request was
5,078 UTF-8 bytes, 5,015 code points and 1,672 estimated tokens, including stream
and reasoning fields. Canonical consumer input SHA-256:
`841a075477288cfaa99e2b722de89aa458ca48abd49c1c069030574c902f661c`.
The producer estimate is advisory; no provider token usage is claimed.

The exact committed witness source is
`bc7f3ee6bd401aad30b6948a572869314ab770ec`, tree
`4d1d1e33d4baaaffe02a144635a4ddaa86d2895b`. A frozen offline run against this
commit passed the same nine tests and 33 subcases. Its complete manifest SHA-256
is `1ac1abb27ed0bbd4aac90d68dda75852af1f8b8e0f08671d59403c42db055e61`.
[WITNESS-RECEIPT.json](WITNESS-RECEIPT.json) records the exact source, asset/input
hashes, original log hashes and tool settings. The final receipt commit changes
documentation only and preserves these tested executable bytes.

Tests establish:

- Exact chosen model and effort reach the actual builder; the ordered input
  round-trips from HTTP to the same canonical input hash. Actual emitted bytes,
  code points and estimate fit the declared context policy. No tools are granted.
- Required original call/result pairs, call IDs, arguments and quoted result bytes
  survive. Result prose saying “done” does not erase `source_outcome:"UNKNOWN"`,
  the original turn, tool operation or result identity. The complete UNKNOWN
  sidecar remains retained by its owner; pairing is not reconciliation.
- Account/catalogue/source changes before reserve, after reserve, after credential
  acquisition, during HTTP and before publication cannot rewrite the binding.
  Pre-HTTP changes refuse sending; post-HTTP changes suppress delivery while
  preserving original remote completion. Changing an omitted event without
  advancing revision is detected by the full original source digest. Advancing
  source revision with unchanged selected input also withdraws the original lease.
- A different checkpoint or changed input with a recomputed hash cannot obtain
  the captured operation's authority. A crossed producer model is rejected.
- Missing original results retain exact PENDING references and fail before
  inference admission. An explicit disappeared model, foreign account/route/API
  billing or missing independent text evidence never selects a fallback.
- A valid cached model list cannot override provider model/usage refusal or an
  unknown stream. No API-key route or replay occurs. A larger producer-fit window
  cannot override inference's 128-item bound or obtain silent trimming.

No production defect was demonstrated by this new witness. The targeted changes
are executable acceptance assets and explicit controlled mapping/fences.

The documentation secret scan initially flagged the already verified public
application commit SHA under a credential-labelled checkpoint. The label was
clarified; the original failed result is retained. No secret or scanner-policy
change was involved. The older historical fingerprint remains its previously
reviewed exact exception when scanning the complete authored range.

## Exact seam limits and requests

The witness retains incompatibilities instead of normalizing them:

| Producer value                                                               | Actual consumer outcome                                                                                                                                                                      | Narrow owner decision                                                                                                                           |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Original instruction materializes as `role:"system"`                         | Mapping refuses before inference; complete minimal producer JSON is in the test log.                                                                                                         | CONTEXT/composition owner must provide a preview-compatible original instruction role. No silent promotion to developer is supplied.            |
| Advertised effort `deliberate`                                               | Actual inference refuses `INFERENCE_INVALID` before admission.                                                                                                                               | MODELS/composition owner must intersect exact advertised effort with the current preview set; never choose a substitute after dispatch/refusal. |
| Absent advertised effort                                                     | MODELS resolves it; CONTEXT binding rejects an empty effort.                                                                                                                                 | Agree an explicit representation of absence; do not invent an effort.                                                                           |
| Typed message array                                                          | Exactly one original typed text part is mapped to the corresponding string; other shapes are refused.                                                                                        | Publish and review this limited mapping if shipping composition is desired.                                                                     |
| `call:63`, `observe/selected`, duplicate-key or unpaired-surrogate arguments | CONTEXT materializes unchanged; actual Responses adapter refuses before HTTP. One controlled credential acquisition and one original reservation have already occurred; neither is replayed. | A future pre-credential admission seam must apply the actual strict builder rules. These cases are not claimed to refuse before secret IO.      |
| Context windows above consumer limits                                        | Original input is refused, never trimmed by inference.                                                                                                                                       | Intersect item/encoded-byte bounds when selecting an owner-qualified window.                                                                    |

The controlled owner maps an opaque account scope to the digest of the complete
synthetic OAuth identity, and capability evidence to the digest of the complete
immutable model pin plus capabilities. These are explicit test mapping rules,
not accepted shipping account identifiers or grants. Catalogue epoch and OAuth
account epoch remain distinct. Full producer values remain beside these digests.

Shipping composition needs the **complete original inference Binding**, resolved
model pin/capabilities, exact context SourceRef and UNKNOWN references in one
owner-held lifetime. `ConsentFence` supplies the existing private account grant;
its selected-account port does not by itself compare ContextSelection. The witness
therefore adds a controlled Authority wrapper that compares the complete captured
Binding, and serializes current catalogue/source/account checks and the complete
publication callback. These checks cannot re-resolve an old operation into a new
selection or reacquire permission. A detached input hash or cache is insufficient.

No boot/schema/contracts/journal/authority owner path was edited. A shared owner
must decide the minimal published DTO/adapter and physical writer fence. The four
producer roots in the disposable assembly are evidence, not shipping integration.

The previous generator timeout, broad CI/native failures, formal review, live SIWC
and entitlement, native secret/process behavior and package/shipping gates remain
open. Unchanged broad runs were not repeated. PR creation remains held after the
original `Forbidden`; a manual description is provided in `MANUAL-PR.md`.
