package boot

import (
	"context"
	"encoding/json"
	"os"
	"strconv"
	"strings"
	"testing"

	wire "github.com/legrch/farol/gen/desktop/v1"
	chatport "github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/app/services/archive"
	"github.com/legrch/farol/transport/desktop"
)

type archiveStoreFixture struct {
	calls int
	reply *chatport.ArchivedReply
}

func (s *archiveStoreFixture) ListStoredReplies(context.Context, chatport.ArchiveListSelection) (*chatport.ArchivePage, error) {
	s.calls++
	return &chatport.ArchivePage{Entries: []chatport.ArchiveSummary{}}, nil
}
func (s *archiveStoreFixture) ReadStoredReply(context.Context, chatport.ArchiveReadSelection) (*chatport.ArchivedReply, error) {
	s.calls++
	if s.reply != nil {
		return s.reply, nil
	}
	return nil, archive.Unavailable
}
func TestArchiveIngressRejectsEffectsAuthorityFieldsAndInvalidSelections(t *testing.T) {
	store := &archiveStoreFixture{}
	a, err := newHistoryReadAuthority(context.Background(), chatport.HistoryReadScope{ProfileID: "profile", BackendGeneration: "recovery", OwnerID: "owner"}, func() error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	s, err := archive.New(chatport.JournalScope{ProfileID: "profile", BackendGeneration: "recovery"}, archive.Dependencies{Authority: a, Store: store})
	if err != nil {
		t.Fatal(err)
	}
	methods := chatArchiveMethods(s)
	for _, tc := range []struct{ method, body, operation string }{
		{"list", `{"after":""}`, "effect"},
		{"list", `{"after":"","ownerId":"other"}`, ""},
		{"list", `{"after":"../journal"}`, ""},
		{"read", `{"key":"` + strings.Repeat("a", 64) + `","digest":"` + strings.Repeat("a", 64) + `","profileId":"other"}`, ""},
		{"read", `{"key":"` + strings.Repeat("a", 64) + `","digest":"` + strings.Repeat("a", 64) + `"}`, "effect"},
		{"read", `{"key":"` + strings.Repeat("a", 64) + `","digest":"` + strings.Repeat("0", 64) + `"}`, ""},
	} {
		out, err := methods["chat.archive."+tc.method].Handle(context.Background(), desktop.Request{Body: json.RawMessage(tc.body), OperationID: tc.operation})
		if err != nil || out == nil || out.Status != "refused" || len(out.Data) != 0 || store.calls != 0 {
			t.Fatal("invalid query reached archive", out, err)
		}
	}
	out, err := methods["chat.archive.list"].Handle(context.Background(), desktop.Request{Body: json.RawMessage(`{"after":""}`)})
	if err != nil || out.Status != "ok" || store.calls != 1 || wire.Validate("ChatArchivePage", out.Data) != nil || string(out.Data) != `{"observation":"stored_unconfirmed","entries":[],"next":"","unresolved":false}` {
		t.Fatal("unconfirmed empty observation not exact", out, err)
	}
	a.close()
	out, err = methods["chat.archive.list"].Handle(context.Background(), desktop.Request{Body: json.RawMessage(`{"after":""}`)})
	if err != nil || out.Status != "refused" || len(out.Data) != 0 || store.calls != 1 {
		t.Fatal("closed authority reached archive", out, err)
	}
}

func TestArchiveWireRejectsPromotedProofsInBothResponseShapes(t *testing.T) {
	raw, err := os.ReadFile("../api/desktop/v1/fixtures/chat-archive.json")
	if err != nil || wire.Validate("ChatArchiveReply", raw) != nil {
		t.Fatal("invalid synthetic archive fixture", err)
	}
	for _, kind := range []string{"provenance", "outcome", "ack", "complete", "owner"} {
		var value map[string]any
		if err := json.Unmarshal(raw, &value); err != nil {
			t.Fatal(err)
		}
		switch kind {
		case "provenance":
			value["observation"] = "completed"
		case "outcome":
			value["summary"].(map[string]any)["recordedOutcome"] = "accepted"
		case "ack":
			value["acknowledged"] = true
		case "complete":
			value["complete"] = true
		case "owner":
			value["ownerId"] = "other"
		}
		changed, err := json.Marshal(value)
		if err != nil || wire.Validate("ChatArchiveReply", changed) == nil {
			t.Fatal("promoted archive proof accepted", kind, err)
		}
	}
	if wire.Validate("ChatHistoryResult", raw) == nil {
		t.Fatal("archive DTO became accepted historical result")
	}
}

func TestArchiveIngressPreservesEmptyMultilineAndMaximumStoredText(t *testing.T) {
	for _, text := range []string{"", "first line\n<script>plain text</script> ✓", strings.Repeat("x", 8192), strings.Repeat("✓", 2730) + "ab"} {
		t.Run(strconv.Itoa(len(text)), func(t *testing.T) {
			digest := [32]byte{1}
			summary := chatport.ArchiveSummary{Key: strings.Repeat("a", 64), Digest: digest, ProfileID: "profile", OwnerID: "owner", BackendGeneration: "original", OperationID: "original-operation", ResultID: "stored-result", RecordedOutcome: "completed", Bytes: len(text)}
			store := &archiveStoreFixture{reply: &chatport.ArchivedReply{Summary: summary, Text: text}}
			a, err := newHistoryReadAuthority(context.Background(), chatport.HistoryReadScope{ProfileID: "profile", BackendGeneration: "recovery", OwnerID: "owner"}, func() error { return nil })
			if err != nil {
				t.Fatal(err)
			}
			service, err := archive.New(chatport.JournalScope{ProfileID: "profile", BackendGeneration: "recovery"}, archive.Dependencies{Authority: a, Store: store})
			if err != nil {
				t.Fatal(err)
			}
			query, _ := json.Marshal(wire.ChatArchiveReadRequest{Key: summary.Key, Digest: "01" + strings.Repeat("00", 31)})
			out, err := chatArchiveMethods(service)["chat.archive.read"].Handle(context.Background(), desktop.Request{Body: query})
			if err != nil || out.Status != "ok" || wire.Validate("ChatArchiveReply", out.Data) != nil {
				t.Fatal("literal retained text rejected", out, err)
			}
			var reply wire.ChatArchiveReply
			if json.Unmarshal(out.Data, &reply) != nil || reply.Text != text || int(reply.Summary.Bytes) != len(text) || reply.Observation != "stored_unconfirmed" {
				t.Fatal("retained bytes or provenance changed")
			}
		})
	}
	raw, err := os.ReadFile("../api/desktop/v1/fixtures/chat-archive.json")
	if err != nil {
		t.Fatal(err)
	}
	var value map[string]any
	if json.Unmarshal(raw, &value) != nil {
		t.Fatal("fixture decode")
	}
	value["text"] = strings.Repeat("x", 8193)
	raw, err = json.Marshal(value)
	if err != nil || wire.Validate("ChatArchiveReply", raw) == nil {
		t.Fatal("oversized stored text accepted")
	}
}
