package contextcheckpoint

import (
	"context"
	"encoding/json"
	"unicode/utf8"

	"github.com/legrch/farol/modules/chat/domain/contextbudget"
)

// PlanItem is a detached producer projection, not a shared INFERENCE contract.
// Field order/casing matches the ordered InputHash representation at the pinned
// consumer. The integration owner must explicitly map every field and sidecar.
type PlanItem struct{ Kind, Role, Content, CallID, Name, Arguments string }

const PlanMaxItems = 128
const PlanMaxBytes = 256 << 10

// PlanReceipt binds budget reservations and original identity independently of
// hashes of identical provider text. It is correlation data, never an IO grant.
type PlanReceipt struct {
	CheckpointID, OperationID             string
	Source                                contextbudget.SourceRef
	Policy                                contextbudget.Policy
	InputHash, ProviderHash, IdentityHash string
	Usage, InputUsage                     contextbudget.Metrics
	EstimatedTokens, TokenLimit           uint64
}

// PlanMaterialization owns private copies. Each View rechecks the original
// source lease and returns detached values; edits cannot alter retained hashes.
type PlanMaterialization struct {
	owner           *Service
	items           []PlanItem
	input, provider []byte
	window          contextbudget.Window
	receipt         PlanReceipt
}
type PlanView struct {
	Items                   []PlanItem
	InputJSON, ProviderJSON []byte
	Window                  contextbudget.Window
	Receipt                 PlanReceipt
}

func (m *PlanMaterialization) View(ctx context.Context) (PlanView, error) {
	if m == nil || m.owner == nil || ctx == nil || ctx.Err() != nil {
		return PlanView{}, Invalid
	}
	if m.owner.deps.Source.Check(ctx, m.receipt.Source) != nil || ctx.Err() != nil {
		return PlanView{}, contextbudget.Stale
	}
	return PlanView{append([]PlanItem{}, m.items...), append([]byte{}, m.input...), append([]byte{}, m.provider...), cloneWindow(m.window), m.receipt}, nil
}

func planIdentifier(s string) bool {
	if len(s) == 0 || len(s) > 128 {
		return false
	}
	for _, c := range s {
		if !(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '_' || c == '-' || c == '.') {
			return false
		}
	}
	return true
}
func (s *Service) planMeasure(raw []byte) (contextbudget.Metrics, error) {
	n, err := s.deps.Estimator.EstimateTokens(string(raw))
	if err != nil || n < 0 || n > contextbudget.MaxSourceBytes {
		return contextbudget.Metrics{}, contextbudget.EstimateFailed
	}
	return contextbudget.Metrics{Bytes: len(raw), CodePoints: utf8.RuneCount(raw), EstimatedTokens: n}, nil
}

// MaterializePlan projects the actual original materialization into the pinned
// flat no-tools input and exact stream/reasoning envelope. It does no provider
// IO, storage or consent mapping. Original instructions map to developer;
// untrusted summaries keep their user-data role. Historical calls/results are
// never removed to make a no-tools request succeed.
func (s *Service) MaterializePlan(ctx context.Context, p *Prepared, b contextbudget.Binding) (*PlanMaterialization, error) {
	m, err := s.Materialize(ctx, p, b)
	if err != nil {
		return nil, err
	}
	if len(m.Body.Input) > PlanMaxItems {
		return nil, contextbudget.RequiredTooLarge
	}
	if !planIdentifier(b.ModelID) {
		return nil, Invalid
	}
	switch b.Effort {
	case "none", "minimal", "low", "medium", "high", "xhigh":
	default:
		return nil, Invalid
	}
	items := make([]PlanItem, 0, len(m.Body.Input))
	wireItems := make([]any, 0, len(m.Body.Input))
	for _, item := range m.Body.Input {
		v := PlanItem{Kind: item.Type, Role: item.Role, CallID: item.CallID, Name: item.Name, Arguments: item.Arguments}
		switch item.Type {
		case "message":
			if len(item.Content) != 1 {
				return nil, Invalid
			}
			v.Content = item.Content[0].Text
			if v.Role == "system" {
				v.Role = "developer"
			}
			wireItems = append(wireItems, struct {
				Type    string `json:"type"`
				Role    string `json:"role"`
				Content string `json:"content"`
			}{v.Kind, v.Role, v.Content})
		case "function_call":
			if !planIdentifier(v.CallID) || !planIdentifier(v.Name) {
				return nil, Invalid
			}
			wireItems = append(wireItems, struct {
				Type      string `json:"type"`
				CallID    string `json:"call_id"`
				Name      string `json:"name"`
				Arguments string `json:"arguments"`
			}{v.Kind, v.CallID, v.Name, v.Arguments})
		case "function_call_output":
			if item.Output == nil || !planIdentifier(v.CallID) {
				return nil, Invalid
			}
			v.Content = *item.Output
			wireItems = append(wireItems, struct {
				Type   string `json:"type"`
				CallID string `json:"call_id"`
				Output string `json:"output"`
			}{v.Kind, v.CallID, v.Content})
		default:
			return nil, Invalid
		}
		items = append(items, v)
	}
	input, err := json.Marshal(items)
	if err != nil || len(input) > PlanMaxBytes {
		return nil, contextbudget.RequiredTooLarge
	}
	provider, err := json.Marshal(struct {
		Model     string `json:"model"`
		Input     []any  `json:"input"`
		Store     bool   `json:"store"`
		Stream    bool   `json:"stream"`
		Reasoning *struct {
			Effort string `json:"effort"`
		} `json:"reasoning,omitempty"`
	}{b.ModelID, wireItems, false, true, &struct {
		Effort string `json:"effort"`
	}{b.Effort}})
	if err != nil || len(provider) > PlanMaxBytes {
		return nil, contextbudget.RequiredTooLarge
	}
	inputUsage, err := s.planMeasure(input)
	if err != nil {
		return nil, err
	}
	usage, err := s.planMeasure(provider)
	if err != nil {
		return nil, err
	}
	if !p.policy.Fits(inputUsage) || !p.policy.Fits(usage) {
		return nil, contextbudget.RequiredTooLarge
	}
	inputHash, err := s.deps.Digests.Digest(input)
	if err != nil || !contextbudget.Digest(inputHash) {
		return nil, Invalid
	}
	providerHash, err := s.deps.Digests.Digest(provider)
	if err != nil || !contextbudget.Digest(providerHash) {
		return nil, Invalid
	}
	tokens := max(usage.EstimatedTokens, inputUsage.EstimatedTokens)
	r := PlanReceipt{CheckpointID: p.id, OperationID: p.operation, Source: m.Window.Source, Policy: p.policy, InputHash: inputHash, ProviderHash: providerHash, Usage: usage, InputUsage: inputUsage, EstimatedTokens: uint64(tokens), TokenLimit: uint64(p.policy.Limit.EstimatedTokens - p.policy.Reserve.EstimatedTokens)}
	identity, _ := json.Marshal(r)
	r.IdentityHash, err = s.deps.Digests.Digest(identity)
	if err != nil || !contextbudget.Digest(r.IdentityHash) {
		return nil, Invalid
	}
	if s.deps.Source.Check(ctx, r.Source) != nil || ctx.Err() != nil {
		return nil, contextbudget.Stale
	}
	return &PlanMaterialization{owner: s, items: items, input: input, provider: provider, window: cloneWindow(m.Window), receipt: r}, nil
}
