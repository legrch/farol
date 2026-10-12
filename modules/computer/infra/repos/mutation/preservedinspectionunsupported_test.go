//go:build !darwin

package mutation

import (
	"context"
	"testing"
)

func TestPreservedInspectionUnsupported(t *testing.T) {
	selection, expected, _ := preservedPureFixture(t)
	root := Root{Path: "/private/tmp/not-opened", Device: 1, Inode: 2}
	if out, err := InspectPreserved(context.Background(), root, selection, expected, func(PreservedInspection) error { t.Fatal("unsupported visitor called"); return nil }); err == nil || out != nil {
		t.Fatal("unsupported platform accepted observation")
	}
}
