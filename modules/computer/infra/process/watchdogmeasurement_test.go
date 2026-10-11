package process

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
	processcontract "github.com/legrch/farol/modules/computer/contracts/process"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// Real release sequencing over CPU handles/IPC; no native command is launched.
func TestWatchdogRechecksRetainedInputsBeforeRelease(t *testing.T) {
	for _, mode := range []string{"current", "changed", "revoked-during-recheck", "partial-measurement"} {
		t.Run(mode, func(t *testing.T) {
			f := newWatchdogFixture(t)
			f.prepare(t)
			var prepared atomic.Bool
			checks := 0
			measurement := &watchdogMeasurementDouble{recheck: func(ctx context.Context) error {
				checks++
				if !prepared.Load() || f.lease.inspecting.Load() || f.host.starts.Load() != 0 {
					t.Fatal("measurement not rechecked between prepared and release, outside owner locks")
				}
				if mode == "changed" {
					return errors.New("synthetic original descriptor drift")
				}
				if mode == "revoked-during-recheck" {
					f.lease.change(func(s *port.AccessSnapshot) { s.Participant.Grant.Commands = authority.NoCommands })
				}
				return ctx.Err()
			}}
			original := f.preparer.boundary.measure
			f.preparer.boundary.measure = func(ctx context.Context, command Command, launch *confinedLaunch) (launchMeasurement, error) {
				previous, err := original(ctx, command, launch)
				if previous != nil {
					previous.Close()
				}
				if mode == "partial-measurement" {
					return measurement, errors.New("synthetic capture failure")
				}
				return measurement, err
			}
			f.host.beforePrepared = func() { prepared.Store(true) }
			_, err := f.route.Start(context.Background(), processcontract.StartRequest{OperationID: "operation"})
			if measurement.closes != 1 {
				t.Fatal("original measurement not closed exactly once")
			}
			if mode == "current" {
				if err != nil || checks != 1 || f.host.starts.Load() != 1 {
					t.Fatal("current original measurement refused", err)
				}
				return
			}
			if err == nil || f.host.starts.Load() != 0 {
				t.Fatal("command released after refused measurement or authority loss")
			}
			if mode == "partial-measurement" {
				if checks != 0 || f.host.calls.Load() != 0 {
					t.Fatal("partial measurement reached helper")
				}
			} else if checks != 1 || f.host.calls.Load() != 1 {
				t.Fatal("original measurement/helper count changed")
			}
			_, err = f.route.Start(context.Background(), processcontract.StartRequest{OperationID: "operation"})
			if err == nil || f.host.starts.Load() != 0 || measurement.closes != 1 {
				t.Fatal("failed attempt reopened or released")
			}
		})
	}
}
