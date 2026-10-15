package settingsworkspace

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// Pure owner/current/native doubles only. No filesystem or interpreter is used.
type ownerSearchNative struct {
	*nativeFixture
	calls  int
	search func(context.Context, port.SearchRequest) (*port.SearchResponse, error)
}

func (n *ownerSearchNative) Search(ctx context.Context, r port.SearchRequest) (*port.SearchResponse, error) {
	n.calls++
	return n.search(ctx, r)
}
func ownerSearchFixture() (*fixture, *ownerSearchNative) {
	f := newFixture()
	f.approval.Capabilities = []authority.Capability{authority.Search}
	n := &ownerSearchNative{nativeFixture: f.native, search: ownerSearchOutput}
	f.service.native = n
	return f, n
}
func ownerSearchOutput(_ context.Context, r port.SearchRequest) (*port.SearchResponse, error) {
	path := "nested/note.md"
	if r.RelativePath != "." {
		path = r.RelativePath
	}
	return &port.SearchResponse{Binding: &port.DirectoryBinding{Root: r.Workspace.Root, RelativePath: r.RelativePath, ApprovedRoot: r.Workspace.ApprovedRoot}, Matches: []port.SearchMatch{{Path: path, Line: 2, Text: "known 🌊\ttext", Truncated: true}}, ResultLimited: true}, nil
}
func ownerSearchRequest() SearchRequest {
	return SearchRequest{WorkspaceID: "work", RelativePath: ".", Pattern: "known"}
}
func ownerSearchFailure(t *testing.T, out *SearchResult, err error, code string) {
	t.Helper()
	var f *authority.Failure
	if out != nil || !errors.As(err, &f) || f.Code != code {
		t.Fatalf("out=%+v err=%v, want %s", out, err, code)
	}
}

func TestOwnerSearchBindingAndIndependentValues(t *testing.T) {
	for _, policy := range []authority.FilePolicy{authority.LegacyProtectedFiles, authority.RootScopedFiles} {
		t.Run(string(policy), func(t *testing.T) {
			f, n := ownerSearchFixture()
			f.approval.FilePolicy = policy
			f.approval.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: "/work/private"}}
			ctx := context.WithValue(context.Background(), struct{}{}, "original")
			var raw *port.SearchResponse
			n.search = func(got context.Context, r port.SearchRequest) (*port.SearchResponse, error) {
				if got != ctx || r.Pattern != "known" || r.RelativePath != "." || r.Workspace.FilePolicy != policy || r.Workspace.WorkspaceID != "work" || r.Workspace.Root != "/work" || r.Workspace.ApprovedRoot != (port.Root{Path: "/work", Device: "12", Inode: "34"}) || !reflect.DeepEqual(r.Workspace.DeniedPaths, []string{"private"}) || r.Workspace.ExactFilePaths != nil {
					t.Fatalf("lost binding: %+v", r)
				}
				r.Workspace.DeniedPaths[0] = "modified-request"
				raw, _ = ownerSearchOutput(got, r)
				return raw, nil
			}
			f.afterCurrent = func(call int, _ *authority.Approval, err error) error {
				if call == 2 {
					raw.Matches[0].Text = "later"
					raw.Matches[0].Path = "../escape"
					raw.Binding.ApprovedRoot.Inode = "99"
					raw.ResultLimited, raw.ScanLimited = false, true
				}
				return err
			}
			out, err := f.service.Search(ctx, ownerSearchRequest())
			if err != nil || out == nil || out.WorkspaceID != "work" || out.RelativePath != "." || out.Pattern != "known" || out.Root != (port.Root{Path: "/work", Device: "12", Inode: "34"}) || len(out.Matches) != 1 || out.Matches[0] != (SearchMatch{Path: "nested/note.md", Line: 2, Text: "known 🌊\ttext", Truncated: true}) || !out.ResultLimited || out.ScanLimited {
				t.Fatalf("%+v %v", out, err)
			}
			if n.calls != 1 || f.native.calls != 0 || f.currentCalls != 2 || f.approval.ExcludedPaths[0].Path != "/work/private" {
				t.Fatal("wrong dispatch or shared approval")
			}
			out.Matches[0].Text = "caller"
			if raw.Matches[0].Text != "later" {
				t.Fatal("output aliases native")
			}
		})
	}
}

