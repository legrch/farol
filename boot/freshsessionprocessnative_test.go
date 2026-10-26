//go:build darwin

package boot

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"slices"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/pkg/ipc"
)

const freshProcessBuild = "fresh-native-process-fixture"

func TestFreshSessionCLIChild(t *testing.T) {
	if os.Getenv("FAROL_TEST_FRESH_CLI_CHILD") != "1" {
		t.Skip("Only the disposable fresh-session parent launches this helper")
	}
	separator := slices.Index(os.Args, "--")
	if separator < 0 {
		os.Exit(2)
	}
	BuildID = freshProcessBuild
	os.Exit(Run(os.Args[separator+1:], os.Stdin, os.Stdout, os.Stderr))
}

// Real child processes and production CLI/framing on disposable stores. No
// Electron, provider, Send, Shell, installed profile or previous recovery runs.
func TestFreshSessionCLIReopenWithCurrentDrainAndNormalTerminal(t *testing.T) {
	launch, _, _ := recoveryNativeFixture(t)
	before := recoverySnapshot(t, launch.Profile.Root)
	var previousGeneration string
	for n := 0; n < 2; n++ {
		generation := freshProcessJourney(t, launch, n)
		if generation == "" || generation == previousGeneration {
			t.Fatal("separate processes did not receive new backend generations")
		}
		previousGeneration = generation
		after := recoverySnapshot(t, launch.Profile.Root)
		for key, value := range before {
			if after[key] != value {
				t.Fatal("child startup/drain changed original history or UNKNOWN", key)
			}
		}
	}
}

func freshProcessJourney(t *testing.T, launch NativeLaunch, n int) string {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, executable,
		"-test.run=^TestFreshSessionCLIChild$", "--", "serve",
		"--profile", launch.Profile.ProfileID,
		"--profile-root", launch.Profile.Root,
		"--profile-device", fmt.Sprint(launch.Profile.Device),
		"--profile-inode", fmt.Sprint(launch.Profile.Inode),
		"--owner", launch.OwnerID, "--computer", launch.ComputerID,
		"--home", launch.Home, "--store-mode", "open", "--startup-mode", "fresh",
		"--host-lifetime", fmt.Sprintf("fresh-process-host-%d", n),
		"--child-launch", fmt.Sprintf("fresh-process-child-%d", n))
	// No inherited account, provider or runtime environment is needed.
	cmd.Env = []string{"FAROL_TEST_FRESH_CLI_CHILD=1"}
	cmd.WaitDelay = 2 * time.Second
	var diagnostics bytes.Buffer
	cmd.Stderr = &diagnostics
	in, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		_ = in.Close()
		t.Fatal(err)
	}
	if err = cmd.Start(); err != nil {
		_ = in.Close()
		_ = out.Close()
		t.Fatal(err)
	}
	waited := false
	defer func() {
		if !waited {
			_ = in.Close()
			cancel() // exact test-owned child only; a timeout never counts as PASS
			_ = cmd.Wait()
			t.Logf("unconfirmed child terminal; diagnostics: %s", diagnostics.String())
		}
	}()
	var peer *wire.Context
	requestID := 0
	invoke := func(method string, body any, operation string) *wire.Outcome {
		t.Helper()
		requestID++
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		request := wire.Request{Jsonrpc: "2.0", Id: fmt.Sprint(requestID), Method: method, Params: wire.Call{Context: peer, Body: raw}}
		if operation != "" {
			request.Params.OperationId = &operation
		}
		raw, err = json.Marshal(request)
		if err != nil {
			t.Fatal(err)
		}
		if err = ipc.WriteFrame(in, raw); err != nil {
			t.Fatal("fresh CLI request failed; no retry", err)
		}
		raw, err = ipc.ReadFrame(out)
		if err != nil {
			t.Fatal("fresh CLI outcome unconfirmed; no retry", err)
		}
		var response wire.Response
		if err = json.Unmarshal(raw, &response); err != nil || response.Error != nil || response.Result == nil || response.Id == nil || *response.Id != request.Id {
			t.Fatalf("fresh CLI protocol failure: %s (%v)", raw, err)
		}
		return response.Result
	}
	hello := invoke("core.handshake", wire.Handshake{ProtocolMajor: wire.ProtocolMajor, ProtocolMinor: wire.ProtocolMinor, BuildId: freshProcessBuild, ProfileId: launch.Profile.ProfileID}, "")
	var identity wire.Identity
	if hello.Status != "ok" || json.Unmarshal(hello.Data, &identity) != nil || identity.BackendGeneration != hello.Context.BackendGeneration {
		t.Fatal("fresh CLI identity unavailable", hello)
	}
	peer = &hello.Context
	if !slices.Contains(identity.Capabilities, "core.fresh.close") {
		t.Fatal("fresh drain not exposed")
	}
	for _, forbidden := range []string{"core.retirement.prepare", "core.retirement.ack", "computer.settings.write", "computer.settings.edit"} {
		if slices.Contains(identity.Capabilities, forbidden) {
			t.Fatal("unqualified previous-session/mutation capability", forbidden)
		}
	}
	invalid := invoke("core.fresh.close", map[string]bool{"unexpected": true}, "invalid-close")
	if invalid.Status != "refused" {
		t.Fatal("open close request admitted", invalid)
	}
	closed := invoke("core.fresh.close", wire.CoreFreshClose{}, "current-close")
	var drained wire.CoreFreshClosed
	if closed.Status != "ok" || json.Unmarshal(closed.Data, &drained) != nil || !drained.Drained {
		t.Fatal("current child drain unconfirmed", closed)
	}
	duplicate := invoke("core.fresh.close", wire.CoreFreshClose{}, "second-close")
	if duplicate.Status != "refused" {
		t.Fatal("fresh drain admitted twice", duplicate)
	}
	if err = in.Close(); err != nil {
		t.Fatal(err)
	}
	err = cmd.Wait()
	waited = true
	if err != nil || ctx.Err() != nil || cmd.ProcessState == nil || !cmd.ProcessState.Exited() || cmd.ProcessState.ExitCode() != 0 || diagnostics.Len() != 0 {
		t.Fatalf("normal terminal unconfirmed: %v, context %v, diagnostics %s", err, ctx.Err(), diagnostics.String())
	}
	t.Logf("child %d generation %s: current drained=true, exit=0, unforced", n, identity.BackendGeneration)
	return identity.BackendGeneration
}
