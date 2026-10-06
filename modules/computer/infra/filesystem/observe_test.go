package filesystem

import (
	"context"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
)

func TestObserveRootInput(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	for _, tc := range []struct {
		name string
		ctx  context.Context
		root port.Root
	}{
		{"nil context", nil, port.Root{}},
		{"cancelled", ctx, port.Root{}},
		{"filesystem root", context.Background(), port.Root{Path: "/", Device: "1", Inode: "2"}},
		{"relative", context.Background(), port.Root{Path: "relative", Device: "1", Inode: "2"}},
		{"invalid identity", context.Background(), port.Root{Path: "/unopened", Device: "x", Inode: "2"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ObserveRoot(tc.ctx, tc.root)
			if err == nil || got != (port.Root{}) {
				t.Fatalf("invalid input produced root=%v err=%v", got, err)
			}
		})
	}
}
