//go:build darwin && farol_native_process

package boot

import (
	"context"
	"encoding/base64"
	"fmt"
	"testing"
	"time"
)

// This shares the native fixture's exact connector and disposable workspace.
// It exercises the real process owner, Seatbelt and watchdog without a provider.
func checkNativeSelfTestShell(t *testing.T, r *NativeRuntime, generation int) {
	t.Helper()
	const workspace = "00000000-0000-4000-8000-000000000004"
	ctx := context.Background()
	for _, kind := range []selfTestShellKind{selfTestShellQuick, selfTestShellCancel} {
		op := fmt.Sprintf("self-%d-%d", generation, kind)
		check, err := newSelfTestShell(r.connector, r.connector.current, workspace, op, op+"-call", op+"-cancel", kind)
		if err != nil {
			t.Fatal(err)
		}
		started, err := check.start(ctx)
		if err != nil {
			t.Fatal("self-test start", err)
		}
		if kind == selfTestShellCancel {
			out, err := check.read(ctx, 0, 0)
			if err != nil || out.State != "running" || out.Handle != started.Handle {
				t.Fatal("running observation", out, err)
			}
			ack, err := check.cancel(ctx)
			if err != nil || ack.Status != "requested" {
				t.Fatal("single cancel not acknowledged", ack, err)
			}
		}
		deadline := time.Now().Add(10 * time.Second)
		for {
			out, err := check.read(ctx, 0, 0)
			if err != nil || out == nil || out.Handle != started.Handle || out.State == "unknown" {
				t.Fatal("self-test observation unconfirmed", out, err)
			}
			if out.State != "running" {
				if !out.RootWaited || out.GroupCleanup != "confirmed" {
					t.Fatal("self-test cleanup unconfirmed", out)
				}
				if kind == selfTestShellQuick {
					output, err := base64.StdEncoding.DecodeString(out.StdoutBase64)
					if err != nil || out.ExitCode == nil || *out.ExitCode != 0 || string(output) != "farol self-test\n" {
						t.Fatal("quick canary failed", out, err)
					}
				} else if !out.CancelRequested || out.ExitSignal == 0 {
					t.Fatal("cancel canary did not stop", out)
				}
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("self-test deadline; no replay")
			}
			time.Sleep(10 * time.Millisecond)
		}
		select {
		case <-processCollectionDone(r.connector, op):
		case <-time.After(2 * time.Second):
			t.Fatal("self-test publication unconfirmed")
		}
	}
	for _, kind := range []selfTestShellKind{selfTestShellQuick, selfTestShellCancel} {
		op := fmt.Sprintf("self-check-%d-%d", generation, kind)
		check, err := newSelfTestShell(r.connector, r.connector.current, workspace, op, op+"-call", op+"-cancel", kind)
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		result := check.check(ctx)
		cancel()
		if result.Status != "pass" || result.Operation != op || result.Handle == "" {
			t.Fatal("composed self-test failed", result)
		}
		select {
		case <-processCollectionDone(r.connector, op):
		case <-time.After(2 * time.Second):
			t.Fatal("composed self-test publication unconfirmed")
		}
	}

}
