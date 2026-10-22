package execution

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	stdruntime "runtime"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/release/app/port"
	executionapp "github.com/legrch/farol/modules/release/app/services/execution"
	inputapp "github.com/legrch/farol/modules/release/app/services/helperinput"
	"github.com/legrch/farol/modules/release/app/services/helperrecovery"
	"github.com/legrch/farol/modules/release/infra/native/appidentity"
	"github.com/legrch/farol/modules/release/infra/native/apptree"
	inputnative "github.com/legrch/farol/modules/release/infra/native/helperinput"
	"github.com/legrch/farol/modules/release/infra/native/installcopy"
	"github.com/legrch/farol/modules/release/infra/repos/journal"
	"github.com/legrch/farol/modules/release/infra/repos/records"
	"github.com/legrch/farol/modules/release/infra/repos/rejection"
)

// These witnesses join application policy to real copy, tree/identity checks,
// rename/exchange and journal/rejection persistence in fresh disposable trees.
// installScope uses WithInstallation's private route seam: route, lease, slot,
// predecessor process and admission remain symbolic. Neither parsing nor these
// filesystem witnesses qualify a selected helper, process/handshake, Seatbelt,
// package, installed app, relaunch or crash recovery under real custody.
type lifecycleFixture struct {
	*compositionFixture
	rejection          *rejection.Repository
	execution          *executionapp.Service
	source, target     map[string]compositionObject
	sourceID, targetID port.HelperIdentity
}

// writeLifecycleVector installs one inert image: the original-helper identity
// documents, and, when exe is set, that executable as Contents/MacOS/Sleeper.
func writeLifecycleVector(t *testing.T, root, plist, exe string) {
	t.Helper()
	must(t, os.MkdirAll(filepath.Join(root, "Contents/Resources/app"), 0700))
	for _, document := range []struct{ from, to string }{{plist, "Contents/Info.plist"}, {"oracle.json", "Contents/Resources/app/build-identity.json"}} {
		data, err := os.ReadFile(filepath.Join("..", "appidentity", "testdata", document.from))
		must(t, err)
		must(t, os.WriteFile(filepath.Join(root, document.to), data, 0600))
	}
	if exe != "" {
		must(t, os.MkdirAll(filepath.Join(root, "Contents/MacOS"), 0700))
		copyFile(t, exe, filepath.Join(root, "Contents/MacOS/Sleeper"), 0700)
	}
}

func lifecycleOpen(t *testing.T, path string) *os.File {
	t.Helper()
	file, err := os.Open(path)
	must(t, err)
	t.Cleanup(func() { must(t, file.Close()) })
	return file
}

func lifecycleTree(t *testing.T, root string) map[string]compositionObject {
	t.Helper()
	out := make(map[string]compositionObject)
	for path, object := range compositionSnapshot(t, root) {
		relative, err := filepath.Rel(root, path)
		must(t, err)
		out[relative] = object
	}
	return out
}

func lifecycleRequireTree(t *testing.T, root string, expected map[string]compositionObject) {
	t.Helper()
	actual := lifecycleTree(t, root)
	if len(actual) != len(expected) {
		t.Fatal("tree inventory changed")
	}
	for path, before := range expected {
		after, ok := actual[path]
		// A namespace move may change root ctime. Every original object and
		// byte, mode and owner must survive; child metadata stays unchanged.
		if !ok || before.stat.Dev != after.stat.Dev || before.stat.Ino != after.stat.Ino ||
			before.stat.Mode != after.stat.Mode || before.stat.Uid != after.stat.Uid || before.stat.Gid != after.stat.Gid ||
			!bytes.Equal(before.data, after.data) || path != "." && !sameMetadata(before.stat, after.stat) {
			t.Fatalf("original tree bytes, identity or metadata changed at %s", path)
		}
	}
}

func newLifecycleFixture(t *testing.T) *lifecycleFixture {
	t.Helper()
	if stdruntime.GOOS != "darwin" {
		t.Skip("composition requires production Darwin rename and rejection publication")
	}
	return newLifecycleFixtureAt(t, newCompositionFixture(t))
}

func newLifecycleFixtureAt(t *testing.T, base *compositionFixture) *lifecycleFixture {
	t.Helper()
	return newLifecycleFixtureWithExecutable(t, base, "")
}

