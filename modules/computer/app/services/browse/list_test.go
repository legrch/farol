package browse

import (
	"context"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

func TestBoundListAndIndependentCopies(t *testing.T) {
	f := newFixture()
	f.approval.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: "/work/secret"}}
	var output *port.ListResponse
	var sent port.ListRequest
	f.native.list = func(_ context.Context, r port.ListRequest) (*port.ListResponse, error) {
		sent = r
		output = &port.ListResponse{Binding: &port.DirectoryBinding{RelativePath: r.RelativePath, Root: r.Workspace.Root, ApprovedRoot: r.Workspace.ApprovedRoot}, Entries: []string{"file.txt"}, Truncated: true}
		r.Workspace.DeniedPaths[0] = "modified-native-request"
		return output, nil
	}
	f.afterCurrent = func(call int, _ *authority.Approval, err error) error {
		if call == 2 {
			output.Entries[0] = "later-output"
			output.Binding.ApprovedRoot.Path = "/later"
		}
		return err
	}
	in := request()
	out, err := f.service.List(context.Background(), in)
	if err != nil || out == nil {
		t.Fatalf("%+v %v", out, err)
	}
	if out.Root != (port.Root{Path: "/work", Device: "12", Inode: "34"}) || !reflect.DeepEqual(out.Entries, []string{"file.txt"}) || !out.Truncated || out.WorkspaceID != in.WorkspaceID || out.RelativePath != in.RelativePath {
		t.Fatalf("%+v", out)
	}
	if f.native.calls != 1 || f.currentCalls != 2 || sent.Workspace.ExactFilePaths != nil || f.approval.ExcludedPaths[0].Path != "/work/secret" {
		t.Fatal("wrong dispatch or shared authority")
	}
	out.Entries[0] = "caller-change"
	if output.Entries[0] != "later-output" {
		t.Fatal("shared output")
	}
}
func TestAdmissionRefusals(t *testing.T) {
	cases := []struct {
		name, code string
		change     func(*fixture)
		req        ListQuery
	}{
		{"missing list", "AUTHORITY_CAPABILITY_DENIED", func(f *fixture) { f.approval.Capabilities = []authority.Capability{authority.Read} }, request()},
		{"empty capabilities", "AUTHORITY_CAPABILITY_DENIED", func(f *fixture) { f.approval.Capabilities = nil }, request()},
		{"expired", "AUTHORITY_EXPIRED", func(f *fixture) { f.approval.ExpiresAt = f.clock.now.Add(-time.Millisecond) }, request()},
		{"expiry exact", "AUTHORITY_EXPIRED", func(f *fixture) { f.approval.ExpiresAt = f.clock.now }, request()},
		{"excluded alias", "AUTHORITY_PATH_DENIED", func(f *fixture) {
			f.approval.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: "/work/Café"}}
		}, ListQuery{WorkspaceID: "work", RelativePath: "CAFE\u0301/child"}},
		{"excluded loose alias", "AUTHORITY_PATH_DENIED", func(f *fixture) {
			f.approval.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: "/work/Café"}}
		}, ListQuery{WorkspaceID: "work", RelativePath: "CAFE"}},
		{"traversal", "COMPUTER_INVALID_REQUEST", nil, ListQuery{WorkspaceID: "work", RelativePath: "../private"}},
		{"absolute", "COMPUTER_INVALID_REQUEST", nil, ListQuery{WorkspaceID: "work", RelativePath: "/work"}},
		{"empty path", "COMPUTER_INVALID_REQUEST", nil, ListQuery{WorkspaceID: "work"}},
		{"long component", "COMPUTER_INVALID_REQUEST", nil, ListQuery{WorkspaceID: "work", RelativePath: strings.Repeat("x", 256)}},
		{"root binding absent", "COMPUTER_APPROVAL_INVALID", func(f *fixture) { f.approval.Workspaces[0].RootIdentity.Inode = "" }, request()},
		{"duplicate workspace", "COMPUTER_APPROVAL_INVALID", func(f *fixture) { f.approval.Workspaces = append(f.approval.Workspaces, f.approval.Workspaces[0]) }, request()},
		{"unknown workspace", "AUTHORITY_PATH_DENIED", nil, ListQuery{WorkspaceID: "other", RelativePath: "."}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture()
			if tc.change != nil {
				tc.change(f)
			}
			out, err := f.service.List(context.Background(), tc.req)
			assertFailure(t, out, err, tc.code)
			if f.native.calls != 0 {
				t.Fatal("native dispatch after refusal")
			}
		})
	}
}
func TestFinalWithdrawalAndPolicyChanges(t *testing.T) {
	changes := []struct {
		name   string
		change func(*fixture)
	}{
		{"owner", func(f *fixture) { f.approval.OwnerID = "other" }},
		{"computer", func(f *fixture) { f.approval.ComputerID = "other" }},
		{"generation", func(f *fixture) { f.approval.Generation++ }},
		{"root", func(f *fixture) { f.approval.Workspaces[0].Root = "/other" }},
		{"inode", func(f *fixture) { f.approval.Workspaces[0].RootIdentity.Inode = "35" }},
		{"git metadata", func(f *fixture) { f.approval.Workspaces[0].GitMetadata.CommonDirectory = "/other" }},
		{"access", func(f *fixture) { f.approval.Workspaces[0].Access = authority.WriteAccess }},
		{"capability", func(f *fixture) { f.approval.Capabilities = nil }},
		{"exclusion", func(f *fixture) {
			f.approval.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: "/work/file.txt"}}
		}},
		{"network", func(f *fixture) { f.approval.Network = authority.ApprovedNetwork }},
		{"commands", func(f *fixture) { f.approval.Commands = authority.WorkspaceCommands }},
	}
	for _, tc := range changes {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture()
			list := f.native.list
			f.native.list = func(ctx context.Context, r port.ListRequest) (*port.ListResponse, error) {
				out, err := list(ctx, r)
				tc.change(f)
				return out, err
			}
			out, err := f.service.List(context.Background(), request())
			assertFailure(t, out, err, "AUTHORITY_COMPUTER_MISMATCH")
		})
	}
	for _, phase := range []int{1, 2} {
		t.Run("nil approval phase "+string(rune('0'+phase)), func(t *testing.T) {
			f := newFixture()
			calls := 0
			f.service.current = currentFunc(func(_ context.Context, cb func(*authority.Approval) error) error {
				calls++
				if calls == phase {
					return cb(nil)
				}
				a := f.approval.Clone()
				return cb(&a)
			})
			out, err := f.service.List(context.Background(), request())
			assertFailure(t, out, err, "COMPUTER_APPROVAL_NOT_FOUND")
			if phase == 1 && f.native.calls != 0 {
				t.Fatal("dispatched")
			}
		})
	}
}
func TestFixedLifetimeAndExpiry(t *testing.T) {
	cases := []struct {
		name                         string
		elapsed, expiry, finalExpiry time.Duration
		ok                           bool
	}{
		{"before deadline", 15*time.Second - time.Nanosecond, time.Hour, time.Hour, true},
		{"deadline exact", 15 * time.Second, time.Hour, time.Hour, false},
		{"after deadline", 16 * time.Second, time.Hour, time.Hour, false},
		{"original expiry exact despite renewal", 5 * time.Second, 5 * time.Second, time.Hour, false},
		{"shortened expiry exact", 5 * time.Second, time.Hour, 5 * time.Second, false},
		{"renewal within original lease", 4 * time.Second, 5 * time.Second, time.Hour, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture()
			start := f.clock.now
			f.approval.ExpiresAt = start.Add(tc.expiry)
			list := f.native.list
			f.native.list = func(ctx context.Context, r port.ListRequest) (*port.ListResponse, error) {
				out, err := list(ctx, r)
				f.clock.now = start.Add(tc.elapsed)
				f.approval.ExpiresAt = start.Add(tc.finalExpiry)
				return out, err
			}
			out, err := f.service.List(context.Background(), request())
			if tc.ok {
				if err != nil || out == nil {
					t.Fatalf("%+v %v", out, err)
				}
			} else {
				assertFailure(t, out, err, "AUTHORITY_EXPIRED")
			}
		})
	}
	t.Run("clock moves between callback and dispatch", func(t *testing.T) {
		f := newFixture()
		f.afterCurrent = func(_ int, _ *authority.Approval, err error) error {
			f.clock.now = f.clock.now.Add(15 * time.Second)
			return err
		}
		out, err := f.service.List(context.Background(), request())
		assertFailure(t, out, err, "AUTHORITY_EXPIRED")
		if f.native.calls != 0 {
			t.Fatal("late native dispatch")
		}
	})
	t.Run("clock moves after final callback", func(t *testing.T) {
		f := newFixture()
		f.afterCurrent = func(call int, _ *authority.Approval, err error) error {
			if call == 2 {
				f.clock.now = f.clock.now.Add(15 * time.Second)
			}
			return err
		}
		out, err := f.service.List(context.Background(), request())
		assertFailure(t, out, err, "AUTHORITY_EXPIRED")
	})
}
func TestMalformedNativeOutput(t *testing.T) {
	cases := []struct {
		name, code string
		change     func(*port.ListResponse)
	}{
		{"nil binding", "WORKSPACE_HELPER_FAILED", func(o *port.ListResponse) { o.Binding = nil }},
		{"crossed path", "WORKSPACE_ROOT_CHANGED", func(o *port.ListResponse) { o.Binding.RelativePath = "other" }},
		{"crossed root", "WORKSPACE_ROOT_CHANGED", func(o *port.ListResponse) { o.Binding.Root = "/other" }},
		{"crossed approved path", "WORKSPACE_ROOT_CHANGED", func(o *port.ListResponse) { o.Binding.ApprovedRoot.Path = "/other" }},
		{"crossed device", "WORKSPACE_ROOT_CHANGED", func(o *port.ListResponse) { o.Binding.ApprovedRoot.Device = "13" }},
		{"crossed inode", "WORKSPACE_ROOT_CHANGED", func(o *port.ListResponse) { o.Binding.ApprovedRoot.Inode = "35" }},
		{"too many entries", "WORKSPACE_HELPER_FAILED", func(o *port.ListResponse) { o.Entries = make([]string, 501) }},
		{"traversal entry", "WORKSPACE_HELPER_FAILED", func(o *port.ListResponse) { o.Entries = []string{"../secret"} }},
		{"nested entry", "WORKSPACE_HELPER_FAILED", func(o *port.ListResponse) { o.Entries = []string{"nested/file"} }},
		{"empty entry", "WORKSPACE_HELPER_FAILED", func(o *port.ListResponse) { o.Entries = []string{""} }},
		{"duplicate entry", "WORKSPACE_HELPER_FAILED", func(o *port.ListResponse) { o.Entries = []string{"same", "same/"} }},
		{"double slash", "WORKSPACE_HELPER_FAILED", func(o *port.ListResponse) { o.Entries = []string{"folder//"} }},
		{"excluded entry alias", "AUTHORITY_PATH_DENIED", func(o *port.ListResponse) { o.Entries = []string{"SECRET/"} }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture()
			f.approval.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: "/work/secret"}}
			list := f.native.list
			f.native.list = func(ctx context.Context, r port.ListRequest) (*port.ListResponse, error) {
				out, err := list(ctx, r)
				tc.change(out)
				return out, err
			}
			out, err := f.service.List(context.Background(), request())
			assertFailure(t, out, err, tc.code)
		})
	}
	t.Run("nil output", func(t *testing.T) {
		f := newFixture()
		f.native.list = func(context.Context, port.ListRequest) (*port.ListResponse, error) { return nil, nil }
		out, err := f.service.List(context.Background(), request())
		assertFailure(t, out, err, "WORKSPACE_HELPER_FAILED")
	})
}
func TestNilAndCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	for _, c := range []context.Context{nil, ctx} {
		f := newFixture()
		out, err := f.service.List(c, request())
		assertFailure(t, out, err, "WORKSPACE_REQUEST_CANCELLED")
		if f.native.calls != 0 {
			t.Fatal("cancelled dispatch")
		}
	}
	for _, s := range []*Service{nil, New(nil, &nativeFixture{}, &testClock{}), New(currentFunc(nil), nil, &testClock{}), New(currentFunc(nil), &nativeFixture{}, nil)} {
		out, err := s.List(context.Background(), request())
		assertFailure(t, out, err, "COMPUTER_AUTHORITY_STORE_UNAVAILABLE")
	}
}

