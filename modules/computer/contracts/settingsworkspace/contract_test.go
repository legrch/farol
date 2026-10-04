package settingsworkspace

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	app "github.com/legrch/farol/modules/computer/app/services/settingsworkspace"
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
func TestListIndependentDTOs(t *testing.T) {
	n := &native{output: &port.ListResponse{Entries: []string{"file.txt", "folder/"}, Truncated: true}}
	c := contractFixture(n)
	request := Request{WorkspaceID: "work", RelativePath: "."}
	out, err := c.List(context.Background(), request)
	if err != nil || out == nil {
		t.Fatalf("%+v %v", out, err)
	}
	if out.WorkspaceID != "work" || out.RelativePath != "." || out.Root != (Root{Path: "/work", Device: "12", Inode: "34"}) || !out.Truncated || !reflect.DeepEqual(out.Entries, []string{"file.txt", "folder/"}) {
		t.Fatalf("%+v", out)
	}
	n.output.Entries[0] = "changed"
	n.output.Binding.ApprovedRoot.Path = "/changed"
	if out.Entries[0] != "file.txt" || out.Root.Path != "/work" {
		t.Fatal("native output aliased")
	}
	out.Entries[1] = "caller change"
	if n.output.Entries[1] != "folder/" {
		t.Fatal("caller output aliased")
	}
	if reflect.TypeFor[Result]() == reflect.TypeFor[app.Result]() {
		t.Fatal("app DTO leaked")
	}
	if reflect.TypeFor[Root]() == reflect.TypeFor[port.Root]() {
		t.Fatal("port DTO leaked")
	}
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
			out, err := c.List(context.Background(), Request{WorkspaceID: "work", RelativePath: "."})
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
		out, err := c.List(context.Background(), Request{})
		var f *Failure
		if out != nil || !errors.As(err, &f) || f.Code != "COMPUTER_AUTHORITY_STORE_UNAVAILABLE" {
			t.Fatalf("%+v %v", out, err)
		}
	}
}

func TestEmptyEntriesMarshalAsArray(t *testing.T) {
	c := contractFixture(&native{output: &port.ListResponse{Entries: nil}})
	out, err := c.List(context.Background(), Request{WorkspaceID: "work", RelativePath: "."})
	if err != nil || out == nil || out.Entries == nil {
		t.Fatalf("%+v %v", out, err)
	}
	encoded, err := json.Marshal(out.Entries)
	if err != nil || string(encoded) != "[]" {
		t.Fatalf("%s %v", encoded, err)
	}
}