// newLifecycleFixtureWithExecutable is the same fixture whose TARGET image also
// carries one scratch executable in Contents/MacOS, so a verified apply leaves an
// installed app that a launch can pin. The target digest is the independently
// computed tree digest of that exact image. An empty exe keeps the inert vectors.
func newLifecycleFixtureWithExecutable(t *testing.T, base *compositionFixture, exe string) *lifecycleFixture {
	t.Helper()
	if stdruntime.GOOS != "darwin" {
		t.Skip("composition requires production Darwin rename and rejection publication")
	}
	f := &lifecycleFixture{compositionFixture: base}
	// Independent original-helper vectors differ in plist bytes/digest while
	// keeping the same parsed version/build. They are inert, unsigned images.
	build := func(digest string) port.HelperBuild {
		return port.HelperBuild{Digest: digest, Version: "1.2.3-preview.4", BuildID: strings.Repeat("a", 64)}
	}
	request := f.config.Request
	request.Schema, request.Action, request.Home = "farol.installed-update/1", "apply", f.root
	request.Source = build("6fffca33b1a4831aecd152a758c4b819e7cc60a844afda73b906b874a8d3f6f3")
	targetDigest := "5655e32d0fd60f4acc2347182e9a779ab89266ecd8f970d78132233996e6e60f"
	if exe != "" {
		probe := filepath.Join(t.TempDir(), "probe.app")
		writeLifecycleVector(t, probe, "oracle.bplist", exe)
		targetDigest = treeDigest(t, probe)
	}
	request.Target = build(targetDigest)
	request.Drain = port.HelperDrain{Status: "reconciled", AcceptedSource: request.Source.BuildID, AcceptedTarget: request.Target.BuildID}
	request.PID, request.ProcessStart, request.WaitSeconds = 123, "symbolic-process-start", 30
	must(t, f.repo.Close())
	f.owner.request, f.config.Request = request, request
	f.repo = f.open(t)
	f.config.Journal = f.repo
	var err error
	f.rejection, err = rejection.New(context.Background(), f.config.Files.Operation, f.owner.directory, operation(request), f.owner, f.config.Until)
	must(t, err)
	t.Cleanup(func() { must(t, f.rejection.Close()) })
	f.config.Rejection = f.rejection

	app := filepath.Join(f.config.Files.Applications.Name(), "Farol.app")
	image, stage := filepath.Join(f.root, "target.app"), filepath.Join(f.path, "staged.app")
	writeLifecycleVector(t, app, "oracle.xml", "")
	writeLifecycleVector(t, image, "oracle.bplist", exe)
	must(t, os.Mkdir(stage, 0700))
	imageFile, stageFile := lifecycleOpen(t, image), lifecycleOpen(t, stage)
	imageID, stageID := compositionIdentity(t, imageFile), compositionIdentity(t, stageFile)
	verifier := func(parent, tree *os.File, leaf string, b port.HelperBuild) *apptree.Verifier {
		v, err := apptree.New(parent, tree, leaf, apptree.Expected{TreeSHA256: b.Digest, Version: b.Version, BuildID: b.BuildID}, appidentity.Verify)
		must(t, err)
		return v
	}
	imageVerifier := verifier(lifecycleOpen(t, f.root), imageFile, "target.app", request.Target)
	_, err = imageVerifier.Verify(context.Background())
	must(t, err)
	copyOperation, err := installcopy.Prepare(
		installcopy.Directory{File: imageFile, Identity: installcopy.Identity{Device: imageID.Device, Inode: imageID.Inode}},
		installcopy.Directory{File: stageFile, Identity: installcopy.Identity{Device: stageID.Device, Inode: stageID.Inode}},
		f.config.Until, func(ctx context.Context) error {
			if err := f.owner.reverify(ctx, request); err != nil {
				return err
			}
			_, err := imageVerifier.Verify(ctx)
			return err
		})
	must(t, err)
	must(t, copyOperation.Run(context.Background()))
	_, err = verifier(f.config.Files.Operation, stageFile, "staged.app", request.Target).Verify(context.Background())
	must(t, err)
	if imageID == stageID {
		t.Fatal("native copy reused source directory identity")
	}
	f.source, f.target = lifecycleTree(t, app), lifecycleTree(t, stage)
	f.sourceID = snapshot(entryState{present: true, stat: f.source["."].stat}).Identity
	f.targetID = port.HelperIdentity{Device: stageID.Device, Inode: stageID.Inode}
	if f.sourceID == f.targetID || f.sourceID.Device != f.targetID.Device {
		t.Fatal("fixture must supply distinct same-device exchange objects")
	}
	return f
}

