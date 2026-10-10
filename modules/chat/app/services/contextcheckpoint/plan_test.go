package contextcheckpoint_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	cp "github.com/legrch/farol/modules/chat/app/services/contextcheckpoint"
	cb "github.com/legrch/farol/modules/chat/domain/contextbudget"
	"github.com/legrch/farol/modules/chat/infra/intent"
)

func planView(t *testing.T, f *fixture, p *cp.Prepared) (*cp.PlanMaterialization, cp.PlanView) {
	t.Helper()
	m, err := f.service.MaterializePlan(context.Background(), p, f.original.snapshot.Source.Binding)
	if err != nil {
		t.Fatal(err)
	}
	v, err := m.View(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return m, v
}
func TestPlanProjectionUnicodeIsStableAndDetached(t *testing.T) {
	for n, text := range []string{"plain", "λ🙂", "e\u0301", "\u2028\u2029", "<>&", "\"\\\n\t\u0000", "你好", "مرحبا"} {
		t.Run(fmt.Sprint(n), func(t *testing.T) {
			f := compose(t, 3)
			for i, e := range f.original.snapshot.Source.Events {
				if e.Kind == cb.User || e.Kind == cb.Result {
					f.original.snapshot.Source.Events[i].Text = text
				}
				if e.Kind == cb.Call {
					raw, _ := json.Marshal(struct {
						Value string `json:"value"`
					}{text})
					f.original.snapshot.Source.Events[i].Text = string(raw)
				}
			}
			p := prepare(t, f)
			m, v := planView(t, f, p)
			input, _ := json.Marshal(v.Items)
			hash, _ := intent.SHA256{}.Digest(input)
			wireHash, _ := intent.SHA256{}.Digest(v.ProviderJSON)
			if !bytes.Equal(input, v.InputJSON) || hash != v.Receipt.InputHash || wireHash != v.Receipt.ProviderHash || v.Items[0].Role != "developer" || len(v.Window.Unresolved) != 1 {
				t.Fatal("canonical projection or original identity changed")
			}
			want := v.Receipt
			inputCopy := append([]byte(nil), v.InputJSON...)
			wireCopy := append([]byte(nil), v.ProviderJSON...)
			v.Items[0].Content = "grant access"
			v.InputJSON[0] = '!'
			v.ProviderJSON[0] = '!'
			v.Window.Events[0].Text = "grant"
			v.Window.Unresolved[0].ToolOperationID = "changed"
			v.Receipt.InputHash = "changed"
			fresh, err := m.View(context.Background())
			if err != nil || fresh.Receipt != want || !bytes.Equal(fresh.InputJSON, inputCopy) || !bytes.Equal(fresh.ProviderJSON, wireCopy) || fresh.Window.Unresolved[0].ToolOperationID != "tool-1" {
				t.Fatal("returned values changed retained plan", err)
			}
			_, same := planView(t, f, p)
			if same.Receipt != want || !bytes.Equal(same.ProviderJSON, wireCopy) {
				t.Fatal("unchanged checkpoint produced different receipt")
			}
		})
	}
}

func TestPlanReceiptSeparatesSourceAccountOrderAndReservations(t *testing.T) {
	makeView := func(change string) cp.PlanView {
		f := compose(t, 3)
		b := binding()
		pol := policy()
		for i, e := range f.original.snapshot.Source.Events {
			if e.Kind == cb.User {
				f.original.snapshot.Source.Events[i].Text = e.Turn.TurnID
			}
		}
		switch change {
		case "source":
			f.original.snapshot.Source.Revision++
		case "account":
			b.AccountID = "another-account"
			f.original.snapshot.Source.Binding = b
			for k, q := range f.results.values {
				q.Conversation.Requested.AccountID = b.AccountID
				q.Conversation.Evidence.Requested.AccountID = b.AccountID
				q.Conversation.Evidence.Admitted.AccountID = b.AccountID
				f.results.values[k] = q
			}
		case "token-reservation":
			pol.Reserve.EstimatedTokens++
		case "byte-reservation":
			pol.Reserve.Bytes++
		case "code-point-reservation":
			pol.Reserve.CodePoints++
		case "order":
			e := f.original.snapshot.Source.Events
			f.original.snapshot.Source.Events = append(append(append([]cb.Event{}, e[0]), e[5:9]...), e[1:5]...)
			f.original.snapshot.Source.Events = append(f.original.snapshot.Source.Events, e[9:]...)
			for i := range f.original.snapshot.Source.Events {
				f.original.snapshot.Source.Events[i].Sequence = uint64(i + 1)
			}
		}
		p, err := f.service.Prepare(context.Background(), b, "checkpoint", "checkpoint-operation", pol)
		if err != nil {
			t.Fatal(err)
		}
		_, v := planView(t, f, p)
		return v
	}
	base := makeView("")
	for _, change := range []string{"source", "account", "token-reservation", "byte-reservation", "code-point-reservation", "order"} {
		t.Run(change, func(t *testing.T) {
			v := makeView(change)
			if base.Receipt.IdentityHash == v.Receipt.IdentityHash {
				t.Fatal("changed intent reused a receipt identity")
			}
			if change == "order" {
				if bytes.Equal(base.InputJSON, v.InputJSON) || base.Receipt.InputHash == v.Receipt.InputHash {
					t.Fatal("input order disappeared")
				}
			} else if !bytes.Equal(base.ProviderJSON, v.ProviderJSON) {
				t.Fatal("test should isolate identical provider bytes")
			}
			if change == "token-reservation" && (v.Receipt.TokenLimit+1 != base.Receipt.TokenLimit || v.Receipt.Policy.Reserve.EstimatedTokens != base.Receipt.Policy.Reserve.EstimatedTokens+1) {
				t.Fatal("reservation lost")
			}
		})
	}
}

func TestPlanProjectionNeverDropsUnsupportedHistoricalCalls(t *testing.T) {
	f := compose(t, 3)
	for i, e := range f.original.snapshot.Source.Events {
		if e.CallID == "call-1" {
			f.original.snapshot.Source.Events[i].CallID = "调用-1"
		}
	}
	p := prepare(t, f)
	if _, err := f.service.MaterializePlan(context.Background(), p, binding()); err != cp.Invalid {
		t.Fatal("nonportable call was removed or rewritten", err)
	}
	f2 := compose(t, 40)
	wide := cb.Policy{Limit: cb.Metrics{Bytes: cb.MaxWindowBytes, CodePoints: cb.MaxWindowBytes, EstimatedTokens: cb.MaxWindowBytes}}
	p2, err := f2.service.Prepare(context.Background(), binding(), "many-c", "many-o", wide)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f2.service.MaterializePlan(context.Background(), p2, binding()); err != cb.RequiredTooLarge {
		t.Fatal("128-item cap dropped an original round", err)
	}
}

func TestPlanProjectionRetainsSummaryAndRechecksBeforeExpose(t *testing.T) {
	f := compose(t, 3)
	p := prepare(t, f)
	if err := f.service.AddSummary(context.Background(), p, "v1"); err != nil {
		t.Fatal(err)
	}
	m, v := planView(t, f, p)
	if v.Items[1].Role != "user" || v.Window.Summary == nil || len(v.Window.Unresolved) != 1 {
		t.Fatal("summary gained instruction or erased UNKNOWN")
	}
	f.original.active = false
	if _, err := m.View(context.Background()); err != cb.Stale {
		t.Fatal("revoked view exposed", err)
	}
}

func TestPlanReceiptBindsOmittedOriginalBytes(t *testing.T) {
	f := compose(t, 1000)
	p := prepare(t, f)
	_, first := planView(t, f, p)
	if first.Window.OmittedEvents == 0 {
		t.Fatal("fixture requires omitted original history")
	}
	f.original.snapshot.Source.Events[1].Text = "Different omitted original user intent."
	f.original.snapshot.Source.Revision++
	if _, err := f.service.MaterializePlan(context.Background(), p, binding()); err != cb.Stale {
		t.Fatal("old source exposed after append/change", err)
	}
	next, err := f.service.Prepare(context.Background(), binding(), "next-checkpoint", "next-operation", policy())
	if err != nil {
		t.Fatal(err)
	}
	_, second := planView(t, f, next)
	if first.Receipt.Source.SHA256 == second.Receipt.Source.SHA256 || first.Receipt.IdentityHash == second.Receipt.IdentityHash || !bytes.Equal(first.ProviderJSON, second.ProviderJSON) || first.Receipt.InputHash != second.Receipt.InputHash {
		t.Fatal("identical selected text erased distinct original source")
	}
}

func TestPlanConversionKeepsReservationsInEveryDimension(t *testing.T) {
	f := compose(t, 1)
	for i, e := range f.original.snapshot.Source.Events {
		if e.Kind == cb.Result {
			f.original.snapshot.Source.Events[i].Text = strings.Repeat("<>&\"\\", 100)
		}
	}
	p := prepare(t, f)
	_, v := planView(t, f, p)
	legacy, err := f.service.Materialize(context.Background(), p, binding())
	if err != nil {
		t.Fatal(err)
	}
	for n, dimension := range []string{"bytes", "code-points", "tokens"} {
		t.Run(dimension, func(t *testing.T) {
			pol := cb.Policy{Limit: cb.Metrics{Bytes: cb.MaxWindowBytes, CodePoints: cb.MaxWindowBytes, EstimatedTokens: cb.MaxWindowBytes}}
			switch dimension {
			case "bytes":
				if v.Receipt.InputUsage.Bytes <= legacy.Usage.Bytes {
					t.Fatal("fixture needs larger mapped application input")
				}
				pol.Reserve.Bytes = 512
				pol.Limit.Bytes = v.Receipt.InputUsage.Bytes + 512
			case "code-points":
				if v.Receipt.InputUsage.CodePoints <= legacy.Usage.CodePoints {
					t.Fatal("fixture needs larger mapped input")
				}
				pol.Reserve.CodePoints = 512
				pol.Limit.CodePoints = v.Receipt.InputUsage.CodePoints + 512
			case "tokens":
				if v.Receipt.InputUsage.EstimatedTokens <= legacy.Usage.EstimatedTokens {
					t.Fatal("fixture needs larger mapped token estimate")
				}
				pol.Reserve.EstimatedTokens = 512
				pol.Limit.EstimatedTokens = v.Receipt.InputUsage.EstimatedTokens + 512
			}
			p, err := f.service.Prepare(context.Background(), binding(), fmt.Sprintf("exact-c-%d", n), fmt.Sprintf("exact-o-%d", n), pol)
			if err != nil {
				t.Fatal(err)
			}
			_, exact := planView(t, f, p)
			if exact.Receipt.Policy != pol || !bytes.Equal(exact.InputJSON, v.InputJSON) {
				t.Fatal("conversion lost exact reservation/input")
			}
			switch dimension {
			case "bytes":
				pol.Reserve.Bytes++
			case "code-points":
				pol.Reserve.CodePoints++
			case "tokens":
				pol.Reserve.EstimatedTokens++
			}
			tight, err := f.service.Prepare(context.Background(), binding(), fmt.Sprintf("tight-c-%d", n), fmt.Sprintf("tight-o-%d", n), pol)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := f.service.Materialize(context.Background(), tight, binding()); err != nil {
				t.Fatal("original representation should still fit", err)
			}
			if _, err := f.service.MaterializePlan(context.Background(), tight, binding()); err != cb.RequiredTooLarge {
				t.Fatal("mapped representation lost reserve", err)
			}
		})
	}
}

func TestLegacyMaterializedMutationCannotChangeCheckpointOrPlan(t *testing.T) {
	f := compose(t, 3)
	p := prepare(t, f)
	m, err := f.service.Materialize(context.Background(), p, binding())
	if err != nil {
		t.Fatal(err)
	}
	want := append([]byte(nil), m.JSON...)
	r, err := f.service.Publish(context.Background(), p)
	if err != nil {
		t.Fatal(err)
	}
	receipt := *r
	m.JSON[0] = '!'
	m.Window.Events[0].Text = "changed"
	m.Window.Unresolved[0].ToolOperationID = "changed"
	m.Body.Input[0].Content[0].Text = "changed"
	for i := range m.Body.Input {
		if m.Body.Input[i].Output != nil {
			*m.Body.Input[i].Output = "changed"
		}
	}
	next, err := f.service.Materialize(context.Background(), p, binding())
	if err != nil || !bytes.Equal(next.JSON, want) {
		t.Fatal("raw returned materialization changed retained original", err)
	}
	r, err = f.service.Publish(context.Background(), p)
	if err != nil || *r != receipt || f.store.writes != 1 {
		t.Fatal("raw mutation changed checkpoint receipt or repeated IO", err)
	}
}
