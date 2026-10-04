package boot

import (
	"context"
	"reflect"
	"strings"
	"testing"

	wire "github.com/legrch/farol/gen/desktop/v1"
)

// Real app/facade/ingress composition with injected Computer, persistence and
// physical browser ports. This is neither native storage nor a live provider.
func readIntentUnapprovedFixture(t *testing.T) (*chatComputerFixture, *ComputerIngress, wire.ChatComputerAdmissionResponse) {
	t.Helper()
	f := newChatComputerFixture(t)
	computer, _, native, _ := f.computer(t)
	computer.publication.receipt.SettingsRevision = "1"
	computer.publication.receipt.PublishOperationId = "publication"
	computer.publication.receipt.ApprovalDigest = strings.Repeat("a", 64)
	if _, err := NewChatComputerIngress(f.ingress, computer); err != nil {
		t.Fatal(err)
	}
	a, err := computer.Admit(context.Background(), "original-read-admission", wire.ChatComputerAdmissionRequest{
		Publication: computer.publication.receipt, SessionId: "session", TaskId: "original-read-task", TurnId: "original-read-turn", WorkspaceIds: []string{"work"},
	})
	if err != nil || a == nil {
		t.Fatal("read admission", a, err)
	}
	read := computerInvoke(t, computer.Methods()["computer.workspace.read"], wire.ComputerReadRequest{
		OwnerId: a.OwnerId, SessionId: a.SessionId, TaskId: a.TaskId, TaskEpoch: a.TaskEpoch,
		ParticipantId: a.ParticipantId, TurnId: a.TurnId, Generation: a.Generation,
		CallId: "selected-file-read", WorkspaceId: "work", RelativePath: "note.md",
	})
	if read.Status != "ok" || native.calls != 1 || f.physical.sends != 0 {
		t.Fatal("captured read", read, native.calls)
	}
	return f, computer, *a
}

func readIntentFixture(t *testing.T) (*chatComputerFixture, *ComputerIngress, wire.ChatComputerAdmissionResponse) {
	t.Helper()
	f, computer, a := readIntentUnapprovedFixture(t)
	approveReadAccountFixture(t, computer, a)
	f.physical.account = accountSendSnapshot()
	return f, computer, a
}

func readIntentPromotion(a wire.ChatComputerAdmissionResponse) wire.ChatReadIntentPromote {
	in := chatComputerInput(false)
	return wire.ChatReadIntentPromote{Admission: a, Selection: in.Selection, Resolution: in.Resolution, Required: in.Required, Prompt: "Explain the selected text: test"}
}

