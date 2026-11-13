// Package output reduces committed semantic browser blocks without DOM knowledge.
// A stable segment identifies content; equal text is not an identity. State is
// copied before publication and retains only bounded explicit delivery content.
package output

import (
	"unicode/utf8"

	opaque "github.com/legrch/farol/pkg/kernel/domain/id"
)

type Code string

func (c Code) Error() string { return string(c) }

const (
	Invalid     Code = "CHAT_OUTPUT_INVALID"
	Correlation Code = "CHAT_OUTPUT_CORRELATION"
	Changed     Code = "CHAT_OUTPUT_CHANGED"
	Capacity    Code = "CHAT_OUTPUT_CAPACITY"
)
const MaxSegments = 128

type Segment struct{ ID, Text string }
type State struct {
	UserID, ReplyID             string
	Accepted, Complete          bool
	limit                       int
	previousUser, previousReply string
	segments                    []Segment
	text                        string
}

func New(limit int, previousUser, previousReply string) State {
	return State{limit: limit, previousUser: previousUser, previousReply: previousReply}
}
func (s State) Text() string { return s.text }
func (s State) Accept(user string) (State, bool, error) {
	if !opaque.Valid(user) || user == s.previousUser {
		return s, false, Correlation
	}
	if s.Accepted {
		if user == s.UserID {
			return s, true, nil
		}
		return s, false, Correlation
	}
	if s.Complete {
		return s, false, Correlation
	}
	s.Accepted, s.UserID = true, user
	return s, false, nil
}
func (s State) Block(user, reply, segment, text string) (State, bool, error) {
	if !s.Accepted || user != s.UserID || !opaque.Valid(reply) || reply == s.previousReply || (s.ReplyID != "" && s.ReplyID != reply) {
		return s, false, Correlation
	}
	if !opaque.Valid(segment) || text == "" || !utf8.ValidString(text) {
		return s, false, Invalid
	}
	for _, old := range s.segments {
		if old.ID == segment {
			if old.Text == text {
				return s, true, nil
			}
			return s, false, Changed
		}
	}
	if s.Complete {
		return s, false, Correlation
	}
	if len(s.segments) >= MaxSegments || len(s.text)+len(text) > s.limit {
		return s, false, Capacity
	}
	s.segments = append(append([]Segment(nil), s.segments...), Segment{segment, text})
	s.ReplyID, s.text = reply, s.text+text
	return s, false, nil
}
func (s State) Finish(user, reply string) (State, error) {
	if !s.Accepted || len(s.segments) == 0 || s.Complete || user != s.UserID || reply != s.ReplyID {
		return s, Correlation
	}
	s.Complete = true
	return s, nil
}
