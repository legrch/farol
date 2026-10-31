//go:build darwin

package boot

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	releaseport "github.com/legrch/farol/modules/release/app/port"
	executionapp "github.com/legrch/farol/modules/release/app/services/execution"
	inputapp "github.com/legrch/farol/modules/release/app/services/helperinput"
	protocolapp "github.com/legrch/farol/modules/release/app/services/helperprotocol"
	release "github.com/legrch/farol/modules/release/domain"
	"github.com/legrch/farol/modules/release/infra/native/appidentity"
	"github.com/legrch/farol/modules/release/infra/native/apptree"
	executionnative "github.com/legrch/farol/modules/release/infra/native/execution"
	inputnative "github.com/legrch/farol/modules/release/infra/native/helperinput"
	protocolnative "github.com/legrch/farol/modules/release/infra/native/helperprotocol"
	releasestate "github.com/legrch/farol/modules/release/infra/native/state"
	"github.com/legrch/farol/modules/release/infra/repos/journal"
	"github.com/legrch/farol/modules/release/infra/repos/rejection"
)

var errSharedProbeWriteBarrier = errors.New("shared-read-only-probe-write-barrier")

// Reads are genuine. The first case rejects every CAS. The second forwards
// only the first prepared CAS into the disposable operation's real repository.
type sharedProbeJournal struct {
	releaseport.HelperJournalRepository
	calls         int
	value         release.Journal
	allowPrepared bool
}

func (j *sharedProbeJournal) CompareAndSwap(ctx context.Context, revision string, value release.Journal) (*releaseport.JournalView, error) {
	j.calls++
	j.value = value
	if j.allowPrepared && j.calls == 1 && value.Phase == "prepared" {
		return j.HelperJournalRepository.CompareAndSwap(ctx, revision, value)
	}
	return nil, errSharedProbeWriteBarrier
}

// Even an unexpected application branch cannot acquire a shared namespace
// effect through this wrapper. Journal writes stay in the disposable home;
// no relaunch port is supplied to Milestone.Execute.
type sharedProbeRuntime struct {
	releaseport.HelperInstallationObservation
	native                  releaseport.HelperInstallationRuntime
	exchanges, otherEffects int
}

func (r *sharedProbeRuntime) Prepare(ctx context.Context) error { return r.native.Prepare(ctx) }
func (r *sharedProbeRuntime) Fence(ctx context.Context) error   { return r.native.Fence(ctx) }
func (r *sharedProbeRuntime) WritePhase(context.Context, string) error {
	r.otherEffects++
	return errSharedProbeWriteBarrier
}
func (r *sharedProbeRuntime) Exchange(context.Context, releaseport.HelperRecoveryEntry, releaseport.HelperRecoveryEntry, releaseport.HelperIdentity, releaseport.HelperIdentity) error {
	r.exchanges++
	return errSharedProbeWriteBarrier
}
func (r *sharedProbeRuntime) Rename(context.Context, releaseport.HelperRecoveryEntry, releaseport.HelperRecoveryEntry, releaseport.HelperIdentity) error {
	r.otherEffects++
	return errSharedProbeWriteBarrier
}
func (r *sharedProbeRuntime) RejectTarget(context.Context, releaseport.HelperIdentity) error {
	r.otherEffects++
	return errSharedProbeWriteBarrier
}

type sharedProbeChannels struct {
	t       *testing.T
	fixture *liveNativeFixture
	ack     []byte
}

func (c *sharedProbeChannels) Emit(_ context.Context, _ time.Time, frame []byte) error {
	c.ack = append([]byte(nil), frame...)
	var value struct {
		Phase string `json:"phase"`
	}
	if json.Unmarshal(frame, &value) != nil || value.Phase != "waiting_for_exit" {
		return errors.New("shared probe did not admit its disposable predecessor")
	}
	c.fixture.quit(c.t)
	return nil
}
func (*sharedProbeChannels) Close() error { return nil }