// Each completed scope is followed by a fresh action request for the same
// operation. Updating this symbolic owner supplies no real lease/admission.
func (f *lifecycleFixture) input(t *testing.T, action string) []byte {
	t.Helper()
	f.config.Request.Action, f.owner.request.Action = action, action
	r := f.config.Request
	build := func(b port.HelperBuild) map[string]any {
		return map[string]any{"digest": b.Digest, "version": b.Version, "buildId": b.BuildID}
	}
	wire, err := json.Marshal(map[string]any{
		"schema": r.Schema, "action": r.Action, "home": r.Home, "operationId": r.OperationID,
		"source": build(r.Source), "target": build(r.Target),
		"drain": map[string]any{"status": r.Drain.Status, "acceptedSource": r.Drain.AcceptedSource, "acceptedTarget": r.Drain.AcceptedTarget},
		"pid":   r.PID, "processStart": r.ProcessStart, "waitSeconds": r.WaitSeconds, "relaunch": r.Relaunch,
	})
	must(t, err)
	parsed, err := inputapp.New(inputnative.JSONDecoder{}).Parse(context.Background(), wire)
	must(t, err)
	if !reflect.DeepEqual(parsed, r) {
		t.Fatal("wire request crossed captured native operation")
	}
	return wire
}

func (f *lifecycleFixture) apply(t *testing.T) (result *executionapp.ApplyResult, err error) {
	t.Helper()
	wire := f.input(t, "apply")
	err = installScope(f.compositionFixture, context.Background(), func(native port.HelperInstallationRuntime) error {
		f.execution, err = executionapp.Bind(context.Background(), wire, inputapp.New(inputnative.JSONDecoder{}), native)
		if err != nil {
			return err
		}
		result, err = f.execution.Apply(context.Background(), executionapp.ApplyCommand{})
		return err
	})
	return
}

func (f *lifecycleFixture) recover(t *testing.T) (phase string, err error) {
	t.Helper()
	wire := f.input(t, "recover")
	err = installScope(f.compositionFixture, context.Background(), func(native port.HelperInstallationRuntime) error {
		s, err := helperrecovery.Bind(context.Background(), wire, inputapp.New(inputnative.JSONDecoder{}), native)
		if err != nil {
			return err
		}
		if err := s.Inspect(context.Background()); err != nil {
			return err
		}
		phase, err = s.Reconcile(context.Background())
		return err
	})
	return
}

func TestLifecycleCompositionApplyRecoverRollback(t *testing.T) {
	for _, start := range []string{"apply", "observed-exchange"} {
		t.Run(start, func(t *testing.T) {
			f := newLifecycleFixture(t)
			before := compositionSnapshot(t, f.root)
			entered := false
			err := WithInstallation(context.Background(), f.config, func(port.HelperInstallationRuntime) error { entered = true; return nil })
			if err == nil || entered {
				t.Fatal("raw test descriptors supplied real route custody")
			}
			f.unchanged(t, before)
			if start == "apply" {
				result, err := f.apply(t)
				must(t, err)
				if result == nil || result.Result != (executionapp.Result{Phase: "verified"}) {
					t.Fatal("apply did not settle verified", result)
				}
			} else {
				// Construct a physically witnessed intermediate state. This is
				// not an actual helper crash, lost ACK or permission to replay.
				must(t, installScope(f.compositionFixture, context.Background(), func(native port.HelperInstallationRuntime) error {
					if err := native.Prepare(context.Background()); err != nil {
						return err
					}
					return native.Exchange(context.Background(), port.App, port.Staged, f.sourceID, f.targetID)
				}))
				f.physical(t, f.repo, "prepared")
				lifecycleRequireTree(t, filepath.Join(f.path, "staged.app"), f.source)
			}
			if start == "apply" {
				f.physical(t, f.repo, "verified")
			}
			before = compositionSnapshot(t, f.root)
			phase, err := f.recover(t)
			must(t, err)
			if phase != "verified" {
				t.Fatal("recovery did not observe/finish target pair", phase)
			}
			if start == "apply" {
				f.unchanged(t, before)
			}
			f.physical(t, f.repo, "verified")
			lifecycleRequireTree(t, filepath.Join(f.config.Files.Applications.Name(), "Farol.app"), f.target)
			lifecycleRequireTree(t, filepath.Join(f.path, "previous.app"), f.source)
			wire := f.input(t, "rollback")
			must(t, installScope(f.compositionFixture, context.Background(), func(native port.HelperInstallationRuntime) error {
				s, err := executionapp.Bind(context.Background(), wire, inputapp.New(inputnative.JSONDecoder{}), native)
				if err != nil {
					return err
				}
				result, err := s.Rollback(context.Background(), executionapp.RollbackCommand{})
				if err == nil && (result == nil || result.Result != (executionapp.Result{Phase: "rolled_back"})) {
					t.Fatal("rollback did not settle original source", result)
				}
				return err
			}))
			f.physical(t, f.repo, "rolled_back")
			lifecycleRequireTree(t, filepath.Join(f.config.Files.Applications.Name(), "Farol.app"), f.source)
			lifecycleRequireTree(t, filepath.Join(f.path, "failed.app"), f.target)
			for _, name := range []string{"staged.app", "previous.app", "rejected-target.json"} {
				_, err := os.Lstat(filepath.Join(f.path, name))
				if !errors.Is(err, os.ErrNotExist) {
					t.Fatal("explicit rollback left unexpected entry", name, err)
				}
			}
			before = compositionSnapshot(t, f.root)
			phase, err = f.recover(t)
			must(t, err)
			if phase != "rolled_back" || f.owner.retained() != nil {
				t.Fatal("terminal recovery changed rollback disposition", phase)
			}
			f.unchanged(t, before)
		})
	}
}

