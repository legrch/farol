package codex

import (
	"context"
	"errors"
	"testing"

	task "github.com/legrch/farol/modules/task/domain"
)

func TestSourceOnlyFailedConnectionNeverRelaunches(t *testing.T) {
	for _, mode := range []string{"launch", "initialize", "cleanup"} {
		t.Run(mode, func(t *testing.T) {
			c, f := newFixture(t)
			if mode == "launch" {
				f.launchError = true
			} else if mode == "initialize" {
				f.badHandshake = true
			} else {
				f.waitUnknown = true
			}
			_, _ = c.Supports(context.Background(), c.selection.Binding)
			_ = c.Close(context.Background())
			_, _ = c.Supports(context.Background(), c.selection.Binding)
			if f.launches.Load() != 1 {
				t.Fatal("client relaunched after failure/close")
			}
			if mode == "cleanup" {
				if err := c.Close(context.Background()); !errors.Is(err, task.ErrUnknown) {
					t.Fatal("missing cleanup proof accepted")
				}
			}
		})
	}
}