func TestOwnerSearchAdmissionRefusals(t *testing.T) {
	for _, tc := range []struct {
		name, code string
		change     func(*fixture, *SearchRequest)
	}{
		{"read only", "AUTHORITY_CAPABILITY_DENIED", func(f *fixture, _ *SearchRequest) { f.approval.Capabilities = []authority.Capability{authority.Read} }},
		{"list only", "AUTHORITY_CAPABILITY_DENIED", func(f *fixture, _ *SearchRequest) { f.approval.Capabilities = []authority.Capability{authority.List} }},
		{"expired", "AUTHORITY_EXPIRED", func(f *fixture, _ *SearchRequest) { f.approval.ExpiresAt = f.clock.now }},
		{"excluded scope", "AUTHORITY_PATH_DENIED", func(f *fixture, r *SearchRequest) {
			f.approval.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: "/work/Café"}}
			r.RelativePath = "CAFE/child"
		}},
		{"unknown workspace", "AUTHORITY_PATH_DENIED", func(_ *fixture, r *SearchRequest) { r.WorkspaceID = "other" }},
		{"invalid workspace", "COMPUTER_INVALID_REQUEST", func(_ *fixture, r *SearchRequest) { r.WorkspaceID = "" }},
		{"traversal", "COMPUTER_INVALID_REQUEST", func(_ *fixture, r *SearchRequest) { r.RelativePath = "../escape" }},
		{"empty pattern", "WORKSPACE_INVALID_REQUEST", func(_ *fixture, r *SearchRequest) { r.Pattern = "" }},
		{"invalid UTF8", "WORKSPACE_INVALID_REQUEST", func(_ *fixture, r *SearchRequest) { r.Pattern = "\xff" }},
		{"pattern byte limit", "WORKSPACE_INVALID_REQUEST", func(_ *fixture, r *SearchRequest) { r.Pattern = strings.Repeat("🌊", 1025) }},
		{"control pattern", "WORKSPACE_INVALID_REQUEST", func(_ *fixture, r *SearchRequest) { r.Pattern = "bad\npattern" }},
		{"DEL pattern", "WORKSPACE_INVALID_REQUEST", func(_ *fixture, r *SearchRequest) { r.Pattern = "bad\x7fpattern" }},
		{"missing search port", "WORKSPACE_HELPER_FAILED", func(f *fixture, _ *SearchRequest) { f.service.native = f.native }},
		{"invalid root identity", "COMPUTER_APPROVAL_INVALID", func(f *fixture, _ *SearchRequest) { f.approval.Workspaces[0].RootIdentity.Inode = "" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f, n := ownerSearchFixture()
			r := ownerSearchRequest()
			tc.change(f, &r)
			out, err := f.service.Search(context.Background(), r)
			ownerSearchFailure(t, out, err, tc.code)
			if n.calls != 0 || f.native.calls != 0 {
				t.Fatal("refused operation reached native")
			}
		})
	}
}

func TestOwnerSearchFinalAuthorityChanges(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(*fixture)
	}{
		{"owner", func(f *fixture) { f.approval.OwnerID = "other" }},
		{"computer", func(f *fixture) { f.approval.ComputerID = "other" }},
		{"generation", func(f *fixture) { f.approval.Generation++ }},
		{"root", func(f *fixture) { f.approval.Workspaces[0].Root = "/other" }},
		{"root inode", func(f *fixture) { f.approval.Workspaces[0].RootIdentity.Inode = "35" }},
		{"root device", func(f *fixture) { f.approval.Workspaces[0].RootIdentity.Device = "13" }},
		{"file policy", func(f *fixture) { f.approval.FilePolicy = authority.RootScopedFiles }},
		{"capability", func(f *fixture) { f.approval.Capabilities = nil }},
		{"exclusions", func(f *fixture) {
			f.approval.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: "/work/nested"}}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f, n := ownerSearchFixture()
			n.search = func(ctx context.Context, r port.SearchRequest) (*port.SearchResponse, error) {
				out, err := ownerSearchOutput(ctx, r)
				tc.change(f)
				return out, err
			}
			out, err := f.service.Search(context.Background(), ownerSearchRequest())
			ownerSearchFailure(t, out, err, "AUTHORITY_COMPUTER_MISMATCH")
			if n.calls != 1 {
				t.Fatal("retried")
			}
		})
	}
	for _, phase := range []int{1, 2} {
		t.Run(fmt.Sprintf("withdrawal/%d", phase), func(t *testing.T) {
			f, n := ownerSearchFixture()
			calls := 0
			f.service.current = currentFunc(func(_ context.Context, cb func(*authority.Approval) error) error {
				calls++
				if calls == phase {
					return cb(nil)
				}
				a := f.approval.Clone()
				return cb(&a)
			})
			out, err := f.service.Search(context.Background(), ownerSearchRequest())
			ownerSearchFailure(t, out, err, "COMPUTER_APPROVAL_NOT_FOUND")
			if n.calls != phase-1 {
				t.Fatal("wrong dispatch count")
			}
		})
	}
}