func TestReadIntentSameOwnerPromotionAndFollow(t *testing.T) {
	f, computer, a := readIntentFixture(t)
	ctx := context.Background()
	in := readIntentPromotion(a)
	h, err := computer.promoteRead(ctx, "explicit-send", in)
	if err != nil || h == nil {
		t.Fatal("promote", h, err)
	}
	if h.Binding.TaskId != a.TaskId || h.Binding.TurnId != a.TurnId || h.Binding.OperationId != a.AdmissionOperationId || h.Binding.ParticipantId != a.ParticipantId || f.count("admit") != 1 || f.physical.sends != 0 {
		t.Fatal("promotion replaced owner or sent", h)
	}
	entries := len(f.journal.entries)
	claims := len(computer.used)
	exactAgain, err := computer.promoteRead(ctx, "explicit-send", in)
	if err != nil || !reflect.DeepEqual(h, exactAgain) || len(f.journal.entries) != entries || len(computer.used) != claims {
		t.Fatal("same-command known replay changed ownership", exactAgain, err)
	}
	again, err := computer.promoteRead(ctx, "duplicate-ui-command", in)
	if err != nil || !reflect.DeepEqual(h, again) || len(f.journal.entries) != entries || len(computer.used) != claims {
		t.Fatal("known replay created another owner or write", again, err)
	}
	p, err := f.ingress.facade.PrepareNext(ctx, 10000)
	if err != nil || p.Binding.OperationID != a.AdmissionOperationId {
		t.Fatal("prepare original", p, err)
	}
	actual, err := f.ingress.get(h.HandleId)
	if err != nil {
		t.Fatal(err)
	}
	if err := actual.send(ctx, 10000); err != nil {
		t.Fatal(err)
	}
	for n := 0; n < 2; n++ {
		if err := actual.handle.Observe(ctx, 10000); err != nil {
			t.Fatal(err)
		}
	}
	frames, err := actual.handle.Events(ctx, 0)
	if err != nil {
		t.Fatal(err)
	}
	useful := false
	for _, frame := range frames {
		if frame.Type == "response.completed" {
			t.Fatal("terminal before useful output")
		}
		useful = useful || frame.Type == "response.output_text.delta"
	}
	if !useful {
		t.Fatal("no useful incremental output")
	}
	result := f.finish(t, actual)
	retained, err := actual.handle.Result(ctx)
	if err != nil || retained.Text != result.Text || f.physical.sends != 1 {
		t.Fatal("retained result replay", retained, err)
	}
	next := chatComputerInput(false)
	next.PreviousHandle = &h.HandleId
	follow, err := f.ingress.create(ctx, "next-turn", next)
	if err != nil || follow.Binding.TaskId != a.TaskId || follow.Binding.ParticipantId != a.ParticipantId || follow.Binding.TurnId == a.TurnId || follow.Binding.OperationId == a.AdmissionOperationId {
		t.Fatal("same conversation follow", follow, err)
	}
	preparedFollow, err := f.ingress.facade.PrepareNext(ctx, 10000)
	if err != nil || preparedFollow.ConversationID != result.ConversationID {
		t.Fatal("follow-up changed provider conversation", preparedFollow, err)
	}
	second, err := f.ingress.get(follow.HandleId)
	if err != nil {
		t.Fatal(err)
	}
	if err := second.handle.Send(ctx, 10000); err != nil {
		t.Fatal(err)
	}
	for n := 0; n < 2; n++ {
		if err := second.handle.Observe(ctx, 10000); err != nil {
			t.Fatal(err)
		}
	}
	secondResult := f.finish(t, second)
	if secondResult.ConversationID != result.ConversationID || f.physical.sends != 2 {
		t.Fatal("follow-up result lost identity or duplicated Send", secondResult)
	}
}

func TestReadIntentRechecksAuthorityAfterQueueBeforeSend(t *testing.T) {
	f, computer, a := readIntentFixture(t)
	ctx := context.Background()
	h, err := computer.promoteRead(ctx, "promote-before-revoke", readIntentPromotion(a))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.ingress.facade.PrepareNext(ctx, 10000); err != nil {
		t.Fatal(err)
	}
	if _, err := computer.Deactivate(ctx, "revoke-after-queue"); err != nil {
		t.Fatal(err)
	}
	actual, err := f.ingress.get(h.HandleId)
	if err != nil {
		t.Fatal(err)
	}
	before := len(f.journal.entries)
	if err := actual.send(ctx, 10000); err == nil || f.physical.sends != 0 || len(f.journal.entries) != before {
		t.Fatal("revoked queued intent reached Send", err)
	}
}

func TestReadIntentExplicitWithdrawalClosesCapturedAdmission(t *testing.T) {
	f, computer, a := readIntentFixture(t)
	ctx := context.Background()
	r, err := computer.withdrawRead(ctx, "explicit-discard", wire.ChatReadIntentWithdraw{Admission: a})
	if err != nil || r == nil || r.Admission != a || f.physical.sends != 0 || f.count("cancel") != 1 || f.count("acknowledge") != 1 {
		t.Fatal("withdraw", r, err)
	}
	claims, entries := len(computer.used), len(f.journal.entries)
	for _, command := range []string{"explicit-discard", "duplicate-discard"} {
		v, err := computer.withdrawRead(ctx, command, wire.ChatReadIntentWithdraw{Admission: a})
		if err != nil || v == nil || *v != *r || len(computer.used) != claims || len(f.journal.entries) != entries {
			t.Fatal("known withdrawal replay mutated claims or owner", v, err)
		}
	}
	if h, err := computer.promoteRead(ctx, "late-send", readIntentPromotion(a)); err == nil || h != nil || f.physical.sends != 0 {
		t.Fatal("withdrawn preview promoted", h, err)
	}
}

