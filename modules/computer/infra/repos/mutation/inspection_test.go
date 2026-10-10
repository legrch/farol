package mutation

import (
	"context"
	"testing"
)

func TestInspectionRejectsInvalidSelection(t *testing.T) {
	for _, root := range []Root{{}, {Path: "relative", Device: 1, Inode: 2}, {Path: "/", Device: 1, Inode: 2}, {Path: "/private/tmp/a/../b", Device: 1, Inode: 2}, {Path: "/private/tmp/unused", Device: 0, Inode: 2}} {
		if out, err := InspectEmpty(context.Background(), root); err == nil || out != nil {
			t.Fatal("invalid selection reached inspection", out)
		}
		if err := WithClosedEmptyInspection(context.Background(), root, func(EmptyInspection) error {
			t.Fatal("invalid selection reached visitor")
			return nil
		}); err == nil {
			t.Fatal("invalid selection accepted by closed inspection")
		}
	}
	root := Root{Path: "/private/tmp/not-opened", Device: 1, Inode: 2}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	for _, current := range []context.Context{nil, ctx} {
		if out, err := InspectEmpty(current, root); err == nil || out != nil {
			t.Fatal("absent or cancelled context reached inspection", out)
		}
		if err := WithClosedEmptyInspection(current, root, func(EmptyInspection) error {
			t.Fatal("absent or cancelled context reached visitor")
			return nil
		}); err == nil {
			t.Fatal("absent or cancelled context accepted by closed inspection")
		}
	}
}

func TestClosedEmptyInspectionRejectsNilVisitor(t *testing.T) {
	root := Root{Path: "/private/tmp/not-opened", Device: 1, Inode: 2}
	if err := WithClosedEmptyInspection(context.Background(), root, nil); err == nil {
		t.Fatal("nil visitor accepted")
	}
}
