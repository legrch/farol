package browse

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// These are pure port fixtures, not native filesystem or publication evidence.
type testClock struct{ now time.Time }

func (c *testClock) Now() time.Time { return c.now }

type currentFunc func(context.Context, func(*authority.Approval) error) error

func (f currentFunc) WithCurrent(ctx context.Context, cb func(*authority.Approval) error) error {
	return f(ctx, cb)
}

type nativeFixture struct {
	calls int
	list  func(context.Context, port.ListRequest) (*port.ListResponse, error)
}

func (n *nativeFixture) Read(context.Context, port.ReadRequest) (*port.ReadResponse, error) {
	panic("owner list must never read")
}
func (n *nativeFixture) List(ctx context.Context, r port.ListRequest) (*port.ListResponse, error) {
	n.calls++
	return n.list(ctx, r)
}

type fixture struct {
	approval     authority.Approval
	clock        *testClock
	native       *nativeFixture
	service      *Service
	currentCalls int
	afterCurrent func(int, *authority.Approval, error) error
}

func newFixture() *fixture {
	now := time.UnixMilli(1800000000000)
	f := &fixture{clock: &testClock{now: now}, approval: authority.Approval{
		OwnerID: "owner", ComputerID: "computer", Generation: 7,
		Workspaces: []authority.ApprovedWorkspace{{WorkspaceID: "work", Root: "/work", Access: authority.ReadAccess,
			RootIdentity: authority.RootIdentity{Device: "12", Inode: "34"},
			GitMetadata:  &authority.GitMetadata{GitDirectory: "/work/.git", CommonDirectory: "/work/.git"}}},
		Capabilities: []authority.Capability{authority.List}, Network: authority.NoNetwork, Commands: authority.NoCommands,
		ExpiresAt: now.Add(time.Hour),
	}}
	f.native = &nativeFixture{list: func(_ context.Context, r port.ListRequest) (*port.ListResponse, error) {
		return &port.ListResponse{Binding: &port.DirectoryBinding{RelativePath: r.RelativePath, Root: r.Workspace.Root, ApprovedRoot: r.Workspace.ApprovedRoot}, Entries: []string{"file.txt", "folder/"}}, nil
	}}
	f.service = New(currentFunc(func(_ context.Context, cb func(*authority.Approval) error) error {
		f.currentCalls++
		snapshot := f.approval.Clone()
		err := cb(&snapshot)
		if f.afterCurrent != nil {
			return f.afterCurrent(f.currentCalls, &snapshot, err)
		}
		return err
	}), f.native, f.clock)
	return f
}
func request() ListQuery { return ListQuery{WorkspaceID: "work", RelativePath: "."} }
func assertFailure(t *testing.T, result *ListResult, err error, code string) {
	t.Helper()
	var failure *authority.Failure
	if result != nil || !errors.As(err, &failure) || failure == nil || failure.Code != code {
		t.Fatalf("result=%+v error=%v, want %s", result, err, code)
	}
}
func TestCallbackProtocol(t *testing.T) {
	for _, phase := range []int{1, 2} {
		for _, kind := range []string{"skipped", "repeated", "mutated", "mutated expiry", "error after success", "swallowed error"} {
			t.Run(kind+string(rune('0'+phase)), func(t *testing.T) {
				f := newFixture()
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
						a.Workspaces[0].GitMetadata.CommonDirectory = "/mutated"
						return err
					case "mutated expiry":
						err := cb(&a)
						a.ExpiresAt = a.ExpiresAt.Add(time.Hour)
						return err
					case "error after success":
						_ = cb(&a)
						return errors.New("private diagnostics")
					default:
						_ = cb(nil)
						return nil
					}
				})
				out, err := f.service.List(context.Background(), request())
				code := "COMPUTER_AUTHORITY_STORE_UNAVAILABLE"
				if kind == "swallowed error" {
					code = "COMPUTER_APPROVAL_NOT_FOUND"
				}
				assertFailure(t, out, err, code)
				if phase == 1 && f.native.calls != 0 {
					t.Fatal("native dispatch after broken callback")
				}
			})
		}
	}
}
func TestCurrentPortRefusalBeforeCallback(t *testing.T) {
	for _, phase := range []int{1, 2} {
		f := newFixture()
		calls := 0
		f.service.current = currentFunc(func(_ context.Context, cb func(*authority.Approval) error) error {
			calls++
			if calls == phase {
				return authority.Fail("AUTHORITY_COMPUTER_MISMATCH", "computer-policy")
			}
			a := f.approval.Clone()
			return cb(&a)
		})
		out, err := f.service.List(context.Background(), request())
		assertFailure(t, out, err, "AUTHORITY_COMPUTER_MISMATCH")
		if phase == 1 && f.native.calls != 0 {
			t.Fatal("dispatched after current refusal")
		}
	}
}
func TestCallbackErrorCannotBeSwallowed(t *testing.T) {
	f := newFixture()
	f.approval.Capabilities = nil
	f.afterCurrent = func(_ int, _ *authority.Approval, _ error) error { return nil }
	out, err := f.service.List(context.Background(), request())
	assertFailure(t, out, err, "AUTHORITY_CAPABILITY_DENIED")
	if f.native.calls != 0 {
		t.Fatal("swallowed policy error dispatched")
	}
}
func TestMissingDependencies(t *testing.T) {
	for _, replace := range []func(*fixture){func(f *fixture) { f.service.native = nil }, func(f *fixture) { f.service.clock = nil }, func(f *fixture) { f.service.current = nil }} {
		f := newFixture()
		replace(f)
		out, err := f.service.List(context.Background(), request())
		assertFailure(t, out, err, "COMPUTER_AUTHORITY_STORE_UNAVAILABLE")
	}
}
func TestLateCallbackCannotExecute(t *testing.T) {
	f := newFixture()
	var late func(*authority.Approval) error
	f.service.current = currentFunc(func(_ context.Context, cb func(*authority.Approval) error) error { late = cb; return nil })
	out, err := f.service.List(context.Background(), request())
	assertFailure(t, out, err, "COMPUTER_AUTHORITY_STORE_UNAVAILABLE")
	if err := late(&f.approval); err == nil {
		t.Fatal("late callback admitted")
	}
	if f.native.calls != 0 {
		t.Fatal("late dispatch")
	}
}