func TestReadIntentRevokedDuringVerifyNeverPhysicallySends(t *testing.T) {
	for _, raw := range []bool{false, true} {
		t.Run(map[bool]string{false: "ingress", true: "direct-handle"}[raw], func(t *testing.T) {
			f, computer, a := readIntentFixture(t)
			ctx := context.Background()
			h, err := computer.promoteRead(ctx, "promote", readIntentPromotion(a))
			if err != nil {
				t.Fatal(err)
			}
			if _, err := f.ingress.facade.PrepareNext(ctx, 10000); err != nil {
				t.Fatal(err)
			}
			actual, err := f.ingress.get(h.HandleId)
			if err != nil {
				t.Fatal(err)
			}
			verified := false
			f.physical.verifyHook = func() {
				verified = true
				if _, err := computer.Deactivate(ctx, "revoke-during-verification"); err != nil {
					t.Fatal(err)
				}
			}
			if raw {
				err = actual.handle.Send(ctx, 10000)
			} else {
				err = actual.send(ctx, 10000)
			}
			if err != nil || !verified || f.physical.sends != 0 || f.count("dispatch") != 1 || f.count("send-settled") != 1 {
				t.Fatal("revoked disclosure sent or failed to settle", err, verified, f.physical.sends)
			}
			result, err := actual.handle.Result(ctx)
			if err != nil || result.Outcome != "failed" || result.Code != "SEND_NOT_SENT" || result.Text != "" || result.Complete {
				t.Fatal("known not-sent result not retained", result, err)
			}
			before := len(f.journal.entries)
			if err := actual.handle.Send(ctx, 10000); err == nil || f.physical.sends != 0 || len(f.journal.entries) != before {
				t.Fatal("refused disclosure retried", err)
			}
			retained, err := actual.handle.Result(ctx)
			if err != nil || !reflect.DeepEqual(retained, result) {
				t.Fatal("retained refusal changed", retained, err)
			}
		})
	}
}

func TestReadIntentCrossedReceiptCannotSelectActualOwner(t *testing.T) {
	for _, field := range []string{"OwnerId", "SessionId", "TaskId", "TaskEpoch", "ParticipantId", "TurnId", "Generation", "AdmissionOperationId", "StoreRevision"} {
		t.Run(field, func(t *testing.T) {
			f, computer, a := readIntentFixture(t)
			v := reflect.ValueOf(&a).Elem().FieldByName(field)
			if field == "TaskEpoch" || field == "Generation" || field == "StoreRevision" {
				v.SetString("99")
			} else {
				v.SetString("crossed")
			}
			before := len(f.journal.entries)
			if h, err := computer.promoteRead(context.Background(), "crossed", readIntentPromotion(a)); err == nil || h != nil || len(f.journal.entries) != before || f.physical.sends != 0 {
				t.Fatal("crossed owner accepted", h, err)
			}
		})
	}
}

func TestReadIntentUnknownPromotionCannotDispatchOrWithdraw(t *testing.T) {
	f, computer, a := readIntentFixture(t)
	f.journal.fail = "promote-conversation"
	if h, err := computer.promoteRead(context.Background(), "lost-reply", readIntentPromotion(a)); err == nil || h != nil {
		t.Fatal("uncertain promotion accepted", h, err)
	}
	before := len(f.journal.entries)
	f.journal.fail = ""
	if h, err := computer.promoteRead(context.Background(), "replacement", readIntentPromotion(a)); err == nil || h != nil {
		t.Fatal("unknown promotion retried")
	}
	if r, err := computer.withdrawRead(context.Background(), "cleanup", wire.ChatReadIntentWithdraw{Admission: a}); err == nil || r != nil || len(f.journal.entries) != before || f.physical.sends != 0 {
		t.Fatal("unknown owner replayed or cleaned", r, err)
	}
}

