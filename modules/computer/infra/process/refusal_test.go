package process

import (
	"context"
	"errors"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	processcontract "github.com/legrch/farol/modules/computer/contracts/process"
	"testing"
)

func TestRefusalAtPreservesUnknownAndClosedNativeData(t *testing.T) {
	for _, tc := range []struct {
		in   *processsvc.NativeFailure
		want processsvc.NativeRefusalReason
	}{
		{&processsvc.NativeFailure{}, processsvc.RefusalDirectoryPolicy},
		{&processsvc.NativeFailure{Reason: processsvc.RefusalRuntimeIntegrity}, processsvc.RefusalRuntimeIntegrity},
		{&processsvc.NativeFailure{Reason: "/outside token=fixture"}, processsvc.RefusalUnclassified},
	} {
		var got *processsvc.NativeFailure
		if !errors.As(refusalAt(tc.in, processsvc.RefusalDirectoryPolicy), &got) || got.Reason != tc.want || got.Unknown {
			t.Fatal(got)
		}
	}
	for _, f := range []*processsvc.NativeFailure{{Unknown: true}, {Unknown: true, FilesystemUnsupported: true}} {
		if refusalAt(f, processsvc.RefusalDirectoryPolicy) != f {
			t.Fatal("unknown semantics replaced")
		}
	}
}

// CPU-only retained filesystem doubles. No native launch or owner workspace IO.
func TestLaunchMeasurementNativeRefusalReasons(t *testing.T) {
	for _, tc := range []struct {
		name   string
		reason processsvc.NativeRefusalReason
	}{
		{"image", processsvc.RefusalExecutableIntegrity},
		{"root", processsvc.RefusalWorkspaceRootIdentity},
		{"cwd", processsvc.RefusalCwdFence},
		{"scratch", processsvc.RefusalDirectoryPolicy},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, command, launch, fs := rootMeasurementFixture(t)
			switch tc.name {
			case "image":
				fs.executableError = launch.pins[0].Path
			case "root":
				fs.directoryError = command.Root
			case "cwd":
				command.Cwd = "/outside"
			case "scratch":
				fs.directoryError = launch.scratch
			}
			out, err := retainLaunchFiles(context.Background(), command, launch, fs)
			var got *processsvc.NativeFailure
			if out != nil || !errors.As(err, &got) || got.Reason != tc.reason || got.Unknown {
				t.Fatalf("wanted %s, got %#v", tc.reason, got)
			}
			fs.assertCloses(t, 1)
		})
	}
}

func TestWatchdogPreservesPreflightNativeReason(t *testing.T) {
	f := newWatchdogFixture(t)
	f.prepare(t)
	f.preparer.boundary.measure = func(context.Context, Command, *confinedLaunch) (launchMeasurement, error) {
		return nil, &processsvc.NativeFailure{Reason: processsvc.RefusalRuntimeIntegrity}
	}
	_, err := f.route.Start(context.Background(), processcontract.StartRequest{OperationID: "operation"})
	if err == nil || err.Error() != "PROCESS_NATIVE_REFUSED" {
		t.Fatal(err)
	}
	// Public contract is independently mapped and cannot disclose a native message.
	var failure *processcontract.Failure
	if !errors.As(err, &failure) || failure.NativeRefusalReason != "runtime_integrity" || failure.Retry != "never" || f.host.calls.Load() != 0 {
		t.Fatalf("preflight reason lost: %#v", failure)
	}
}

func TestWatchdogKeepsGenericPreflightRefusalCode(t *testing.T) {
	f := newWatchdogFixture(t)
	f.prepare(t)
	f.preparer.boundary.measure = func(context.Context, Command, *confinedLaunch) (launchMeasurement, error) {
		return nil, &processsvc.NativeFailure{FilesystemUnsupported: true}
	}
	_, err := f.route.Start(context.Background(), processcontract.StartRequest{OperationID: "operation"})
	var failure *processcontract.Failure
	if !errors.As(err, &failure) || failure.Code != "PROCESS_NATIVE_REFUSED" || failure.NativeRefusalReason != "filesystem_policy" || failure.Retry != "never" || f.host.calls.Load() != 0 {
		t.Fatalf("preflight public semantics changed: %#v", failure)
	}
}
