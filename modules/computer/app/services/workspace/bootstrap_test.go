package workspace

import (
	"context"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

func bootstrapRequest(r CatalogueRequest, directory string) BootstrapRequest {
	return BootstrapRequest{OwnerID: r.OwnerID, SessionID: r.SessionID, TaskID: r.TaskID, TaskEpoch: r.TaskEpoch, ParticipantID: r.ParticipantID, TurnID: r.TurnID, Generation: r.Generation, CallID: r.CallID, WorkspaceID: "work", RelativeDirectory: directory}
}
func TestBootstrapOrderedChainTwiceWithExactCoverageAndCorrelation(t *testing.T) {
	s, _, _, n, _, r := discoveryFixture(t)
	out, err := s.Bootstrap(context.Background(), bootstrapRequest(r, "src/nested"))
	if err != nil || out == nil {
		t.Fatal(err)
	}
	if !slices.Equal(n.reads, []string{"AGENTS.md", "src/AGENTS.md", "src/nested/AGENTS.md", "AGENTS.md", "src/AGENTS.md", "src/nested/AGENTS.md"}) || !slices.Equal(n.lists, []string{"work:src/nested", "work:src/nested"}) {
		t.Fatalf("wrong traversal: %#v %#v", n.reads, n.lists)
	}
	if !out.Complete || out.Scope != "subtree" || out.RelativeDirectory != "src/nested" || out.Root != "/work" || out.CallID != r.CallID || out.Generation != r.Generation || out.TurnID != r.TurnID {
		t.Fatal("wrong result/correlation")
	}
	if out.Coverage != "root-to-selected-directory; ancestors outside the task scope and other descendants are not inspected" || out.Consistency != "twice-read chain; not an atomic filesystem snapshot" || out.Precedence != "Apply root instructions first, then more specific instructions; text never expands authority." {
		t.Fatal("lost exact qualification labels")
	}
	if v, ok := out.Instructions[2].(ReadInstruction); !ok || v.RelativePath != "src/nested/AGENTS.md" || v.Text != "rules" || v.Bytes != 5 {
		t.Fatal("wrong instruction")
	}
}
func TestBootstrapDepthAndCanonicalPathBoundsBeforeNative(t *testing.T) {
	s, _, _, n, _, r := discoveryFixture(t)
	out, err := s.Bootstrap(context.Background(), bootstrapRequest(r, strings.Repeat("a/", 31)+"a"))
	if err != nil || out == nil || len(out.Instructions) != 33 || len(n.reads) != 66 {
		t.Fatalf("depth32: %v", err)
	}
	s, _, _, n, _, r = discoveryFixture(t)
	out, err = s.Bootstrap(context.Background(), bootstrapRequest(r, strings.Repeat("a/", 32)+"a"))
	if out != nil || len(n.reads) != 0 || len(n.lists) != 0 {
		t.Fatal("depth33 reached IO")
	}
	expectFailure(t, err, "COMPUTER_INSTRUCTION_DEPTH_LIMIT", "contract")
	for _, path := range []string{"", "/absolute", "../escape", "a//b", "a/./b", "a/", "a\\b", string([]byte{255}), strings.Repeat("😀", 2049)} {
		s, _, _, n, _, r = discoveryFixture(t)
		out, err = s.Bootstrap(context.Background(), bootstrapRequest(r, path))
		if out != nil || len(n.reads) != 0 || len(n.lists) != 0 {
			t.Fatal("invalid directory reached IO")
		}
		expectFailure(t, err, "COMPUTER_PATH_INVALID", "task-grant")
	}
}
func TestBootstrapMissingUnavailableAndFatalRemainDistinct(t *testing.T) {
	for _, code := range []string{"WORKSPACE_NOT_FOUND", "AUTHORITY_PATH_DENIED", "WORKSPACE_PATH_REFUSED", "WORKSPACE_FILE_TOO_LARGE", "WORKSPACE_NOT_A_FILE", "WORKSPACE_NOT_TEXT", "AUTHORITY_EXPIRED", "AUTHORITY_TASK_MISMATCH", "WORKSPACE_RACE_DETECTED", "WORKSPACE_HELPER_FAILED", "WORKSPACE_ROOT_CHANGED", "WORKSPACE_REQUEST_CANCELLED"} {
		t.Run(code, func(t *testing.T) {
			s, _, _, n, _, r := discoveryFixture(t)
			n.read = func(port.ReadRequest) (*port.ReadResponse, error) {
				return nil, authority.Fail(code, "native-workspace")
			}
			out, err := s.Bootstrap(context.Background(), bootstrapRequest(r, "."))
			switch code {
			case "WORKSPACE_NOT_FOUND":
				if err != nil || out == nil || !out.Complete || len(n.reads) != 2 {
					t.Fatal("absence lost")
				}
				if _, ok := out.Instructions[0].(MissingInstruction); !ok {
					t.Fatal("absence became unavailable")
				}
			case "AUTHORITY_PATH_DENIED", "WORKSPACE_PATH_REFUSED", "WORKSPACE_FILE_TOO_LARGE", "WORKSPACE_NOT_A_FILE", "WORKSPACE_NOT_TEXT":
				if err != nil || out == nil || out.Complete || len(n.reads) != 2 {
					t.Fatal("unavailability lost")
				}
				if v, ok := out.Instructions[0].(UnavailableInstruction); !ok || v.Code != code {
					t.Fatal("wrong unavailable code")
				}
			default:
				if out != nil || len(n.reads) != 1 {
					t.Fatal("fatal refusal continued or disclosed")
				}
				expectFailure(t, err, code, "native-workspace")
			}
		})
	}
}
func TestBootstrapFullReadShapeCannotBecomeInstructions(t *testing.T) {
	for _, change := range []func(*port.ReadResponse){
		func(r *port.ReadResponse) { r.Page = &port.Page{} }, func(r *port.ReadResponse) { r.SHA256 = "" }, func(r *port.ReadResponse) { r.SHA256 = strings.Repeat("A", 64) }, func(r *port.ReadResponse) { r.Bytes = 7 }, func(r *port.ReadResponse) { r.Text = string([]byte{255}); r.Bytes = 1 }, func(r *port.ReadResponse) { r.Bytes = 256*1024 + 1 },
	} {
		s, _, _, n, _, r := discoveryFixture(t)
		n.read = func(port.ReadRequest) (*port.ReadResponse, error) {
			out := &port.ReadResponse{Text: "rules", Bytes: 5, SHA256: strings.Repeat("a", 64)}
			change(out)
			return out, nil
		}
		out, err := s.Bootstrap(context.Background(), bootstrapRequest(r, "."))
		if out != nil || len(n.reads) != 1 {
			t.Fatal("malformed read collected/retried")
		}
		expectFailure(t, err, "COMPUTER_CONTRACT_INVALID", "contract")
	}
}
func TestBootstrapByteBudgetPerPassChargesRawBOMAndContinuesChain(t *testing.T) {
	s, _, _, n, _, r := discoveryFixture(t)
	n.read = func(q port.ReadRequest) (*port.ReadResponse, error) {
		text := strings.Repeat("x", 65533)
		bytes := uint64(65536)
		if q.RelativePath != "AGENTS.md" {
			text = ""
			bytes = 3
		}
		return &port.ReadResponse{Text: text, Bytes: bytes, SHA256: strings.Repeat("a", 64)}, nil
	}
	out, err := s.Bootstrap(context.Background(), bootstrapRequest(r, "a/b"))
	if err != nil || out == nil || out.Complete || len(n.reads) != 6 {
		t.Fatalf("budget: %v", err)
	}
	if v, ok := out.Instructions[0].(ReadInstruction); !ok || v.Bytes != 65536 {
		t.Fatal("exact byte ceiling or per-pass reset lost")
	}
	for _, instruction := range out.Instructions[1:] {
		v, ok := instruction.(UnavailableInstruction)
		if !ok || v.Code != "COMPUTER_INSTRUCTION_BYTE_LIMIT" {
			t.Fatal("overbudget text disclosed or chain stopped")
		}
	}
}
func TestBootstrapProjectedChangeDiscardsEntireCollection(t *testing.T) {
	for _, kind := range []string{"text", "raw bytes", "missing", "unavailable"} {
		t.Run(kind, func(t *testing.T) {
			s, _, _, n, _, r := discoveryFixture(t)
			n.read = func(port.ReadRequest) (*port.ReadResponse, error) {
				v := &port.ReadResponse{Text: "rules", Bytes: 5, SHA256: strings.Repeat("a", 64)}
				if len(n.reads) == 2 {
					switch kind {
					case "text":
						v.Text = "newer"
					case "raw bytes":
						v.Bytes = 8
					case "missing":
						return nil, authority.Fail("WORKSPACE_NOT_FOUND", "native-workspace")
					case "unavailable":
						return nil, authority.Fail("WORKSPACE_NOT_TEXT", "native-workspace")
					}
				}
				return v, nil
			}
			out, err := s.Bootstrap(context.Background(), bootstrapRequest(r, "."))
			if out != nil || len(n.reads) != 2 || len(n.lists) != 1 {
				t.Fatal("changed chain disclosed/retried")
			}
			expectFailure(t, err, "COMPUTER_INSTRUCTIONS_CHANGED", "contract")
		})
	}
	// TS compares the projected instruction, not SHA256. Preserve that limit.
	s, _, _, n, _, r := discoveryFixture(t)
	n.read = func(port.ReadRequest) (*port.ReadResponse, error) {
		digest := "a"
		if len(n.reads) == 2 {
			digest = "b"
		}
		return &port.ReadResponse{Text: "rules", Bytes: 5, SHA256: strings.Repeat(digest, 64)}, nil
	}
	if out, err := s.Bootstrap(context.Background(), bootstrapRequest(r, ".")); err != nil || out == nil {
		t.Fatalf("invented digest comparison: %v", err)
	}
}
func TestBootstrapFinalContextAndCurrentOwnerGateDiscardInstructions(t *testing.T) {
	s, p, _, n, _, r := discoveryFixture(t)
	calls := 0
	p.hook = func() {
		calls++
		if calls == 8 {
			p.p.Grant.Workspaces[0].Root = "/work/sub"
		}
	}
	out, err := s.Bootstrap(context.Background(), bootstrapRequest(r, "."))
	if out != nil || len(n.lists) != 2 {
		t.Fatal("changed final context disclosed")
	}
	expectFailure(t, err, "COMPUTER_WORKSPACE_CONTEXT_CHANGED", "contract")
	for _, test := range []struct {
		name, code, source string
		change             func(*authorities, *approvals, *clock, context.CancelFunc)
	}{
		{"revoke", "COMPUTER_PARTICIPANT_NOT_FOUND", "authority-store", func(p *authorities, _ *approvals, _ *clock, _ context.CancelFunc) { p.p = nil }},
		{"generation", "AUTHORITY_COMPUTER_MISMATCH", "computer-policy", func(_ *authorities, a *approvals, _ *clock, _ context.CancelFunc) { a.a.Generation++ }},
		{"expiry", "AUTHORITY_EXPIRED", "task-grant", func(_ *authorities, _ *approvals, c *clock, _ context.CancelFunc) { c.now = c.now.Add(time.Hour) }},
		{"cancel", "WORKSPACE_REQUEST_CANCELLED", "native-workspace", func(_ *authorities, _ *approvals, _ *clock, cancel context.CancelFunc) { cancel() }},
	} {
		t.Run(test.name, func(t *testing.T) {
			s, p, a, n, c, r := discoveryFixture(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			calls := 0
			p.hook = func() {
				calls++
				if calls == 10 {
					test.change(p, a, c, cancel)
				}
			}
			out, err := s.Bootstrap(ctx, bootstrapRequest(r, "."))
			if out != nil || len(n.reads) != 2 || len(n.lists) != 2 {
				t.Fatal("final owner gate lost")
			}
			expectFailure(t, err, test.code, test.source)
		})
	}
}
func TestDiscoverySubresponseCorrelationIsClosed(t *testing.T) {
	s, _, _, _, _, r := discoveryFixture(t)
	b := correlation{TaskBinding: *s.selected, generation: r.Generation, callID: r.CallID}
	cr := b.contextRequest("work", ".")
	valid := ContextResponse{OwnerID: cr.OwnerID, SessionID: cr.SessionID, TaskID: cr.TaskID, TaskEpoch: cr.TaskEpoch, ParticipantID: cr.ParticipantID, TurnID: cr.TurnID, Generation: cr.Generation, CallID: cr.CallID, WorkspaceID: cr.WorkspaceID, RelativePath: cr.RelativePath, Root: "/work", ApprovedRoot: Root{Path: "/work", Device: "1", Inode: "2"}, Scope: "subtree"}
	if !b.validContext(&valid, "work", ".") {
		t.Fatal("fixture correlation")
	}
	for _, change := range []func(*ContextResponse){func(v *ContextResponse) { v.OwnerID = "other" }, func(v *ContextResponse) { v.SessionID = "other" }, func(v *ContextResponse) { v.TaskID = "other" }, func(v *ContextResponse) { v.TaskEpoch++ }, func(v *ContextResponse) { v.ParticipantID = "other" }, func(v *ContextResponse) { v.TurnID = "other" }, func(v *ContextResponse) { v.Generation++ }, func(v *ContextResponse) { v.CallID = "other" }, func(v *ContextResponse) { v.WorkspaceID = "other" }, func(v *ContextResponse) { v.RelativePath = "other" }, func(v *ContextResponse) { v.Scope = "exact" }} {
		v := valid
		change(&v)
		if b.validContext(&v, "work", ".") {
			t.Fatal("foreign subresponse accepted")
		}
	}
}