func TestOwnerSearchFixedDeadline(t *testing.T) {
	for _, tc := range []struct {
		name                         string
		elapsed, expiry, finalExpiry time.Duration
		ok                           bool
	}{
		{"before deadline", 15*time.Second - time.Nanosecond, time.Hour, time.Hour, true},
		{"deadline exact", 15 * time.Second, time.Hour, time.Hour, false},
		{"original expiry despite renewal", 5 * time.Second, 5 * time.Second, time.Hour, false},
		{"shortened expiry", 5 * time.Second, time.Hour, 5 * time.Second, false},
		{"renewal within original lease", 4 * time.Second, 5 * time.Second, time.Hour, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f, n := ownerSearchFixture()
			start := f.clock.now
			f.approval.ExpiresAt = start.Add(tc.expiry)
			n.search = func(ctx context.Context, r port.SearchRequest) (*port.SearchResponse, error) {
				out, err := ownerSearchOutput(ctx, r)
				f.clock.now = start.Add(tc.elapsed)
				f.approval.ExpiresAt = start.Add(tc.finalExpiry)
				return out, err
			}
			out, err := f.service.Search(context.Background(), ownerSearchRequest())
			if tc.ok {
				if out == nil || err != nil {
					t.Fatalf("%+v %v", out, err)
				}
			} else {
				ownerSearchFailure(t, out, err, "AUTHORITY_EXPIRED")
			}
		})
	}
	for _, phase := range []int{1, 2} {
		f, n := ownerSearchFixture()
		f.afterCurrent = func(call int, _ *authority.Approval, err error) error {
			if call == phase {
				f.clock.now = f.clock.now.Add(15 * time.Second)
			}
			return err
		}
		out, err := f.service.Search(context.Background(), ownerSearchRequest())
		ownerSearchFailure(t, out, err, "AUTHORITY_EXPIRED")
		if n.calls != phase-1 {
			t.Fatal("late dispatch or retry")
		}
	}
	f, n := ownerSearchFixture()
	deadline := f.clock.now.Add(time.Second)
	ctx := deadlineContext{context.Background(), deadline}
	n.search = func(ctx context.Context, r port.SearchRequest) (*port.SearchResponse, error) {
		out, err := ownerSearchOutput(ctx, r)
		f.clock.now = deadline
		return out, err
	}
	out, err := f.service.Search(ctx, ownerSearchRequest())
	ownerSearchFailure(t, out, err, "AUTHORITY_EXPIRED")
}