// Alter only a disposable target document after the confirmed new_installed CAS.
// Actual MatchesTree must detect the changed digest and drive app compensation.
func (f *lifecycleFixture) corruptInstalledTarget(t *testing.T) *bool {
	t.Helper()
	changed := false
	original := f.config.Reverify
	f.config.Reverify = func(ctx context.Context, request port.HelperRequest) error {
		if err := original(ctx, request); err != nil {
			return err
		}
		if !changed && f.diskPhase(t) == "new_installed" {
			must(t, os.WriteFile(filepath.Join(f.config.Files.Applications.Name(), "Farol.app/Contents/Info.plist"), []byte("disposable target corruption"), 0600))
			changed = true
		}
		return nil
	}
	return &changed
}

func (f *lifecycleFixture) diskPhase(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(f.path, "journal.json"))
	if errors.Is(err, os.ErrNotExist) {
		return ""
	}
	must(t, err)
	value, err := records.DecodeJournal(data, f.record("prepared").Operation)
	must(t, err)
	return value.Phase
}

func (f *lifecycleFixture) rejected(t *testing.T) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(f.path, "rejected-target.json"))
	must(t, err)
	value, err := records.DecodeRejectedTarget(data, f.record("rolled_back").Operation)
	must(t, err)
	if value.Device != f.targetID.Device || value.Inode != f.targetID.Inode {
		t.Fatal("rejected record lost original target inode")
	}
	lifecycleRequireTree(t, filepath.Join(f.config.Files.Applications.Name(), "Farol.app"), f.source)
	failed := lifecycleTree(t, filepath.Join(f.path, "failed.app"))
	if snapshot(entryState{present: true, stat: failed["."].stat}).Identity != f.targetID ||
		!bytes.Equal(failed["Contents/Info.plist"].data, []byte("disposable target corruption")) {
		t.Fatal("failed tree did not retain the actual changed target")
	}
}

func TestLifecycleCompositionApplyCompensatesRejectedTree(t *testing.T) {
	f := newLifecycleFixture(t)
	changed := f.corruptInstalledTarget(t)
	result, err := f.apply(t)
	must(t, err)
	if !*changed || result == nil || result.Result != (executionapp.Result{Phase: "rolled_back", Code: "target_verification"}) {
		t.Fatal("real negative tree observation did not complete compensation", result)
	}
	f.physical(t, f.repo, "rolled_back")
	f.rejected(t)
	before := compositionSnapshot(t, f.root)
	phase, err := f.recover(t)
	must(t, err)
	if phase != "rolled_back" || f.owner.retained() != nil {
		t.Fatal("rejected target recovery changed terminal outcome", phase)
	}
	f.unchanged(t, before)
}

