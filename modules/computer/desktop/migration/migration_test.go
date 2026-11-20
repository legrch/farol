package migration

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/computer/app/services/migration"
	"github.com/legrch/farol/modules/computer/domain/journal"
	"github.com/legrch/farol/modules/computer/domain/observation"
	"github.com/legrch/farol/transport/desktop"
)

type methodFixture struct {
	calls int
	err   error
}

func (f *methodFixture) fail() error {
	f.calls++
	return f.err
}

func (f *methodFixture) Select(context.Context, string, migration.Mode, observation.Saved) (migration.Selection, error) {
	return migration.Selection{}, f.fail()
}

func (f *methodFixture) Begin(context.Context, migration.Selection) (migration.BeginResult, error) {
	return migration.BeginResult{}, f.fail()
}

func (f *methodFixture) Confirm(context.Context, string, string, bool) (migration.ConfirmResult, error) {
	return migration.ConfirmResult{}, f.fail()
}

func (f *methodFixture) Plan(context.Context, string, journal.Phase) (journal.Receipt, error) {
	return journal.Receipt{EffectID: "effect", Digest: strings.Repeat("a", 64)}, f.fail()
}

func (f *methodFixture) Record(context.Context, string, journal.Phase, journal.Receipt) error {
	return f.fail()
}

func (f *methodFixture) WithdrawOnce(context.Context, string, migration.WithdrawEffect) (journal.Receipt, error) {
	return journal.Receipt{}, f.fail()
}

func (f *methodFixture) StageOnce(context.Context, string, migration.StageEffect) (journal.Receipt, error) {
	return journal.Receipt{}, f.fail()
}

func (f *methodFixture) Finish(context.Context, string, journal.Phase, journal.Receipt) error {
	return f.fail()
}

func (f *methodFixture) qualify(context.Context, string) (bool, error) {
	return false, f.fail()
}

func TestContinuityMethodsValidateBeforeOwnerAndPreserveFailure(t *testing.T) {
	const child = "11111111-1111-4111-8111-111111111111"
	const followup = "22222222-2222-4222-8222-222222222222"
	operation := fmt.Sprintf(`"operationId":%q`, child)
	body := func(fields string) string {
		return "{" + operation + fields + "}"
	}
	receipt := fmt.Sprintf(`,"receipt":{"effectId":"effect","digest":%q}`, strings.Repeat("a", 64))
	cases := []struct {
		method, envelope, valid, invalid string
	}{
		{"begin", child, body(`,"mode":"legacy-confirm","savedBinding":{"device":"12","inode":"50"}`),
			body(`,"mode":"legacy-confirm","savedBinding":{"device":"012","inode":"50"}`)},
		{"confirm", followup, body(`,"ownerPicked":true,"selectedRoot":"/Users/test"`),
			body(`,"ownerPicked":true,"selectedRoot":"/Users/../test"`)},
		{"plan", "", body(`,"phase":"withdraw_intent"`), body(`,"phase":"withdraw_ack"`)},
		{"record", followup, body(`,"phase":"withdraw_ack"` + receipt),
			body(`,"phase":"close_ack"` + receipt)},
		{"withdraw", followup, body(""), body(receipt)},
		{"stage", followup, body(""), body(`,"rootIdentity":{"device":"1","inode":"1"}`)},
		{"finish", followup, body(`,"kind":"committed"`), body(`,"kind":"committed"` + receipt)},
		{"qualify", followup, body(""), body(`,"qualified":true`)},
	}
	ctx := context.Background()
	for _, tc := range cases {
		t.Run(tc.method, func(t *testing.T) {
			f := &methodFixture{}
			handle := Methods(f, f, nil, nil, f.qualify)["computer.continuity."+tc.method].Handle
			request := desktop.Request{OperationID: tc.envelope, Body: json.RawMessage(tc.invalid)}
			assertRefused := func() {
				t.Helper()
				out, err := handle(ctx, request)
				if err != nil || out == nil || out.Status != "refused" || f.calls != 0 {
					t.Fatalf("invalid request crossed owner boundary: %+v, %v, calls=%d", out, err, f.calls)
				}
			}
			assertRefused()
			request.Body = json.RawMessage("{" + operation + "," + tc.valid[1:])
			assertRefused() // duplicate JSON key
			request.Body = json.RawMessage(tc.valid)
			request.OperationID = child
			if tc.envelope == child {
				request.OperationID = followup
			}
			assertRefused()
			request.OperationID = tc.envelope
			for _, failure := range []error{journal.ErrRefused, journal.ErrUnknown, errors.New("uncertain I/O"), errors.Join(journal.ErrRefused, journal.ErrUnknown)} {
				f.calls, f.err = 0, failure
				out, err := handle(ctx, request)
				if f.calls != 1 {
					t.Fatalf("valid method was not dispatched once: calls=%d, err=%v", f.calls, err)
				}
				if failure == journal.ErrRefused {
					if err != nil || out == nil || out.Status != "refused" {
						t.Fatal("known refusal lost", out, err)
					}
				} else if out != nil || !errors.Is(err, failure) {
					t.Fatal("uncertainty did not reach shared unknown boundary", out, err)
				}
			}
			if tc.method == "qualify" {
				f.err = nil
				out, err := handle(ctx, request)
				if err != nil || out == nil || out.Status != "unavailable" {
					t.Fatal("missing qualification was reported as usable", out, err)
				}
			}
		})
	}
}
