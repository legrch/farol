# Browser model runtime correlation

The current Browser application resolves the actual `settings.tasks` policy and
compiled `BrowserModelProfile` into `port.ModelSelectionCapture`. This adapter
consumes that exact capture after the existing account owner's `Approve`.
It keeps the complete original app mapping, original account scope, approval
revision and provider-session observation beside a Models `Resolved` value.

Obtain the approval projection inside the original private
`accountapproval.Grant.WithCurrent` callback. `CaptureBrowser` and
`RecheckBrowser` perform no IO or owner reentry, so they can run inside that
callback. The callback's owning check remains necessary: a detached Models pin
cannot observe withdrawal or mint a private account grant. Parent composition
must also retain the existing Chat admission, conversation identity and final
public-control checks. The injected `nowMillis` comes from the existing owner;
this adapter adds no clock, account store, settings owner or scheduler.

The exact original positive approval revision supplies the browser catalogue
epoch. The real configuration hash supplies its revision; the selected compiled
translation ID supplies capability revision. `farol-browser-text-turn-v1`
describes software support for the existing Browser text-turn protocol. Image
and tool capabilities remain unknown. This private selected-profile projection
is not model discovery, provider entitlement, authentication, public-control
observation, or successful Send evidence.

An owner/configuration/profile/effort change, renewed observation or new approval
cannot update the original capture. `RecheckBrowser` refuses changed values and
preserves the original observation's freshness/expiry. It checks first-dispatch
correlation only; an admitted, refused or UNKNOWN operation retains its original
existing owner and cannot be replayed through this API. Browser values never
convert to direct subscription-inference account identity or Codex task authority.

`Resolved()` lets the existing Models estimate boundary retain this actual pin.
It creates no token/cost estimate or price. The original input hash, explicit
estimator source/version, qualified observation and known/unknown quantities
still come from their owners and require `CheckCurrentBudget` at admission.

Tests use the actual Browser model resolver, actual account service/private
grant and actual Models estimate boundary with controlled source declarations.
They do not qualify production profiles, current provider controls, live account
entitlement, native startup or any provider effect. Missing qualified production
profiles stay a separate activation gate.

The generic Models catalogue supports models with no effort. The current Browser
producer requires nonempty compiled effort mappings and an already resolved
nonempty effort. This adapter preserves that existing boundary: it does not
manufacture a default or broaden the producer/port to accept a no-effort model.

```sh
go test -race -count=1 ./modules/chat/infra/modelruntime
go vet ./modules/chat/infra/modelruntime
node tooling/check-go-architecture.mjs
```