// The deadline context is a pure value fixture; it owns no timer or goroutine.
type deadlineContext struct {
	context.Context
	deadline time.Time
}

func (c deadlineContext) Deadline() (time.Time, bool) { return c.deadline, true }
func TestCallerDeadlineExact(t *testing.T) {
	for _, during := range []bool{false, true} {
		f := newFixture()
		d := f.clock.now.Add(3 * time.Second)
		ctx := deadlineContext{context.Background(), d}
		if during {
			list := f.native.list
			f.native.list = func(ctx context.Context, r port.ListRequest) (*port.ListResponse, error) {
				out, err := list(ctx, r)
				f.clock.now = d
				return out, err
			}
		} else {
			f.clock.now = d
		}
		out, err := f.service.List(ctx, request())
		assertFailure(t, out, err, "AUTHORITY_EXPIRED")
		if !during && f.native.calls != 0 {
			t.Fatal("deadline dispatch")
		}
	}
}

func TestNativeBoundedCases(t *testing.T) {
	for _, size := range []int{0, 500} {
		for _, truncated := range []bool{false, true} {
			t.Run(fmt.Sprintf("%d/%v", size, truncated), func(t *testing.T) {
				f := newFixture()
				list := f.native.list
				f.native.list = func(ctx context.Context, r port.ListRequest) (*port.ListResponse, error) {
					out, err := list(ctx, r)
					out.Entries = make([]string, size)
					for i := range out.Entries {
						out.Entries[i] = fmt.Sprintf("entry-%d", i)
					}
					out.Truncated = truncated
					return out, err
				}
				out, err := f.service.List(context.Background(), request())
				if err != nil || out == nil || len(out.Entries) != size || out.Truncated != truncated {
					t.Fatalf("%+v %v", out, err)
				}
			})
		}
	}
}
func TestNativeErrorWithOutputRefuses(t *testing.T) {
	f := newFixture()
	list := f.native.list
	f.native.list = func(ctx context.Context, r port.ListRequest) (*port.ListResponse, error) {
		out, _ := list(ctx, r)
		return out, authority.Fail("WORKSPACE_PATH_REFUSED", "native-workspace")
	}
	out, err := f.service.List(context.Background(), request())
	assertFailure(t, out, err, "WORKSPACE_PATH_REFUSED")
	if f.currentCalls != 1 || f.native.calls != 1 {
		t.Fatal("unexpected retry or disclosure")
	}
}
func TestCancellationDuringIOAndAfterFinalCallback(t *testing.T) {
	for _, afterFinal := range []bool{false, true} {
		f := newFixture()
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		if afterFinal {
			f.afterCurrent = func(call int, _ *authority.Approval, err error) error {
				if call == 2 {
					cancel()
				}
				return err
			}
		} else {
			list := f.native.list
			f.native.list = func(ctx context.Context, r port.ListRequest) (*port.ListResponse, error) {
				out, err := list(ctx, r)
				cancel()
				return out, err
			}
		}
		out, err := f.service.List(ctx, request())
		assertFailure(t, out, err, "WORKSPACE_REQUEST_CANCELLED")
	}
}
func TestSelectedDirectoryBindingAndExclusions(t *testing.T) {
	f := newFixture()
	f.approval.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: "/work/selected/secret"}}
	list := f.native.list
	f.native.list = func(ctx context.Context, r port.ListRequest) (*port.ListResponse, error) {
		if r.RelativePath != "selected" || r.Workspace.Root != "/work" || !reflect.DeepEqual(r.Workspace.DeniedPaths, []string{"selected/secret"}) {
			t.Fatalf("wrong descriptor: %+v", r)
		}
		return list(ctx, r)
	}
	out, err := f.service.List(context.Background(), ListQuery{WorkspaceID: "work", RelativePath: "selected"})
	if err != nil || out == nil || out.RelativePath != "selected" || out.Root.Path != "/work" {
		t.Fatalf("%+v %v", out, err)
	}
}

func TestNilEntriesNormalizeToEmptyArray(t *testing.T) {
	f := newFixture()
	list := f.native.list
	f.native.list = func(ctx context.Context, r port.ListRequest) (*port.ListResponse, error) {
		out, err := list(ctx, r)
		out.Entries = nil
		return out, err
	}
	out, err := f.service.List(context.Background(), request())
	if err != nil || out == nil || out.Entries == nil || len(out.Entries) != 0 {
		t.Fatalf("%+v %v", out, err)
	}
}
func TestEntryUTF8ByteBound(t *testing.T) {
	f := newFixture()
	list := f.native.list
	f.native.list = func(ctx context.Context, r port.ListRequest) (*port.ListResponse, error) {
		out, err := list(ctx, r)
		out.Entries = []string{strings.Repeat("é", 513)}
		return out, err
	}
	out, err := f.service.List(context.Background(), request())
	assertFailure(t, out, err, "WORKSPACE_HELPER_FAILED")
}
