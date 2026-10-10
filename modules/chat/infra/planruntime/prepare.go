// Package planruntime composes original Context, Models and subscription
// inference. It supplies no account, journal, transcript or disclosure grant.
package planruntime

import (
	"bytes"
	"context"
	"encoding/json"
	"math"
	"unicode/utf8"

	cp "github.com/legrch/farol/modules/chat/app/services/contextcheckpoint"
	"github.com/legrch/farol/modules/chat/app/services/inference"
	cb "github.com/legrch/farol/modules/chat/domain/contextbudget"
	ms "github.com/legrch/farol/modules/chat/domain/modelselection"
	"github.com/legrch/farol/modules/chat/infra/clients/planresponses"
)

// Capture contains actual producer values. The estimate must have been captured
// for this exact input by its qualified estimator owner, not inferred from text.
type Capture struct {
	Plan                              *cp.PlanMaterialization
	Binding                           inference.Binding
	Resolved                          ms.Resolved
	Estimate                          ms.CapturedEstimate
	Budget                            ms.Budget
	EstimatorSource, EstimatorVersion string
}

// Reference travels beside Binding into every owning IO/publication port. The
// full source head includes omitted original events; Window retains UNKNOWN
// identities independently of provider text and all reservations stay explicit.
type Reference struct {
	Binding                           inference.Binding
	Receipt                           cp.PlanReceipt
	Window                            cb.Window
	Model                             ms.Pin
	Estimate                          ms.EstimateSnapshot
	Budget                            ms.Budget
	EstimatorSource, EstimatorVersion string
}

type Prepared struct {
	reference Reference
	resolved  ms.Resolved
	estimate  ms.CapturedEstimate
	input     []inference.InputItem
	provider  []byte
}

func copyWindow(w cb.Window) cb.Window {
	w.Events = append([]cb.Event(nil), w.Events...)
	w.Unresolved = append([]cb.UnknownReference(nil), w.Unresolved...)
	if w.Summary != nil {
		s := *w.Summary
		w.Summary = &s
	}
	return w
}
func copyReference(r Reference) Reference { r.Window = copyWindow(r.Window); return r }
func (p *Prepared) Reference() Reference {
	if p == nil {
		return Reference{}
	}
	return copyReference(p.reference)
}

