package planresponses_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/chat/app/services/inference"
	"github.com/legrch/farol/modules/chat/infra/clients/planresponses"
	"github.com/legrch/farol/modules/chat/infra/intent"
)

type preflightLedger struct {
	*compositionLedger
	reserves int
}

func (l *preflightLedger) Reserve(ctx context.Context, b inference.Binding, hash string) (bool, error) {
	l.reserves++
	return l.compositionLedger.Reserve(ctx, b, hash)
}

type preflightCredentials struct {
	inference.Credentials
	calls int
}

func (c *preflightCredentials) Acquire(ctx context.Context, s inference.Selection) (inference.Credential, error) {
	c.calls++
	return c.Credentials.Acquire(ctx, s)
}

func preflightCallInput(id, name, arguments string) []inference.InputItem {
	return []inference.InputItem{
		{Kind: "function_call", CallID: id, Name: name, Arguments: arguments},
		{Kind: "function_call_output", CallID: id, Content: "original result"},
	}
}

// These inputs pass the app's structural validation. The actual wire builder's
// stricter grammar must refuse them before journal or credential/refresh work.
func TestProductionPreflightRejectsWireBeforeOwnerIO(t *testing.T) {
	limitInput := []inference.InputItem{{Kind: "message", Role: "user"}}
	empty, err := json.Marshal(limitInput)
	if err != nil {
		t.Fatal(err)
	}
	limitInput[0].Content = strings.Repeat("x", inference.MaxInputBytes-len(empty))
	cases := map[string][]inference.InputItem{
		"wire cap":      limitInput,
		"call ID":       preflightCallInput("call:1", "observe", `{}`),
		"function name": preflightCallInput("call-1", "observe/selected", `{}`),
		"duplicate key": preflightCallInput("call-1", "observe", `{"a":1,"a":2}`),
		"surrogate":     preflightCallInput("call-1", "observe", `{"x":"\ud800"}`),
		"depth":         preflightCallInput("call-1", "observe", strings.Repeat("[", 33)+"0"+strings.Repeat("]", 33)),
	}
	for name, input := range cases {
		for _, refresh := range []bool{false, true} {
			mode := "ready"
			if refresh {
				mode = "expired"
			}
			t.Run(name+"/"+mode, func(t *testing.T) {
				f := newComposed(t)
				f.input = input
				var err error
				f.binding.Context.InputHash, err = inference.InputHash(intent.SHA256{}, input)
				if err != nil || inference.ValidateRequest(inference.Request{Model: f.binding.Selection.Model, Input: input, DeadlineMillis: f.binding.DeadlineMillis}) != nil {
					t.Fatal("counterexample does not pass app structural validation")
				}
				var credentials inference.Credentials = f.credentials
				var store *compositionStore
				var provider *compositionRefresh
				if refresh {
					credentials, store, provider = composedCredentialManager(t, f)
				}
				c := &preflightCredentials{Credentials: credentials}
				l := &preflightLedger{compositionLedger: f.ledger}
				service, err := inference.New(inference.Options{Clock: f.clock, Deadline: planresponses.OperationDeadline{}, Digester: intent.SHA256{}, Credentials: c, Authority: f.authority, Ledger: l, Publication: f.publication, Transport: planresponses.New(&http.Client{Transport: f.http})})
				if err != nil {
					t.Fatal(err)
				}
				got := service.Infer(context.Background(), f.binding, input)
				writes, refreshes := 0, 0
				if refresh {
					writes, refreshes = store.writes, provider.calls
				}
				if got.State != inference.NotSent || got.Code != inference.Invalid || l.reserves != 0 || c.calls != 0 || writes != 0 || refreshes != 0 || f.http.calls != 0 || f.publication.count != 0 {
					t.Fatalf("strict wire refusal entered owner IO: outcome=%+v reserve=%d acquire=%d writes=%d refresh=%d HTTP=%d", got, l.reserves, c.calls, writes, refreshes, f.http.calls)
				}
			})
		}
	}
}
