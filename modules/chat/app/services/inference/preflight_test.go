package inference_test

import (
	"context"
	"testing"

	"github.com/legrch/farol/modules/chat/app/services/inference"
	"github.com/legrch/farol/modules/chat/infra/intent"
)

func TestPreflightCannotMutateOriginalRequestOrLifetime(t *testing.T) {
	for _, stage := range []string{"input mutation", "withdrawal", "cancel", "deadline", "clock rollback", "error"} {
		t.Run(stage, func(t *testing.T) {
			f := newFixture(t)
			f.c.now = 20
			original := append([]inference.InputItem(nil), f.input...)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			calls := 0
			f.transport.preflight = func(r inference.Request) error {
				calls++
				r.Input[0].Content = "replacement"
				r.Model.Slug = "replacement"
				r.DeadlineMillis = 1000
				switch stage {
				case "withdrawal":
					f.a.current = false
				case "cancel":
					cancel()
				case "deadline":
					f.c.now = f.binding.DeadlineMillis
				case "clock rollback":
					f.c.now = 19
				case "error":
					return inference.Invalid
				}
				return nil
			}
			got := f.service.Infer(ctx, f.binding, f.input)
			if calls != 1 || f.input[0] != original[0] {
				t.Fatal("preflight changed caller input or did not run")
			}
			if stage == "input mutation" {
				if got.State != inference.Completed || f.transport.request.Input[0] != original[0] || f.transport.request.Model != f.binding.Selection.Model || f.transport.request.DeadlineMillis != f.binding.DeadlineMillis {
					t.Fatal("preflight retargeted the immutable send")
				}
			} else if got.State != inference.NotSent || f.ledger.reservations != 0 || f.credentials.calls != 0 || f.transport.calls != 0 || f.publication.calls != 0 {
				t.Fatalf("invalidated preflight entered owner IO: %+v", got)
			}
		})
	}
}

type preflightDigester struct {
	calls int
	after func()
}

func (d *preflightDigester) Digest(raw []byte) (string, error) {
	d.calls++
	if d.calls == 2 {
		d.after()
	}
	return (intent.SHA256{}).Digest(raw)
}

func TestIntentDigestionCannotExtendPreflightAuthority(t *testing.T) {
	f := newFixture(t)
	d := &preflightDigester{after: func() { f.a.current = false }}
	service, err := inference.New(inference.Options{Clock: f.c, Deadline: controlledDeadline{}, Digester: d, Credentials: f.credentials, Transport: f.transport, Authority: f.a, Ledger: f.ledger, Publication: f.publication})
	if err != nil {
		t.Fatal(err)
	}
	got := service.Infer(context.Background(), f.binding, f.input)
	if d.calls != 2 || got.State != inference.NotSent || f.ledger.reservations != 0 || f.credentials.calls != 0 || f.transport.calls != 0 {
		t.Fatal("intent digest withdrawal entered owner IO")
	}
}

func TestPreflightDoesNotReopenConsumedUnknownOperation(t *testing.T) {
	f := newFixture(t)
	f.transport.outcome = inference.Outcome{State: inference.Unknown, Code: "INFERENCE_TRANSPORT_UNKNOWN"}
	if got := f.service.Infer(context.Background(), f.binding, f.input); got.State != inference.Unknown {
		t.Fatal("original unknown not preserved")
	}
	f.transport.preflight = func(inference.Request) error { return inference.Invalid }
	if got := f.service.Infer(context.Background(), f.binding, f.input); got.Code != inference.Invalid {
		t.Fatal("invalid preflight accepted")
	}
	f.transport.preflight = nil
	if got := f.service.Infer(context.Background(), f.binding, f.input); got.Code != inference.AlreadyReserved || f.credentials.calls != 1 || f.transport.calls != 1 || f.ledger.settlements != 1 || !f.ledger.used[f.binding.OperationID] {
		t.Fatal("validation reopened the original consumed operation")
	}
}
