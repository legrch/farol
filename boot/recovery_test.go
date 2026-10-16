package boot

import (
	"context"
	"io"
	"strings"
	"testing"
)

func recoveryLaunchFixture() NativeLaunch {
	return NativeLaunch{Profile: ProfileBinding{ProfileID: "profile", Root: "/nonexistent-recovery-fixture", Device: 1, Inode: 2},
		OwnerID: "owner", ComputerID: "computer", Home: "/fixture/home", StoreMode: "open", StartupMode: "recovery", HostLifetimeID: "host", ChildLaunchID: "child"}
}

func TestRecoveryRejectsBroaderLaunchBeforeProfileAccess(t *testing.T) {
	for name, change := range map[string]func(*NativeLaunch){
		"missing-mode": func(v *NativeLaunch) { v.StartupMode = "" },
		"unknown-mode": func(v *NativeLaunch) { v.StartupMode = "other" },
		"create":       func(v *NativeLaunch) { v.StoreMode = "create" },
		"drain":        func(v *NativeLaunch) { v.PreviousHostDrainConfirmed = true },
		"mutation":     func(v *NativeLaunch) { v.SettingsMutations = true },
		"shell":        func(v *NativeLaunch) { v.shell = &connectorShellConfig{} },
		"codex":        func(v *NativeLaunch) { v.CodexRead = &NativeCodexReadSelection{} },
		"host":         func(v *NativeLaunch) { v.HostLifetimeID = "" },
		"child":        func(v *NativeLaunch) { v.ChildLaunchID = "" },
		"owner":        func(v *NativeLaunch) { v.OwnerID = "" },
		"computer":     func(v *NativeLaunch) { v.ComputerID = "" },
		"home":         func(v *NativeLaunch) { v.Home = "relative" },
	} {
		t.Run(name, func(t *testing.T) {
			launch := recoveryLaunchFixture()
			change(&launch)
			got, err := NewNativeRecovery(context.Background(), launch, "next-generation")
			if got != nil {
				t.Fatal("invalid launch opened recovery")
			}
			requireProfileFailure(t, err, ProfileInvalid)
		})
	}
	launch := recoveryLaunchFixture()
	if got, err := NewNativeRuntime(context.Background(), launch, "next-generation"); got != nil || err == nil {
		t.Fatal("recovery fell through full constructor")
	}
	var empty NativeRecovery
	if methods, err := empty.Methods(); methods != nil || err == nil {
		t.Fatal("zero owner exposed methods")
	}
	var absent *NativeRecovery
	if methods, err := absent.Methods(); methods != nil || err == nil {
		t.Fatal("nil owner exposed methods")
	}
	if err := absent.Close(); err != nil {
		t.Fatal(err)
	}
}

type recoveryForbiddenInput struct{}

func (recoveryForbiddenInput) Read([]byte) (int, error) {
	panic("invalid recovery read inherited input")
}
func (recoveryForbiddenInput) Close() error { return nil }

type recoveryDiscardOutput struct{ io.Writer }

func (recoveryDiscardOutput) Close() error { return nil }

func TestRecoveryCLIRejectsContradictoryModeWithoutReadingInput(t *testing.T) {
	base := []string{"serve", "--profile", "profile", "--profile-root", "/nonexistent-recovery-fixture", "--profile-device", "1", "--profile-inode", "2", "--owner", "owner", "--computer", "computer", "--home", "/fixture/home", "--store-mode", "open", "--host-lifetime", "host", "--child-launch", "child"}
	for name, extra := range map[string][]string{
		"unknown":  {"--startup-mode", "other"},
		"create":   {"--startup-mode", "recovery", "--store-mode", "create"},
		"drain":    {"--startup-mode", "recovery", "--previous-host-drain-confirmed"},
		"mutation": {"--startup-mode", "recovery", "--settings-mutations"},
		"shell":    {"--startup-mode", "recovery", "--shell-support-fd", "3"},
		"task":     {"--startup-mode", "recovery", "--codex-read-host", "codex", "--codex-read-temp", "/fixture/tmp"},
		"host":     {"--startup-mode", "recovery", "--host-lifetime", ""},
		"child":    {"--startup-mode", "recovery", "--child-launch", ""},
	} {
		t.Run(name, func(t *testing.T) {
			var diagnostics strings.Builder
			code := Run(append(append([]string{}, base...), extra...), recoveryForbiddenInput{}, recoveryDiscardOutput{io.Discard}, &diagnostics)
			if code != 2 {
				t.Fatalf("contradictory mode: code=%d %s", code, diagnostics.String())
			}
		})
	}
	var diagnostics strings.Builder
	if code := Run([]string{"serve", "--profile", "profile", "--startup-mode", "recovery"}, recoveryForbiddenInput{}, recoveryDiscardOutput{io.Discard}, &diagnostics); code != 2 {
		t.Fatalf("unbound recovery: %d", code)
	}
}
