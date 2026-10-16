package archive

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
)

// Pure consumer-port doubles only; no native storage/host/provider evidence.
type authorityFixture struct {
	scope  port.HistoryReadScope
	closed bool
	calls  int
}

func (a *authorityFixture) AdmitHistoryRead(context.Context) (port.HistoryReadLease, error) {
	return a, nil
}
func (a *authorityFixture) WithCurrent(ctx context.Context, inspect func(port.HistoryReadScope) error) error {
	a.calls++
	if a.closed || ctx.Err() != nil {
		return errors.New("withdrawn")
	}
	return inspect(a.scope)
}

type storeFixture struct {
	page                 *port.ArchivePage
	reply                *port.ArchivedReply
	err                  error
	listCalls, readCalls int
	selectedList         port.ArchiveListSelection
	selectedRead         port.ArchiveReadSelection
	afterIO              func()
}

func (s *storeFixture) ListStoredReplies(_ context.Context, query port.ArchiveListSelection) (*port.ArchivePage, error) {
	s.listCalls++
	s.selectedList = query
	if s.afterIO != nil {
		s.afterIO()
	}
	return s.page, s.err
}
func (s *storeFixture) ReadStoredReply(_ context.Context, query port.ArchiveReadSelection) (*port.ArchivedReply, error) {
	s.readCalls++
	s.selectedRead = query
	if s.afterIO != nil {
		s.afterIO()
	}
	return s.reply, s.err
}
func fixture(t *testing.T) (*Service, *authorityFixture, *storeFixture) {
	t.Helper()
	a := &authorityFixture{scope: port.HistoryReadScope{ProfileID: "profile", BackendGeneration: "current", OwnerID: "owner"}}
	summary := port.ArchiveSummary{Key: strings.Repeat("a", 64), ProfileID: "profile", OwnerID: "owner", BackendGeneration: "old", OperationID: "operation", ResultID: "result", ConversationID: "conversation", RecordedOutcome: "completed", Bytes: 6, Digest: [32]byte{1}}
	s := &storeFixture{page: &port.ArchivePage{Entries: []port.ArchiveSummary{summary}, Unresolved: true}, reply: &port.ArchivedReply{Summary: summary, Text: "stored"}}
	service, err := New(port.JournalScope{ProfileID: "profile", BackendGeneration: "current"}, Dependencies{Authority: a, Store: s})
	if err != nil {
		t.Fatal(err)
	}
	return service, a, s
}
func TestNewDoesNotTouchAnOldArchive(t *testing.T) {
	_, a, s := fixture(t)
	if a.calls != 0 || s.listCalls != 0 || s.readCalls != 0 {
		t.Fatal("constructor inspected old storage")
	}
	for _, deps := range []Dependencies{{}, {Authority: a}, {Store: s}} {
		if v, err := New(port.JournalScope{ProfileID: "profile", BackendGeneration: "current"}, deps); v != nil || !errors.Is(err, Invalid) {
			t.Fatal("incomplete composition accepted", err)
		}
	}
}
