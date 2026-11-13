package boot

import (
	"context"
	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/modules/chat/contracts/conversation"
	"github.com/legrch/farol/transport/desktop"
)

// Read the exact live owner. This is a projection, never a Send grant, delivery
// ACK, physical cleanup claim or reconstruction from a provider URL.
func (s *ChatIngress) conversationState(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
	var in wire.ChatHandleRequest
	if r.OperationID != "" || chatDecode("ChatHandleRequest", r, &in) != nil {
		return invalidIngress()
	}
	h, err := s.get(in.HandleId)
	if err != nil {
		return invalidIngress()
	}
	var out wire.ChatState
	err = h.handle.WithState(ctx, func(state conversation.State) error {
		out = wire.ChatState{Handle: chatWireHandle(h), ConversationId: state.ConversationID, Phase: state.Phase, HasResult: state.HasResult, DeliveryAcknowledged: state.DeliveryAcknowledged, LifecycleSettled: state.LifecycleSettled, Released: state.Released, FollowReady: state.FollowReady}
		return nil
	})
	return chatOutcome("ChatState", out, err)
}