func TestOwnerSearchMalformedOutputAndScope(t *testing.T) {
	for _, tc := range []struct {
		name, code string
		change     func(*port.SearchResponse)
	}{
		{"nil binding", "WORKSPACE_HELPER_FAILED", func(o *port.SearchResponse) { o.Binding = nil }},
		{"crossed path", "WORKSPACE_ROOT_CHANGED", func(o *port.SearchResponse) { o.Binding.RelativePath = "other" }},
		{"crossed root", "WORKSPACE_ROOT_CHANGED", func(o *port.SearchResponse) { o.Binding.Root = "/other" }},
		{"crossed approved root", "WORKSPACE_ROOT_CHANGED", func(o *port.SearchResponse) { o.Binding.ApprovedRoot.Path = "/other" }},
		{"crossed inode", "WORKSPACE_ROOT_CHANGED", func(o *port.SearchResponse) { o.Binding.ApprovedRoot.Inode = "35" }},
		{"crossed device", "WORKSPACE_ROOT_CHANGED", func(o *port.SearchResponse) { o.Binding.ApprovedRoot.Device = "13" }},
		{"too many", "WORKSPACE_HELPER_FAILED", func(o *port.SearchResponse) { o.Matches = make([]port.SearchMatch, 101) }},
		{"zero line", "WORKSPACE_HELPER_FAILED", func(o *port.SearchResponse) { o.Matches[0].Line = 0 }},
		{"unsafe line", "WORKSPACE_HELPER_FAILED", func(o *port.SearchResponse) { o.Matches[0].Line = 9007199254740992 }},
		{"invalid text", "WORKSPACE_HELPER_FAILED", func(o *port.SearchResponse) { o.Matches[0].Text = "\xff" }},
		{"multiline text", "WORKSPACE_HELPER_FAILED", func(o *port.SearchResponse) { o.Matches[0].Text = "one\ntwo" }},
		{"control text", "WORKSPACE_HELPER_FAILED", func(o *port.SearchResponse) { o.Matches[0].Text = "one\x7ftwo" }},
		{"excerpt scalar bound", "WORKSPACE_HELPER_FAILED", func(o *port.SearchResponse) { o.Matches[0].Text = strings.Repeat("🌊", 501) }},
		{"root match", "WORKSPACE_HELPER_FAILED", func(o *port.SearchResponse) { o.Matches[0].Path = "." }},
		{"traversal", "WORKSPACE_HELPER_FAILED", func(o *port.SearchResponse) { o.Matches[0].Path = "../secret" }},
		{"absolute match", "WORKSPACE_HELPER_FAILED", func(o *port.SearchResponse) { o.Matches[0].Path = "/work/file" }},
		{"outside subtree", "WORKSPACE_HELPER_FAILED", func(o *port.SearchResponse) { o.Matches[0].Path = "nested-other/file" }},
		{"excluded alias", "AUTHORITY_PATH_DENIED", func(o *port.SearchResponse) { o.Matches[0].Path = "nested/PRIVATE/file" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f, n := ownerSearchFixture()
			r := ownerSearchRequest()
			r.RelativePath = "nested"
			f.approval.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: "/work/nested/private"}}
			n.search = func(ctx context.Context, r port.SearchRequest) (*port.SearchResponse, error) {
				out, err := ownerSearchOutput(ctx, r)
				tc.change(out)
				return out, err
			}
			out, err := f.service.Search(context.Background(), r)
			ownerSearchFailure(t, out, err, tc.code)
		})
	}
	for _, code := range []string{"WORKSPACE_INVALID_REQUEST", "WORKSPACE_SEARCH_TIMEOUT", "WORKSPACE_PATH_REFUSED"} {
		f, n := ownerSearchFixture()
		n.search = func(ctx context.Context, r port.SearchRequest) (*port.SearchResponse, error) {
			out, _ := ownerSearchOutput(ctx, r)
			return out, authority.Fail(code, "native-workspace")
		}
		out, err := f.service.Search(context.Background(), ownerSearchRequest())
		ownerSearchFailure(t, out, err, code)
		if n.calls != 1 {
			t.Fatal("native refusal retried")
		}
	}
	for _, nativeErr := range []error{nil, errors.New("private native diagnostic"), authority.Fail("PRIVATE", "private")} {
		f, n := ownerSearchFixture()
		n.search = func(context.Context, port.SearchRequest) (*port.SearchResponse, error) { return nil, nativeErr }
		out, err := f.service.Search(context.Background(), ownerSearchRequest())
		ownerSearchFailure(t, out, err, "WORKSPACE_HELPER_FAILED")
	}
}

func TestOwnerSearchPartialBounds(t *testing.T) {
	for _, size := range []int{0, 100} {
		for _, flags := range [][2]bool{{false, false}, {true, false}, {false, true}, {true, true}} {
			f, n := ownerSearchFixture()
			n.search = func(ctx context.Context, r port.SearchRequest) (*port.SearchResponse, error) {
				out, err := ownerSearchOutput(ctx, r)
				out.Matches = nil
				for i := 0; i < size; i++ {
					out.Matches = append(out.Matches, port.SearchMatch{Path: "note.md", Line: 9007199254740991, Text: strings.Repeat("🌊", 500), Truncated: i%2 == 0})
				}
				out.ResultLimited, out.ScanLimited = flags[0], flags[1]
				return out, err
			}
			r := ownerSearchRequest()
			r.Pattern = strings.Repeat("🌊", 1024)
			out, err := f.service.Search(context.Background(), r)
			if err != nil || out == nil || out.Matches == nil || len(out.Matches) != size || out.ResultLimited != flags[0] || out.ScanLimited != flags[1] {
				t.Fatalf("%+v %v", out, err)
			}
		}
	}
}

