package browse

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	app "github.com/legrch/farol/modules/computer/app/services/browse"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// Pure port fixtures exercise contract mapping only.
type current struct{ approval authority.Approval }

func (c current) WithCurrent(_ context.Context, cb func(*authority.Approval) error) error {
	a := c.approval.Clone()
	return cb(&a)
}

type clock struct{}

func (clock) Now() time.Time { return time.UnixMilli(1800000000000) }

type native struct {
	output *port.ListResponse
	err    error
}

func (*native) Read(context.Context, port.ReadRequest) (*port.ReadResponse, error) {
	panic("unexpected read")
}
func (n *native) List(_ context.Context, r port.ListRequest) (*port.ListResponse, error) {
	if n.err != nil {
		return n.output, n.err
	}
	n.output.Binding = &port.DirectoryBinding{RelativePath: r.RelativePath, Root: r.Workspace.Root, ApprovedRoot: r.Workspace.ApprovedRoot}
	return n.output, nil
}
func contractFixture(n *native) *Contract {
	a := authority.Approval{OwnerID: "owner", ComputerID: "computer", Generation: 7,
		Workspaces:   []authority.ApprovedWorkspace{{WorkspaceID: "work", Root: "/work", Access: authority.ReadAccess, RootIdentity: authority.RootIdentity{Device: "12", Inode: "34"}}},
		Capabilities: []authority.Capability{authority.List}, Network: authority.NoNetwork, Commands: authority.NoCommands, ExpiresAt: clock{}.Now().Add(time.Hour)}
	return New(app.New(current{a}, n, clock{}))
}
func TestSanitizedFailure(t *testing.T) {
	var typedNil *authority.Failure
	cases := []struct {
		err          error
		code, source string
	}{
		{errors.New("private /path credential text"), "WORKSPACE_HELPER_FAILED", "native-workspace"},
		{authority.Fail("PRIVATE_PATH_/secret", "native-workspace"), "WORKSPACE_HELPER_FAILED", "native-workspace"},
		{authority.Fail("WORKSPACE_PATH_REFUSED", "private /path"), "WORKSPACE_HELPER_FAILED", "native-workspace"},
		{fmt.Errorf("private wrapper: %w", authority.Fail("WORKSPACE_PATH_REFUSED", "native-workspace")), "WORKSPACE_PATH_REFUSED", "native-workspace"},
		{&authority.Failure{Code: "AUTHORITY_EXPIRED", Source: "computer-approval", Retry: "private retry"}, "AUTHORITY_EXPIRED", "computer-approval"},
		{typedNil, "WORKSPACE_HELPER_FAILED", "native-workspace"},
	}
	for i, tc := range cases {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			c := contractFixture(&native{err: tc.err})
			out, err := c.List(context.Background(), ListRequest{WorkspaceID: "work", RelativePath: "."})
			var f *Failure
			if out != nil || !errors.As(err, &f) || f == nil || f.Code != tc.code || f.Source != tc.source || f.Retry != "never" {
				t.Fatalf("%+v %+v", out, err)
			}
			if strings.Contains(f.Error(), "private") {
				t.Fatal("private diagnostics leaked")
			}
		})
	}
}
func TestNilContract(t *testing.T) {
	for _, c := range []*Contract{nil, New(nil)} {
		out, err := c.List(context.Background(), ListRequest{})
		var f *Failure
		if out != nil || !errors.As(err, &f) || f.Code != "COMPUTER_AUTHORITY_STORE_UNAVAILABLE" {
			t.Fatalf("%+v %v", out, err)
		}
	}
}
