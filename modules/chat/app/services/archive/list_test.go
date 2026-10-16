package archive

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
)

func TestListReportsOnlyCurrentOwnerObservationsWithoutTerminalAuthority(t *testing.T) {
	s, _, store := fixture(t)
	page, err := s.List(context.Background(), ListQuery{})
	if err != nil || page.Observation != Observation || !page.Unresolved || len(page.Entries) != 1 || page.Entries[0].RecordedOutcome != "completed" {
		t.Fatal("lost observation", page, err)
	}
	if store.selectedList != (port.ArchiveListSelection{ProfileID: "profile", OwnerID: "owner"}) {
		t.Fatal("request selected authority")
	}
	page.Entries[0].ResultID = "changed"
	if store.page.Entries[0].ResultID != "result" {
		t.Fatal("returned slice aliases storage")
	}
	// The store's completed value remains explicitly unconfirmed. There is no
	// HistoryOrigin, live binding, result receipt, complete/ACK flag or handle.
}
func TestListWithholdsLateInvalidOrCrossedObservations(t *testing.T) {
	for _, kind := range []string{"withdraw", "scope", "cancel", "profile", "owner", "order", "cursor", "oversize", "nil", "nil-entries", "digest", "outcome", "error"} {
		t.Run(kind, func(t *testing.T) {
			s, a, store := fixture(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			switch kind {
			case "withdraw":
				store.afterIO = func() { a.closed = true }
			case "scope":
				store.afterIO = func() { a.scope.BackendGeneration = "replacement" }
			case "cancel":
				store.afterIO = cancel
			case "profile":
				store.page.Entries[0].ProfileID = "other"
			case "owner":
				store.page.Entries[0].OwnerID = "other"
			case "order":
				store.page.Entries = append(store.page.Entries, store.page.Entries[0])
			case "cursor":
				store.page.Next = store.page.Entries[0].Key
			case "oversize":
				for len(store.page.Entries) <= port.ArchivePageSize {
					store.page.Entries = append(store.page.Entries, store.page.Entries[0])
				}
			case "nil":
				store.page = nil
			case "nil-entries":
				store.page.Entries = nil
			case "digest":
				store.page.Entries[0].Digest = [32]byte{}
			case "outcome":
				store.page.Entries[0].RecordedOutcome = "accepted"
			case "error":
				store.err = errors.New("storage unavailable")
			}
			if page, err := s.List(ctx, ListQuery{}); page != nil || err == nil {
				t.Fatal("unsafe observation exposed", page, err)
			}
		})
	}
}
func TestListValidatesInputBeforeIOAndAllowsPagingBeyondLiveQueue(t *testing.T) {
	s, _, store := fixture(t)
	if page, err := s.List(context.Background(), ListQuery{After: "invalid"}); page != nil || !errors.Is(err, Invalid) || store.listCalls != 0 {
		t.Fatal("invalid cursor reached archive")
	}
	store.page.Entries = nil
	for n := 0; n < port.ArchivePageSize; n++ {
		v := store.reply.Summary
		v.Key = fmt.Sprintf("%064x", n+2049)
		store.page.Entries = append(store.page.Entries, v)
	}
	store.page.Next = store.page.Entries[len(store.page.Entries)-1].Key
	if page, err := s.List(context.Background(), ListQuery{After: fmt.Sprintf("%064x", 2048)}); err != nil || len(page.Entries) != port.ArchivePageSize || page.Next == "" {
		t.Fatal("bounded page depended on live queue cap", err)
	}
	store.page = &port.ArchivePage{Entries: []port.ArchiveSummary{}}
	if page, err := s.List(context.Background(), ListQuery{After: strings.Repeat("f", 64)}); err != nil || page.Next != "" || page.Entries == nil {
		t.Fatal("empty observed tail refused", err)
	}
}
