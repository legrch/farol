//go:build darwin || linux

package installmove

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"
)

// Constructor-only deterministic policy. No File method/syscall is invoked.
func TestCapturePublicationDeterministicNamesAndRoles(t *testing.T) {
	d := Directory{File: &os.File{}, Identity: Identity{"1", "2"}}
	name := ".launch-capture-" + strings.Repeat("a", 24)
	fence := func(context.Context) error { return nil }
	until := time.Now().Add(time.Second)
	for _, bad := range []string{"Farol.app", "launch-Farol.app", ".launch-capture-", name + "a", "../" + name, ".launch-capture-" + strings.Repeat("A", 24), ".launch-capture-" + strings.Repeat("/", 24)} {
		if _, err := PrepareCapturePublication(d, bad, Identity{"1", "3"}, until, fence); err == nil {
			t.Fatal("accepted capture name", bad)
		}
	}
	if _, err := PrepareRename(Location{d, name}, Location{d, "launch-Farol.app"}, Identity{"1", "3"}, until, fence); err == nil {
		t.Fatal("ordinary move names weakened")
	}
	if _, err := PrepareExchange(Location{d, name}, Location{d, "launch-Farol.app"}, Identity{"1", "3"}, Identity{"1", "4"}, until, fence); err == nil {
		t.Fatal("exchange names weakened")
	}
	shared := d
	shared.Kind = SharedApplicationsParent
	if _, err := PrepareCapturePublication(shared, name, Identity{"1", "3"}, until, fence); err == nil {
		t.Fatal("shared Applications capture accepted")
	}
	publication, err := PrepareCapturePublication(d, name, Identity{"1", "3"}, until, fence)
	if err != nil || publication.left.Parent.File != publication.right.Parent.File || publication.left.Parent.Identity != publication.right.Parent.Identity || publication.exchange || publication.right.Name != "launch-Farol.app" {
		t.Fatal(publication, err)
	}
}
