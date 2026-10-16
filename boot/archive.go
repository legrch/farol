package boot

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/modules/chat/app/services/archive"
	"github.com/legrch/farol/transport/desktop"
)

// Recovery-only read adapters. Their DTOs do not implement normal history,
// conversation delivery, handoff, acknowledgement or execution interfaces.
func archiveSummary(value archive.Summary) wire.ChatArchiveSummary {
	return wire.ChatArchiveSummary{Key: value.Key, Digest: hex.EncodeToString(value.Digest[:]), BackendGeneration: value.BackendGeneration, OperationId: value.OperationID, ResultId: value.ResultID, ConversationId: value.ConversationID, RecordedOutcome: value.RecordedOutcome, Bytes: uint32(value.Bytes)}
}
func archiveOutcome(shape string, value any, err error) (*desktop.Outcome, error) {
	if err != nil {
		status, code := "unavailable", string(archive.Unavailable)
		var classified archive.Code
		if errors.As(err, &classified) {
			code = string(classified)
			if classified == archive.Invalid || classified == archive.Refused {
				status = "refused"
			}
		}
		return &desktop.Outcome{Status: status, Code: code}, nil
	}
	raw, err := json.Marshal(value)
	if err != nil || wire.Validate(shape, raw) != nil {
		return &desktop.Outcome{Status: "unavailable", Code: string(archive.Unavailable)}, nil
	}
	return &desktop.Outcome{Status: "ok", Data: raw}, nil
}
func chatArchiveMethods(service *archive.Service) map[string]desktop.Method {
	return map[string]desktop.Method{
		"chat.archive.list": {Concurrent: true, Handle: func(ctx context.Context, request desktop.Request) (*desktop.Outcome, error) {
			var in wire.ChatArchiveListRequest
			if request.OperationID != "" || chatDecode("ChatArchiveListRequest", request, &in) != nil {
				return invalidIngress()
			}
			page, err := service.List(ctx, archive.ListQuery{After: in.After})
			if err != nil {
				return archiveOutcome("", nil, err)
			}
			out := wire.ChatArchivePage{Observation: page.Observation, Next: page.Next, Unresolved: page.Unresolved, Entries: make([]wire.ChatArchiveSummary, 0, len(page.Entries))}
			for _, entry := range page.Entries {
				out.Entries = append(out.Entries, archiveSummary(entry))
			}
			return archiveOutcome("ChatArchivePage", out, nil)
		}},
		"chat.archive.read": {Concurrent: true, Handle: func(ctx context.Context, request desktop.Request) (*desktop.Outcome, error) {
			var in wire.ChatArchiveReadRequest
			if request.OperationID != "" || chatDecode("ChatArchiveReadRequest", request, &in) != nil {
				return invalidIngress()
			}
			raw, err := hex.DecodeString(in.Digest)
			if err != nil || len(raw) != 32 || hex.EncodeToString(raw) != in.Digest {
				return invalidIngress()
			}
			var digest [32]byte
			copy(digest[:], raw)
			reply, err := service.Read(ctx, archive.ReadQuery{Key: in.Key, Digest: digest})
			if err != nil {
				return archiveOutcome("", nil, err)
			}
			return archiveOutcome("ChatArchiveReply", wire.ChatArchiveReply{Observation: reply.Observation, Summary: archiveSummary(reply.Summary), Text: reply.Text}, nil)
		}},
	}
}