// Prepare validates exact original producer identity, wire bytes and budgets
// before any inference ledger reservation, credentials or HTTP. The concrete
// transport's one builder proves byte equality; no duplicate wire builder exists.
func Prepare(ctx context.Context, c Capture, digester inference.Digester) (*Prepared, error) {
	if ctx == nil || ctx.Err() != nil || c.Plan == nil || digester == nil {
		return nil, inference.Invalid
	}
	view, err := c.Plan.View(ctx)
	if err != nil {
		return nil, inference.Withdrawn
	}
	r, pin := view.Receipt, c.Resolved.Pin()
	if !r.Source.Valid() || r.Source != view.Window.Source || !r.Policy.Fits(r.Usage) || !r.Policy.Fits(r.InputUsage) || !cb.Digest(r.IdentityHash) || !cb.ID(r.CheckpointID) || !cb.ID(r.OperationID) {
		return nil, inference.Invalid
	}
	if pin.Route != (ms.Route{Provider: "openai", Backend: ms.PlanInference, Billing: ms.Plan}) || pin.Epoch == 0 || pin.AccountID != r.Source.Binding.AccountID || pin.Model != r.Source.Binding.ModelID || pin.Effort != r.Source.Binding.Effort || pin.CapabilityRevision != r.Source.Binding.CapabilityEpoch || r.Source.Binding.Provider != pin.Route.Provider {
		return nil, inference.Invalid
	}
	b := c.Binding
	for _, id := range []string{b.OperationID, b.ProfileID, b.BackendGeneration, b.OwnerID, b.SessionID} {
		if !cb.ID(id) {
			return nil, inference.Invalid
		}
	}
	if b.DeadlineMillis == 0 || b.DeadlineMillis > math.MaxInt64 {
		return nil, inference.Invalid
	}
	for _, event := range view.Window.Events {
		// Original instructions intentionally carry no invented Turn identity.
		if event.Kind != cb.Instruction && event.Turn.SessionID != b.SessionID {
			return nil, inference.Invalid
		}
	}
	for _, unknown := range view.Window.Unresolved {
		if unknown.Turn.SessionID != b.SessionID {
			return nil, inference.Invalid
		}
	}
	if !inference.ValidSelection(b.Selection) || b.ProfileID != r.Source.Binding.ProfileID || b.BackendGeneration != r.Source.Binding.BackendGeneration || b.OwnerID != r.Source.Binding.OwnerID || b.Selection.Model != (inference.ModelSelection{Slug: pin.Model, Effort: pin.Effort, CapabilityEvidence: pin.CapabilityRevision, CatalogueEpoch: pin.Epoch}) {
		return nil, inference.Invalid
	}
	account, err := json.Marshal(b.Selection.Account)
	if err != nil {
		return nil, inference.Invalid
	}
	accountHash, err := digester.Digest(account)
	if err != nil || accountHash != pin.AccountID {
		return nil, inference.Invalid
	}
	contextValue := inference.ContextSelection{CheckpointID: r.CheckpointID, InputHash: r.InputHash, EstimatedTokens: r.EstimatedTokens, TokenLimit: r.TokenLimit}
	if b.Context != (inference.ContextSelection{}) && b.Context != contextValue {
		return nil, inference.Invalid
	}
	b.Context = contextValue
	input := make([]inference.InputItem, 0, len(view.Items))
	for _, v := range view.Items {
		input = append(input, inference.InputItem{Kind: v.Kind, Role: v.Role, Content: v.Content, CallID: v.CallID, Name: v.Name, Arguments: v.Arguments})
	}
	raw, err := json.Marshal(input)
	if err != nil || !bytes.Equal(raw, view.InputJSON) || r.InputUsage.Bytes != len(raw) || r.InputUsage.CodePoints != utf8.RuneCount(raw) {
		return nil, inference.Invalid
	}
	hash, err := inference.InputHash(digester, input)
	if err != nil || hash != r.InputHash {
		return nil, inference.Invalid
	}
	request := inference.Request{Model: b.Selection.Model, Input: input, DeadlineMillis: b.DeadlineMillis}
	provider, err := planresponses.New(nil).PrepareRequest(request)
	if err != nil || !bytes.Equal(provider, view.ProviderJSON) || r.Usage.Bytes != len(provider) || r.Usage.CodePoints != utf8.RuneCount(provider) {
		return nil, inference.Invalid
	}
	providerHash, err := digester.Digest(provider)
	if err != nil || providerHash != r.ProviderHash {
		return nil, inference.Invalid
	}
	identity := r
	identity.IdentityHash = ""
	identityJSON, err := json.Marshal(identity)
	if err != nil {
		return nil, inference.Invalid
	}
	identityHash, err := digester.Digest(identityJSON)
	if err != nil || identityHash != r.IdentityHash {
		return nil, inference.Invalid
	}
	if r.EstimatedTokens != uint64(max(r.Usage.EstimatedTokens, r.InputUsage.EstimatedTokens)) || r.TokenLimit != uint64(r.Policy.Limit.EstimatedTokens-r.Policy.Reserve.EstimatedTokens) {
		return nil, inference.Invalid
	}
	estimate := c.Estimate.Snapshot()
	if estimate.Selection != pin || estimate.InputDigest != hash || estimate.Estimate.Source != c.EstimatorSource || estimate.Estimate.Version != c.EstimatorVersion || !estimate.Estimate.InputTokens.Known || estimate.Estimate.InputTokens.Value != r.EstimatedTokens || !c.Budget.MaxInputTokens.Known || c.Budget.MaxInputTokens.Value != r.TokenLimit {
		return nil, inference.Invalid
	}
	p := &Prepared{reference: Reference{Binding: b, Receipt: r, Window: copyWindow(view.Window), Model: pin, Estimate: estimate, Budget: c.Budget, EstimatorSource: c.EstimatorSource, EstimatorVersion: c.EstimatorVersion}, resolved: c.Resolved, estimate: c.Estimate, input: append([]inference.InputItem(nil), input...), provider: append([]byte(nil), provider...)}
	if ctx.Err() != nil {
		return nil, inference.Cancelled
	}
	// Recheck the original source after all deterministic external digest work.
	current, err := c.Plan.View(ctx)
	if err != nil || current.Receipt != r {
		return nil, inference.Withdrawn
	}
	return p, nil
}