func TestOwnerSearchSelectedFileAndSubtree(t *testing.T) {
	for _, tc := range []struct{ scope, path string }{
		{"nested/note.md", "nested/note.md"},
		{"nested", "nested/deeper/note.md"},
	} {
		f, n := ownerSearchFixture()
		r := ownerSearchRequest()
		r.RelativePath = tc.scope
		n.search = func(ctx context.Context, request port.SearchRequest) (*port.SearchResponse, error) {
			out, err := ownerSearchOutput(ctx, request)
			out.Matches[0].Path = tc.path
			return out, err
		}
		out, err := f.service.Search(context.Background(), r)
		if err != nil || out == nil || out.RelativePath != tc.scope || out.Matches[0].Path != tc.path || n.calls != 1 {
			t.Fatalf("%+v %v", out, err)
		}
	}
}

func TestOwnerSearchCallbackProtocol(t *testing.T) {
	for _, phase := range []int{1, 2} {
		for _, kind := range []string{"skipped", "repeated", "mutated", "error after callback", "swallowed"} {
			t.Run(fmt.Sprintf("%s/%d", kind, phase), func(t *testing.T) {
				f, n := ownerSearchFixture()
				calls := 0
				f.service.current = currentFunc(func(_ context.Context, cb func(*authority.Approval) error) error {
					calls++
					a := f.approval.Clone()
					if calls != phase {
						return cb(&a)
					}
					switch kind {
					case "skipped":
						return nil
					case "repeated":
						_ = cb(&a)
						_ = cb(&a)
						return nil
					case "mutated":
						err := cb(&a)
						a.Workspaces[0].RootIdentity.Inode = "99"
						return err
					case "error after callback":
						_ = cb(&a)
						return errors.New("private")
					default:
						_ = cb(nil)
						return nil
					}
				})
				out, err := f.service.Search(context.Background(), ownerSearchRequest())
				code := "COMPUTER_AUTHORITY_STORE_UNAVAILABLE"
				if kind == "swallowed" {
					code = "COMPUTER_APPROVAL_NOT_FOUND"
				}
				ownerSearchFailure(t, out, err, code)
				if n.calls != phase-1 {
					t.Fatal("bad callback dispatched or retried")
				}
			})
		}
	}
	f, n := ownerSearchFixture()
	var late func(*authority.Approval) error
	f.service.current = currentFunc(func(_ context.Context, cb func(*authority.Approval) error) error { late = cb; return nil })
	out, err := f.service.Search(context.Background(), ownerSearchRequest())
	ownerSearchFailure(t, out, err, "COMPUTER_AUTHORITY_STORE_UNAVAILABLE")
	a := f.approval.Clone()
	if late(&a) == nil || n.calls != 0 {
		t.Fatal("late callback admitted search")
	}
}

func TestOwnerSearchCancellationAndDependencies(t *testing.T) {
	for _, phase := range []int{0, 1, 2} {
		f, n := ownerSearchFixture()
		ctx, cancel := context.WithCancel(context.Background())
		if phase == 0 {
			cancel()
		} else if phase == 1 {
			n.search = func(ctx context.Context, r port.SearchRequest) (*port.SearchResponse, error) {
				out, err := ownerSearchOutput(ctx, r)
				cancel()
				return out, err
			}
		} else {
			f.afterCurrent = func(call int, _ *authority.Approval, err error) error {
				if call == 2 {
					cancel()
				}
				return err
			}
		}
		out, err := f.service.Search(ctx, ownerSearchRequest())
		ownerSearchFailure(t, out, err, "WORKSPACE_REQUEST_CANCELLED")
		if phase == 0 && n.calls != 0 {
			t.Fatal("cancelled dispatch")
		}
		cancel()
	}
	f, n := ownerSearchFixture()
	out, err := f.service.Search(nil, ownerSearchRequest())
	ownerSearchFailure(t, out, err, "WORKSPACE_REQUEST_CANCELLED")
	if n.calls != 0 {
		t.Fatal("nil context dispatch")
	}
	for _, s := range []*Service{nil, New(nil, n, f.clock), New(f.service.current, nil, f.clock), New(f.service.current, n, nil)} {
		out, err := s.Search(context.Background(), ownerSearchRequest())
		ownerSearchFailure(t, out, err, "COMPUTER_AUTHORITY_STORE_UNAVAILABLE")
	}
}
