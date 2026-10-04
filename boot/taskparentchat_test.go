package boot

// Real admitted Chat facade -> Task's published-contract peer. The external
// Parent association is explicitly supplied by trusted test composition, not
// inferred from a TaskID. Browser/journal remain CPU doubles; this does not prove
// desktop caller/account qualification, provider dispatch or delivery ACK.
import (
	"context"
	"errors"
	"testing"

	"github.com/legrch/farol/modules/task/domain"
	parentpeer "github.com/legrch/farol/modules/task/infra/peer/parent"
)

func selectedTaskParent(h chatHandle) parentpeer.Selection {
	b := h.binding
	return parentpeer.Selection{Parent: task.Parent{ThreadID: "actual-external-parent-thread", TurnID: "actual-external-parent-turn"}, Binding: parentpeer.Binding{OwnerID: b.OwnerID, SessionID: b.SessionID, TaskID: b.TaskID, TaskEpoch: b.TaskEpoch, ParticipantID: b.ParticipantID, TurnID: b.TurnID}}
}
func actualTaskParentPeer(t *testing.T, h chatHandle, s parentpeer.Selection) *parentpeer.Peer {
	t.Helper()
	current, err := h.handle.Admission()
	if err != nil {
		t.Fatal(err)
	}
	peer, err := parentpeer.New(current, s)
	if err != nil {
		t.Fatal(err)
	}
	return peer
}
func TestTaskParentChatActualOwnerCompletionAndCancellationInvalidate(t *testing.T) {
	for _, cancelOwner := range []bool{false, true} {
		t.Run(map[bool]string{false: "completed", true: "cancelled"}[cancelOwner], func(t *testing.T) {
			f := newChatComputerFixture(t)
			h := f.start(t, "parent-chat", chatComputerInput(true))
			s := selectedTaskParent(h)
			peer := actualTaskParentPeer(t, h, s)
			ctx := context.Background()
			entries, sends := len(f.journal.entries), f.physical.sends
			if err := peer.RecheckParent(ctx, s.Parent); err != nil {
				t.Fatal("actual parent unavailable", err)
			}
			if err := peer.RecheckParent(ctx, task.Parent{ThreadID: h.binding.TaskID, TurnID: h.binding.TurnID}); !errors.Is(err, task.ErrIdentity) {
				t.Fatal("parent inferred from Chat identity", err)
			}
			if len(f.journal.entries) != entries || f.physical.sends != sends {
				t.Fatal("parent check performed effects")
			}
			if cancelOwner {
				if err := h.handle.Cancel(ctx); err != nil {
					t.Fatal(err)
				}
			} else {
				_ = f.finish(t, h)
			}
			entries, sends = len(f.journal.entries), f.physical.sends
			if err := peer.RecheckParent(ctx, s.Parent); err == nil {
				t.Fatal("terminal parent still admitted")
			}
			if len(f.journal.entries) != entries || f.physical.sends != sends {
				t.Fatal("inactive parent check restored effects")
			}
		})
	}
}
func TestTaskParentChatOtherHandleCannotSatisfyOriginalAssociation(t *testing.T) {
	f := newChatComputerFixture(t)
	h := f.start(t, "selected-parent-chat", chatComputerInput(true))
	first := selectedTaskParent(h)
	changed := first
	changed.Binding.TaskID = "foreign-chat-task"
	peer := actualTaskParentPeer(t, h, changed)
	if err := peer.RecheckParent(context.Background(), changed.Parent); !errors.Is(err, task.ErrIdentity) {
		t.Fatal("foreign selected binding succeeded", err)
	}
	_ = f.finish(t, h)
	next := chatComputerInput(true)
	next.PreviousHandle = &h.id
	next.Prompt = "Actual same-chat follow-up"
	following := f.start(t, "following-parent-chat", next)
	if following.binding.TaskID != h.binding.TaskID || following.binding.ParticipantID != h.binding.ParticipantID || following.binding.TurnID == h.binding.TurnID {
		t.Fatal("fixture lost actual conversation lineage")
	}
	stale := actualTaskParentPeer(t, following, first)
	if err := stale.RecheckParent(context.Background(), first.Parent); !errors.Is(err, task.ErrIdentity) {
		t.Fatal("new current turn restored old association", err)
	}
	current := selectedTaskParent(following)
	current.Parent.TurnID = "actual-external-follow-up-turn"
	if err := actualTaskParentPeer(t, following, current).RecheckParent(context.Background(), current.Parent); err != nil {
		t.Fatal("new explicit association failed", err)
	}
	if f.physical.sends != 2 {
		t.Fatal("parent checks sent another turn")
	}
}