func TestLifecycleCompositionFailureRetainsOwner(t *testing.T) {
	for _, point := range []string{"prepared-ack", "post-exchange-fence", "journal-admission", "journal-ack", "rejection-admission", "rejection-ack"} {
		t.Run(point, func(t *testing.T) {
			f := newLifecycleFixture(t)
			if strings.HasPrefix(point, "rejection-") {
				f.corruptInstalledTarget(t)
			}
			cause := &port.HelperRecoveryFailure{Code: "slot_changed", Phase: "refused"}
			injected := false
			present := func(name string) bool {
				_, err := os.Lstat(filepath.Join(f.path, name))
				if errors.Is(err, os.ErrNotExist) {
					return false
				}
				must(t, err)
				return true
			}
			if point == "journal-admission" || point == "rejection-admission" {
				// This is the real repository's borrowed admission callback,
				// not a fake CAS or Record result and not a syscall injection.
				f.owner.verify = func(context.Context) error {
					if point == "journal-admission" && present("previous.app") && f.diskPhase(t) == "prepared" ||
						point == "rejection-admission" && present("failed.app") {
						injected = true
						return cause
					}
					return nil
				}
			} else {
				original := f.config.Reverify
				f.config.Reverify = func(ctx context.Context, request port.HelperRequest) error {
					if err := original(ctx, request); err != nil {
						return err
					}
					app := filepath.Join(f.config.Files.Applications.Name(), "Farol.app")
					var appID port.HelperIdentity
					if point == "post-exchange-fence" {
						// Native Exchange has returned successfully; fail the
						// following tree-verification fence, not the syscall.
						info, err := os.Open(app)
						must(t, err)
						id := compositionIdentity(t, info)
						appID = port.HelperIdentity{Device: id.Device, Inode: id.Inode}
						must(t, info.Close())
					}
					if point == "prepared-ack" && f.diskPhase(t) == "prepared" ||
						point == "post-exchange-fence" && appID == f.targetID ||
						point == "journal-ack" && f.diskPhase(t) == "new_installed" ||
						point == "rejection-ack" && present("rejected-target.json") {
						injected = true
						return cause
					}
					return nil
				}
			}
			result, err := f.apply(t)
			var failure *executionapp.Failure
			if !injected || result != nil || !errors.As(err, &failure) || !failure.Uncertain || f.owner.retained() == nil {
				t.Fatal("incomplete native effect scope returned success or lost uncertainty", result, err)
			}
			if point == "journal-admission" {
				if !errors.Is(err, port.JournalUnproven) || f.owner.journalRetained != 1 {
					t.Fatal("actual journal admission refusal lost", err)
				}
			} else if !errors.Is(err, cause) {
				t.Fatal("original fence/rejection cause lost", err)
			}
			phase := map[string]string{
				"prepared-ack": "prepared", "post-exchange-fence": "prepared",
				"journal-admission": "prepared", "journal-ack": "new_installed",
				"rejection-admission": "rollback_started", "rejection-ack": "rollback_started",
			}[point]
			view := f.physical(t, f.repo, phase)
			app := filepath.Join(f.config.Files.Applications.Name(), "Farol.app")
			switch point {
			case "prepared-ack":
				lifecycleRequireTree(t, app, f.source)
				lifecycleRequireTree(t, filepath.Join(f.path, "staged.app"), f.target)
			case "post-exchange-fence":
				lifecycleRequireTree(t, app, f.target)
				lifecycleRequireTree(t, filepath.Join(f.path, "staged.app"), f.source)
			case "journal-admission", "journal-ack":
				lifecycleRequireTree(t, app, f.target)
				lifecycleRequireTree(t, filepath.Join(f.path, "previous.app"), f.source)
			case "rejection-admission":
				lifecycleRequireTree(t, app, f.source)
				if present("rejected-target.json") {
					t.Fatal("refused rejection was published")
				}
			case "rejection-ack":
				f.rejected(t)
			}
			before, checks := compositionSnapshot(t, f.root), f.owner.verified
			copyService := *f.execution
			repeated, retryErr := copyService.Apply(context.Background(), executionapp.ApplyCommand{})
			var consumed *executionapp.Failure
			if repeated != nil || !errors.As(retryErr, &consumed) || consumed.Code != "execution_attempt_unknown" || !consumed.Uncertain {
				t.Fatal("application copy permitted a second apply", retryErr)
			}
			_, err = f.recover(t)
			classified(t, err, "recovery_attempt_unknown", true)
			if strings.HasPrefix(point, "rejection-") {
				err = f.rejection.Record(context.Background(), f.targetID)
				classified(t, err, "attempt_used", true)
			}
			_, err = f.repo.CompareAndSwap(context.Background(), view.Revision, *view.Value)
			if !errors.Is(err, port.JournalUnknown) {
				t.Fatal("physical readback rearmed journal", err)
			}
			alias, err := journal.New(context.Background(), f.path, operation(f.config.Request), f.owner)
			if alias != nil {
				must(t, alias.Close())
				t.Fatal("fresh repository cleared unknown owner")
			}
			if !errors.Is(err, port.JournalUnknown) || f.owner.verified != checks || f.owner.retained() == nil {
				t.Fatal("fresh scope/repository reentered original admission", err)
			}
			f.unchanged(t, before)
		})
	}
}
