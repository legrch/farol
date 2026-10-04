package admission

import (
	"context"

	"github.com/legrch/farol/modules/chat/contracts/conversation"
	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// ChatSend maps the actual final-disclosure capability only. It never upgrades
// the ordinary Chat admission projection while a browser effect is pending.
type ChatSend struct{ current *conversation.SendCurrent }

func NewChatSend(current *conversation.SendCurrent) (*ChatSend, error) {
	if current == nil {
		return nil, unavailable()
	}
	return &ChatSend{current: current}, nil
}
func (c *ChatSend) WithCurrent(ctx context.Context, inspect func(*port.TaskBinding) error) error {
	if c == nil || c.current == nil {
		return unavailable()
	}
	return inspectCurrent(ctx, inspect, func(project func(*port.TaskBinding) error) error {
		return c.current.WithCurrent(ctx, func(b *conversation.Binding) error {
			if b == nil {
				return unavailable()
			}
			out := port.TaskBinding{Identity: authority.Identity{OwnerID: b.OwnerID, SessionID: b.SessionID, TaskID: b.TaskID, TaskEpoch: b.TaskEpoch}, ParticipantID: b.ParticipantID, TurnID: b.TurnID}
			return project(&out)
		})
	}, func(error) error { return unavailable() })
}