// Explicit read-only shared-slot diagnosis. Only /Applications/Farol.app is
// read from the real installation; every state, lock, marker and repository is
// in a disposable home. Production admissions remain intact. The first journal
// write is unconditionally intercepted, so the real app slot cannot be moved.
// This source-composed probe is not shipped-helper, Desktop or OTA acceptance.
func TestLiveHelperNativeSharedReadOnlyBeforeFirstCAS(t *testing.T) {
	sharedReadOnlyProbe(t, false)
}

func TestLiveHelperNativeSharedReadOnlyBeforeExchange(t *testing.T) {
	sharedReadOnlyProbe(t, true)
}

func sharedReadOnlyProbe(t *testing.T, allowPrepared bool) {
	t.Helper()
	if os.Getenv("FAROL_SHARED_READONLY_NATIVE") != "1" {
		t.Skip("explicit Lead allocation of read-only shared-slot probe required")
	}
	source := "/Applications/Farol.app"
	expectedDigest := os.Getenv("FAROL_TEST_SHARED_SOURCE_DIGEST")
	targetRoot := os.Getenv("FAROL_TEST_TARGET_PACKAGE")
	if len(expectedDigest) != 64 || !filepath.IsAbs(targetRoot) {
		t.Fatal("explicit pinned source digest and target package required")
	}
	var identity struct{ Version, BuildID string }
	bytes, err := os.ReadFile(filepath.Join(source, "Contents/Resources/app/build-identity.json"))
	if err != nil || json.Unmarshal(bytes, &identity) != nil {
		t.Fatal("shared source identity unreadable", err)
	}
	var artifact struct {
		Version string `json:"version"`
		BuildID string `json:"buildId"`
		Digest  string `json:"artifactSha256"`
		App     string `json:"artifactPath"`
	}
	bytes, err = os.ReadFile(filepath.Join(targetRoot, "_output/package/artifact.json"))
	if err != nil || json.Unmarshal(bytes, &artifact) != nil || artifact.App != filepath.Join(targetRoot, "_output/package/Farol.app") {
		t.Fatal("target package identity unreadable", err)
	}
	before, err := os.Lstat(source)
	if err != nil {
		t.Fatal(err)
	}
	f := newLiveNativeFixture(t, false)
	f.removeAfterSuccess(t)
	copy := exec.Command("/usr/bin/ditto", artifact.App, filepath.Join(f.operation, "staged.app"))
	copy.Env = []string{"PATH=/usr/bin:/bin", "LANG=C.UTF-8"}
	if out, err := copy.CombinedOutput(); err != nil {
		t.Fatal("owned target copy failed", err, string(out))
	}
	f.arm(t, "")
	request := f.request("apply", false)
	request["installLocation"] = "shared"
	request["waitSeconds"] = 10
	request["source"] = map[string]any{"digest": expectedDigest, "version": identity.Version, "buildId": identity.BuildID}
	request["target"] = map[string]any{"digest": artifact.Digest, "version": artifact.Version, "buildId": artifact.BuildID}
	request["drain"] = map[string]any{"status": "reconciled", "acceptedSource": identity.BuildID, "acceptedTarget": artifact.BuildID}
	input := newLiveHelperFixture(t)
	input.input = closedHelperJSON(t, request)
	protocol, err := protocolapp.Bind(context.Background(), input.input, inputapp.New(inputnative.JSONDecoder{}), protocolnative.JSONCodec{})
	if err != nil {
		t.Fatal(err)
	}
	slot, err := protocol.BuildSlotBinding(context.Background(), protocolnative.JSONCodec{})
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(f.operation, "slot-binding.json"), slot, 0600); err != nil {
		t.Fatal(err)
	}
	channel := &sharedProbeChannels{t: t, fixture: f}
	deps := liveHelperProductionDependencies()
	deps.take = func(liveHelperFiles) (closedHelperInput, liveHelperChannels, error) {
		return liveHelperFixtureInput{input}, channel, nil
	}
	deps.now = time.Now
	var barrier *sharedProbeJournal
	var runtimeBarrier *sharedProbeRuntime
	var barrierCause bool
	deps.execute = func(ctx context.Context, in closedHelperExecution) (_ *executionapp.Result, result error) {
		if in.request.Action != "apply" || in.request.Relaunch {
			return nil, errors.New("shared read-only probe action refused")
		}
		operation, binding, directory := closedHelperOperationBinding(in.request, in.files)
		admission := &closedHelperJournalAdmission{helper: in.helper, gate: releasestate.New(), operation: operation, binding: binding}
		repo, err := journal.New(ctx, directory, operation, admission)
		if err != nil {
			return nil, err
		}
		defer func() { result = errors.Join(result, repo.Close()) }()
		rejected, err := rejection.New(ctx, in.files.Operation, binding, operation, admission, in.until)
		if err != nil {
			return nil, err
		}
		defer func() { result = errors.Join(result, rejected.Close()) }()
		barrier = &sharedProbeJournal{HelperJournalRepository: repo, allowPrepared: allowPrepared}
		config := closedHelperNativeConfig(in, barrier, rejected)
		result = executionnative.WithAdmittedInstallation(ctx, config, func(native executionnative.AdmittedInstallation) error {
			runtimeBarrier = &sharedProbeRuntime{HelperInstallationObservation: native, native: native}
			_, err := in.milestone.Execute(ctx, runtimeBarrier, in.readiness, nil)
			return err
		})
		barrierCause = errors.Is(result, errSharedProbeWriteBarrier)
		return nil, result
	}
	// Emit ends only the test-owned cat after real pre-ACK readiness. Neither
	// the installed Farol nor its marker is the predecessor or a cleanup target.
	line, exit := liveHelperEntry(context.Background(), liveHelperFiles{}, time.Now().Add(30*time.Second), deps)
	f.wantWaitingFrame(t, request, channel.ack)
	if barrier == nil || barrier.calls != 1 || barrier.value.Phase != "prepared" || exit != 79 || !barrierCause {
		t.Fatalf("read-only barrier not reached: barrier=%+v exit=%d line=%s", barrier, exit, line)
	}
	wantExchange := 0
	if allowPrepared {
		wantExchange = 1
	}
	if runtimeBarrier == nil || runtimeBarrier.exchanges != wantExchange || runtimeBarrier.otherEffects != 0 {
		t.Fatal("shared namespace barrier not reached as expected", runtimeBarrier)
	}
	if allowPrepared {
		if phase := f.phase(t); phase != "prepared" {
			t.Fatal("disposable journal did not complete real CAS", phase)
		}
	} else if _, err = os.Lstat(filepath.Join(f.operation, "journal.json")); !os.IsNotExist(err) {
		t.Fatal("intercepted journal write reached disk", err)
	}
	after, err := os.Lstat(source)
	if err != nil || !os.SameFile(before, after) {
		t.Fatal("shared app identity changed", err)
	}
	parent, err := os.Open("/Applications")
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := parent.Close(); err != nil {
			t.Error(err)
		}
	}()
	app, err := os.Open(source)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := app.Close(); err != nil {
			t.Error(err)
		}
	}()
	verifier, err := apptree.New(parent, app, "Farol.app", apptree.Expected{TreeSHA256: expectedDigest, Version: identity.Version, BuildID: identity.BuildID}, appidentity.Verify)
	if err != nil {
		t.Fatal(err)
	}
	verifyContext, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if _, err = verifier.Verify(verifyContext); err != nil {
		t.Fatal("shared source bytes changed", err)
	}
	t.Logf("shared-route read-only probe: realPreparedCAS=%t exchangeAttemptsIntercepted=%d expected terminal exit=%d line=%s", allowPrepared, runtimeBarrier.exchanges, exit, line)
}
