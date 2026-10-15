package browse

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
	app "github.com/legrch/farol/modules/computer/app/services/browse"
)

func TestListIndependentDTOs(t *testing.T) {
	n := &native{output: &port.ListResponse{Entries: []string{"file.txt", "folder/"}, Truncated: true}}
	c := contractFixture(n)
	request := ListRequest{WorkspaceID: "work", RelativePath: "."}
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
	if reflect.TypeFor[ListResponse]() == reflect.TypeFor[app.ListResult]() || reflect.TypeFor[ListRequest]() == reflect.TypeFor[app.ListQuery]() {
		t.Fatal("app DTO leaked")
	}
	if reflect.TypeFor[Root]() == reflect.TypeFor[port.Root]() {
		t.Fatal("port DTO leaked")
	}
}
func TestEmptyEntriesMarshalAsArray(t *testing.T) {
	c := contractFixture(&native{output: &port.ListResponse{Entries: nil}})
	out, err := c.List(context.Background(), ListRequest{WorkspaceID: "work", RelativePath: "."})
	if err != nil || out == nil || out.Entries == nil {
		t.Fatalf("%+v %v", out, err)
	}
	encoded, err := json.Marshal(out.Entries)
	if err != nil || string(encoded) != "[]" {
		t.Fatalf("%s %v", encoded, err)
	}
}
