# Current estimate/receipt consumer witness

The current disposable witness invokes actual production functions from:

- MODELS `8f6a0f2491af8d6674c72c82f1f611e3e3f8627b`, tree
  `b29881c32a95bcd70b1e812c29b9d4ab6968809d`: `catalogue.Cache`,
  `modelselection.Resolve/RecheckBeforeStart/CaptureEstimate/CheckCurrentBudget`.
- CONTEXT `817b7dff8ab79320a02d5321e6686d0891f3b11c`, tree
  `edcb8ff430c101b460b06b56cbee9142354c56fd`:
  `contextcheckpoint.New/Prepare/MaterializePlan/View` and the real bounded
  selector, source hashing and detached `PlanReceipt` projection.
- INFERENCE's actual `Service`, mandatory pure adapter `Preflight`, private
  account Grant/ConsentFence, deadline and public Responses builder/SSE parser.
  Production code checkpoint: `08fc551fa034580f58567468bf2c10de087ea345`;
  tree `e2d9726bb8ad3ac71bee52d32852ed9b157a0a34`.

There are no mocked producer functions or shipping producer imports. The script
assembles four exact public producer roots outside the product checkout and
refuses overlays of existing product paths. `currentconsumerpins.json` hashes
all 38 selected producer code/test/public handoff files. The manifest hashes every
assembled Go input and module file, exact source pins/trees, executable assets,
toolchain, original JSON test events and vet log. Downloads, Go overlays,
workspaces, modfile flags and lazy Git fetching are disabled.

## Reproduce

Use the declared Go 1.26.2 and pre-existing dependency cache. All three checkouts
must contain the exact public objects; this script does not fetch or run a daemon.
Use the exact inference source from `CURRENT-WITNESS-RECEIPT.json` and a fresh
output directory outside the inputs:

```sh
python3 docs/inference/consumerwitness.py \
  --inference-root /path/to/inference \
  --inference-ref FULL_FROZEN_INFERENCE_COMMIT \
  --models-root /path/to/models \
  --context-root /path/to/context \
  --output /path/to/new-disposable-current-witness
```

The default assets are `currentconsumerpins.json` and
`currentconsumerwitness.go.txt`. Historical v3 assets and receipts remain intact;
their explicit old source/asset command is in `CONSUMER-WITNESS.md`. Old wire
side-effect counters describe the old source, not current admission.

## Evidence and limits

The current bounded original source has 256 events. Actual context selection
retains 28, omits 228, and preserves the mandatory original UNKNOWN exchange.
Actual plan fields map individually into inference input. Canonical input bytes
and hash match the real producer exactly; actual HTTP bytes equal its complete
`ProviderJSON`, including exact selected model/effort and no tools. Both complete
input and provider envelope fit the actual reserved policy. No billed usage or
live entitlement is inferred from advisory estimates.

The pre-commit current run passed eight top-level tests and 57 subcases under
race checking, plus targeted vet. The frozen committed source and original log
hashes are recorded in `CURRENT-WITNESS-RECEIPT.json`.

The focused witness exercises:

- Expired/future/foreign-input/foreign-model/provenance-mismatched/unqualified
  captured estimates and unknown input totals. Actual `CheckCurrentBudget`
  refuses these. The controlled owner separately refuses absent/zero or changed
  input limits and enforces monotonic estimate-clock samples. Every refusal has
  zero reserve, credential acquisition, HTTP and publication entries.
- A second actual context producer yields identical canonical input and provider
  bytes from a changed source revision, omitted original bytes, account binding,
  or any of the three policy reservations. Input/provider hashes stay identical;
  complete receipt/identity changes. Substituting that receipt refuses before IO.
- Complete receipt and original UNKNOWN sidecar changes refuse before admission.
  Receipt, UNKNOWN or estimate changes after reserve/acquisition refuse sending;
  changes during HTTP/before publication suppress delivery while retaining the
  original remote completion. They never retarget the binding or permit replay.
- Detached views cannot rewrite retained items, bytes, policy or UNKNOWN values.
  An old view lease detects changed omitted source bytes without a revision bump.
- New plan projection refuses invalid historical call IDs/names. Duplicate-key
  and unpaired-surrogate arguments remain exact producer bytes; the actual
  adapter preflight refuses them before reserve or credential acquisition.
- Cached catalogue data does not override explicit missing-model/capability
  refusal, provider model/usage refusal or an UNKNOWN stream. No API fallback or
  repeated request follows these observed outcomes.

The original invalid-wire counterexample and real CredentialManager's refresh
side effects are recorded in `PREFLIGHT.md` and original export evidence. Current
owned regressions also cover encoded wire overflow, mutation, cancellation,
deadline/rollback, intent-digester withdrawal and sticky UNKNOWN operations.
The current source receipt records actual named test events; an empty test match
cannot count as a pass. Prior account/catalogue/complete context lifetime,
missing-round and billing-route cases remain their exact historical v3 evidence;
unchanged broad CI or fuzz runs were not repeated for activity.

## Integration obligation

The test's mutex-serialized owner, qualified estimate observation, current source,
credentials, ledger, HTTP and publication ports are controlled synthetic evidence.
The real private account Grant remains required, but this fixture does not qualify
production account, store, journal or physical writer. `PlanReceipt`, catalogue,
digest or cache data never mint that authority.

The existing Final Sync may compose verified ranges in
`integration/daily-driver-hardening`. It must retain the complete original
Binding, model pin/capabilities and captured estimate/provenance/expiry, complete
PlanReceipt/source/policy/reservations/usage and UNKNOWN sidecar under its actual
owner lifetime. Check current budget/source/account/catalogue before reserve,
between IO and immediately before physical publication. A changed receipt with
the same input hash must withdraw the original binding. The controlled no-IO
callback must not be replaced by a potentially blocking source read.

Every transport wrapper must implement the mandatory pure `Preflight` by the
actual immutable adapter grammar; the Client already does. Ledger uncertainty
remains sticky. No shared boot/schema/contracts/journal/authority path was edited
here. Production wiring, aggregate generator/CI, LIVE SIWC/subscription effects,
MAC secret/process behavior and formal review remain separate gates. Original PR
`Forbidden` remains held; `MANUAL-PR.md` supplies the owner-created description.