func TestReadIntentWithdrawnAuthorityPreventsPromotion(t *testing.T) {
	f, computer, a := readIntentFixture(t)
	if _, err := computer.Deactivate(context.Background(), "settings-change"); err != nil {
		t.Fatal(err)
	}
	before := len(f.journal.entries)
	if h, err := computer.promoteRead(context.Background(), "stale-preview-send", readIntentPromotion(a)); err == nil || h != nil || len(f.journal.entries) != before || f.physical.sends != 0 {
		t.Fatal("stale preview promoted", h, err)
	}
	// Revocation does not silently discard the user's intent. Its actual owner
	// can still be explicitly withdrawn without another admission or Send.
	if _, err := computer.withdrawRead(context.Background(), "discard-stale-preview", wire.ChatReadIntentWithdraw{Admission: a}); err != nil {
		t.Fatal(err)
	}
}

func TestReadIntentFramedReadPromotionAndWithdrawal(t *testing.T) {
	for _, promote := range []bool{false, true} {
		t.Run(map[bool]string{false: "withdraw", true: "promote"}[promote], func(t *testing.T) {
			f := newChatComputerFixture(t)
			computer, _, native, _ := f.computer(t)
			computer.publication.receipt.SettingsRevision = "1"
			computer.publication.receipt.PublishOperationId = "publication"
			computer.publication.receipt.ApprovalDigest = strings.Repeat("a", 64)
			peer := chatComputerWireConnect(t, f, computer)
			a := taskWireTestData[wire.ChatComputerAdmissionResponse](t, peer.call("chat.turn", "wire-read-admission", chatComputerWireJSON(t, wire.ChatComputerAdmissionRequest{
				Publication: computer.publication.receipt, SessionId: "session", TaskId: "wire-task", TurnId: "wire-turn", WorkspaceIds: []string{"work"},
			})), "ChatComputerAdmissionResponse")
			read := taskWireTestData[wire.ComputerReadResponse](t, peer.call("computer.workspace.read", "", chatComputerWireJSON(t, wire.ComputerReadRequest{
				OwnerId: a.OwnerId, SessionId: a.SessionId, TaskId: a.TaskId, TaskEpoch: a.TaskEpoch, ParticipantId: a.ParticipantId,
				TurnId: a.TurnId, Generation: a.Generation, CallId: "file-read", WorkspaceId: "work", RelativePath: "note.md",
			})), "ComputerReadResponse")
			if read.Text != "test" || native.calls != 1 {
				t.Fatal("read result", read)
			}
			if promote {
				computer.accountClock = &accountSendClock{now: 1}
				_ = taskWireTestData[wire.ChatReadIntentAccountApproved](t, peer.call("chat.readintent.account.approve", "wire-account", chatComputerWireJSON(t, readAccountInput(a))), "ChatReadIntentAccountApproved")
				h := taskWireTestData[wire.ChatHandle](t, peer.call("chat.readintent.promote", "wire-send", chatComputerWireJSON(t, readIntentPromotion(a))), "ChatHandle")
				if h.Binding.OperationId != a.AdmissionOperationId || f.count("promote-conversation") != 1 {
					t.Fatal("promotion mapping", h)
				}
			} else {
				out := taskWireTestData[wire.ChatReadIntentWithdrawn](t, peer.call("chat.readintent.withdraw", "wire-discard", chatComputerWireJSON(t, wire.ChatReadIntentWithdraw{Admission: a})), "ChatReadIntentWithdrawn")
				if out.Admission != a || f.count("cancel") != 1 || f.count("acknowledge") != 1 {
					t.Fatal("withdrawal mapping", out)
				}
			}
			if f.physical.sends != 0 {
				t.Fatal("transport dispatched provider")
			}
		})
	}
}
