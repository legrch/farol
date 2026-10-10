//go:build !darwin

package mutation

import (
	"context"
	"testing"
)

func TestClosedEmptyInspectionUnsupported(t *testing.T) {
	root := Root{Path: "/private/tmp/not-opened", Device: 1, Inode: 2}
	if out, err := InspectEmpty(context.Background(), root); err == nil || out != nil {
		t.Fatal("unsupported host accepted empty inspection", out)
	}
	if err := WithClosedEmptyInspection(context.Background(), root, func(EmptyInspection) error {
		t.Fatal("unsupported host reached visitor")
		return nil
	}); err == nil {
		t.Fatal("unsupported host accepted closed inspection")
	}
}
