package execution

import (
	"context"
	"errors"
	"os"
	stdruntime "runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/legrch/farol/modules/release/app/port"
)

// fakeLaunch drives every branch of the post-launch verification without a
// kernel. The runtime, journal, tree verification and held-descriptor hash
// derivation around it are the real ones; only the OS seam is scripted.
type fakeLaunch struct {
	mu        sync.Mutex
	clock     time.Time
	realSleep bool
	opens     int
	order     []string
	kills     []int
	killErr   error
	calls     struct{ candidates, image, start int }
	// Scripts receive the 1-based call number.
	candidatesFn func(call int) ([]int, error)
	imageFn      func(pid, call int) (liveImage, error)
	startFn      func(pid, call int) (processStart, error)
	// watchFn scripts the exit registration; nil registers cleanly.
	watchFn func(pid int) error
	// exitedFn scripts the final zero-timeout poll; nil reports no exit.
	exitedFn func() (bool, error)
	watches  int
	closed   int
	// duringOpen runs between the two fences of the one open, like a swap.
	duringOpen func()
}

func newFakeLaunch() *fakeLaunch { return &fakeLaunch{clock: time.Unix(1_000_000, 0)} }

func (f *fakeLaunch) open(ctx context.Context, _ time.Time, _ []string, fence func(context.Context) error) error {
	f.mu.Lock()
	f.opens++
	f.order = append(f.order, "open")
	f.mu.Unlock()
	if err := fence(ctx); err != nil {
		return err
	}
	if f.duringOpen != nil {
		f.duringOpen()
	}
	return fence(ctx)
}

func (f *fakeLaunch) candidates(_ context.Context, _ string) ([]int, error) {
	f.mu.Lock()
	f.calls.candidates++
	call := f.calls.candidates
	f.mu.Unlock()
	if f.candidatesFn == nil {
		return nil, nil
	}
	return f.candidatesFn(call)
}

func (f *fakeLaunch) image(pid int) (liveImage, error) {
	f.mu.Lock()
	f.calls.image++
	call := f.calls.image
	f.mu.Unlock()
	return f.imageFn(pid, call)
}

func (f *fakeLaunch) start(pid int) (processStart, error) {
	f.mu.Lock()
	f.calls.start++
	call := f.calls.start
	f.order = append(f.order, "start")
	f.mu.Unlock()
	return f.startFn(pid, call)
}

type fakeWatch struct{ f *fakeLaunch }

func (w fakeWatch) exited() (bool, error) {
	w.f.mu.Lock()
	w.f.order = append(w.f.order, "exited")
	w.f.mu.Unlock()
	if w.f.exitedFn == nil {
		return false, nil
	}
	return w.f.exitedFn()
}

func (w fakeWatch) close() error {
	w.f.mu.Lock()
	defer w.f.mu.Unlock()
	w.f.closed++
	return nil
}

func (f *fakeLaunch) watch(pid int) (exitWatch, error) {
	f.mu.Lock()
	f.watches++
	f.order = append(f.order, "watch")
	f.mu.Unlock()
	if f.watchFn != nil {
		if err := f.watchFn(pid); err != nil {
			return nil, err
		}
	}
	return fakeWatch{f}, nil
}

func (f *fakeLaunch) kill(pid int) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.kills = append(f.kills, pid)
	f.order = append(f.order, "kill")
	return f.killErr
}

func (f *fakeLaunch) now() time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.clock
}

func (f *fakeLaunch) sleep(ctx context.Context, d time.Duration) error {
	if f.realSleep {
		select {
		case <-time.After(d):
		case <-ctx.Done():
		}
		return ctx.Err()
	}
	f.mu.Lock()
	f.clock = f.clock.Add(d)
	f.mu.Unlock()
	return ctx.Err()
}

func recoveryFailure(t *testing.T, err error) *port.HelperRecoveryFailure {
	t.Helper()
	var failure *port.HelperRecoveryFailure
	if !errors.As(err, &failure) || failure == nil {
		t.Fatalf("not a classified failure: %v", err)
	}
	return failure
}

// A launch fixture over the real tree verification with a scripted OS seam.
func launchHarness(t *testing.T) (*relaunchFixture, *fakeLaunch, launchImage) {
	t.Helper()
	fake := newFakeLaunch()
	fx := newRelaunchFixture(t, fake, scratchExecutable(t, "good", stdruntime.GOARCH, ""))
	held, err := os.Open(fx.app)
	must(t, err)
	t.Cleanup(func() { _ = held.Close() })
	want, err := expectedLaunchImage(held, stdruntime.GOARCH)
	must(t, err)
	return fx, fake, want
}

var (
	pidOurs   = 4242
	startOurs = processStart{Seconds: 1_700_000_000, Microseconds: 123456}
)

func servesOne(pid int) func(int) ([]int, error) {
	return func(int) ([]int, error) { return []int{pid}, nil }
}

func substituteHash(want launchImage) launchImage {
	want.CDHash[0] ^= 0xff
	return want
}

func TestLaunchedImageMatchesVerifiedImage(t *testing.T) {
	fx, fake, want := launchHarness(t)
	fake.candidatesFn = servesOne(pidOurs)
	fake.imageFn = func(int, int) (liveImage, error) { return liveImage{Image: want, Start: startOurs}, nil }
	method, scope := fx.launch(t)
	if method != nil || scope != nil {
		t.Fatal("matching image refused", method, scope)
	}
	if fake.opens != 1 || len(fake.kills) != 0 || fake.calls.start != 0 {
		t.Fatal("match must open once and touch nothing", fake.opens, fake.kills, fake.calls.start)
	}
	if fx.phase(t) != "launch_requested" {
		t.Fatal("verification moved the journal")
	}
}

func TestSubstitutedImageIsKilledOnceAfterTheStartTimeCheck(t *testing.T) {
	want := func(name string, mutate func(launchImage) launchImage) {
		t.Run(name, func(t *testing.T) {
			fx, fake, verified := launchHarness(t)
			fake.candidatesFn = servesOne(pidOurs)
			fake.imageFn = func(int, int) (liveImage, error) {
				return liveImage{Image: mutate(verified), Start: startOurs}, nil
			}
			fake.startFn = func(int, int) (processStart, error) { return startOurs, nil }
			method, _ := fx.launch(t)
			failure := recoveryFailure(t, method)
			if failure.Code != "launch_image_mismatch" || failure.Uncertain || failure.Internal {
				t.Fatalf("not a definite mismatch: %+v", failure)
			}
			if fake.watches != 1 || fake.closed != 1 {
				t.Fatal("the exit watch was not registered once and closed", fake.watches, fake.closed)
			}
			if len(fake.kills) != 1 || fake.kills[0] != pidOurs || fake.opens != 1 {
				t.Fatal("expected exactly one kill of the exact pid after one open", fake.kills, fake.opens)
			}
			if !strings.HasSuffix(strings.Join(fake.order, ","), "watch,start,exited,kill") {
				t.Fatal("kill was not preceded by the start-time recheck", fake.order)
			}
			if fx.phase(t) != "launch_requested" {
				t.Fatal("mismatch moved the journal")
			}
		})
	}
	// Each field is independently decisive: same object with other code, and
	// the same code hash on another object.
	want("different code-signing hash", substituteHash)
	want("different executable object", func(i launchImage) launchImage { i.Inode++; return i })
	want("different device", func(i launchImage) launchImage { i.Device++; return i })
}

func TestStartTimeChangeOrExitPreventsTheKill(t *testing.T) {
	for name, start := range map[string]func(int, int) (processStart, error){
		"start time changed": func(int, int) (processStart, error) {
			return processStart{Seconds: startOurs.Seconds, Microseconds: startOurs.Microseconds + 1}, nil
		},
		"process gone":  func(int, int) (processStart, error) { return processStart{}, errProcessGone },
		"read failed":   func(int, int) (processStart, error) { return processStart{}, errors.New("sysctl failed") },
		"seconds moved": func(int, int) (processStart, error) { return processStart{Seconds: startOurs.Seconds + 1}, nil },
	} {
		t.Run(name, func(t *testing.T) {
			fx, fake, verified := launchHarness(t)
			fake.candidatesFn = servesOne(pidOurs)
			fake.imageFn = func(int, int) (liveImage, error) {
				return liveImage{Image: substituteHash(verified), Start: startOurs}, nil
			}
			fake.startFn = start
			method, _ := fx.launch(t)
			failure := recoveryFailure(t, method)
			if failure.Code != "launch_image_mismatch" || !failure.Uncertain {
				t.Fatalf("unsafe containment must stay uncertain: %+v", failure)
			}
			if len(fake.kills) != 0 {
				t.Fatal("killed a process that could not be proven the observed one", fake.kills)
			}
		})
	}
}

func TestExitWatchBindsTheKillToTheObservedProcess(t *testing.T) {
	for name, tc := range map[string]struct {
		watch  func(int) error
		exited func() (bool, error)
		start  func(int, int) (processStart, error)
		kills  int
	}{
		"clean": {kills: 1},
		"exit seen after registration": {
			exited: func() (bool, error) { return true, nil },
		},
		"exit poll failed": {
			exited: func() (bool, error) { return false, errors.New("kevent failed") },
		},
		"registration finds no process": {
			watch: func(int) error { return errProcessGone },
		},
		"registration failed": {
			watch: func(int) error { return errors.New("kqueue unavailable") },
		},
		"start changed after registration": {
			start: func(int, int) (processStart, error) { return processStart{Seconds: startOurs.Seconds + 1}, nil },
		},
	} {
		t.Run(name, func(t *testing.T) {
			fx, fake, verified := launchHarness(t)
			fake.candidatesFn = servesOne(pidOurs)
			fake.imageFn = func(int, int) (liveImage, error) {
				return liveImage{Image: substituteHash(verified), Start: startOurs}, nil
			}
			fake.startFn = func(int, int) (processStart, error) { return startOurs, nil }
			if tc.start != nil {
				fake.startFn = tc.start
			}
			fake.watchFn, fake.exitedFn = tc.watch, tc.exited
			method, _ := fx.launch(t)
			failure := recoveryFailure(t, method)
			if failure.Code != "launch_image_mismatch" || failure.Uncertain != (tc.kills == 0) {
				t.Fatalf("unexpected classification: %+v", failure)
			}
			if len(fake.kills) != tc.kills {
				t.Fatalf("kills = %v, want %d", fake.kills, tc.kills)
			}
			if tc.watch == nil && (fake.watches != 1 || fake.closed != 1) {
				t.Fatal("the exit watch was not registered once and closed", fake.watches, fake.closed)
			}
			if tc.watch != nil && (fake.calls.start != 0 || fake.closed != 0) {
				t.Fatal("a failed registration must stop before any start read", fake.calls.start, fake.closed)
			}
		})
	}
}

func TestKillFailureIsUncertain(t *testing.T) {
	fx, fake, verified := launchHarness(t)
	fake.candidatesFn = servesOne(pidOurs)
	fake.imageFn = func(int, int) (liveImage, error) {
		return liveImage{Image: substituteHash(verified), Start: startOurs}, nil
	}
	fake.startFn = func(int, int) (processStart, error) { return startOurs, nil }
	fake.killErr = errors.New("operation not permitted")
	method, _ := fx.launch(t)
	if failure := recoveryFailure(t, method); failure.Code != "launch_image_mismatch" || !failure.Uncertain || len(fake.kills) != 1 {
		t.Fatalf("a failed kill is not containment: %+v kills=%v", failure, fake.kills)
	}
}

func TestZeroCandidatesStayUncertainWithoutKillOrRetry(t *testing.T) {
	fx, fake, _ := launchHarness(t)
	method, scope := fx.launch(t)
	failure := recoveryFailure(t, method)
	if failure.Code != "launch_unverified" || !failure.Uncertain || failure.Internal {
		t.Fatalf("zero candidates must be uncertain: %+v", failure)
	}
	if fake.opens != 1 || len(fake.kills) != 0 || fake.calls.image != 0 {
		t.Fatal("no candidate may be killed, inspected or relaunched", fake.opens, fake.kills, fake.calls.image)
	}
	if elapsed := fake.now().Sub(time.Unix(1_000_000, 0)); elapsed < launchDiscoveryCap || elapsed > launchDiscoveryCap+time.Second {
		t.Fatal("discovery was not bounded by the cap", elapsed)
	}
	if scope == nil {
		t.Fatal("the unknown launch was not retained by the scope")
	}
}

func TestTwoCandidatesRefuseWithoutKilling(t *testing.T) {
	fx, fake, verified := launchHarness(t)
	fake.candidatesFn = func(int) ([]int, error) { return []int{pidOurs, pidOurs + 1}, nil }
	fake.imageFn = func(int, int) (liveImage, error) { return liveImage{Image: verified, Start: startOurs}, nil }
	method, _ := fx.launch(t)
	failure := recoveryFailure(t, method)
	if failure.Code != "launch_image_ambiguous" || !failure.Uncertain {
		t.Fatalf("ambiguity must be an uncertain refusal: %+v", failure)
	}
	if len(fake.kills) != 0 || fake.calls.image != 0 || fake.opens != 1 {
		t.Fatal("ambiguity must neither inspect, kill nor relaunch", fake.kills, fake.calls.image, fake.opens)
	}
}

func TestImpostorCarryingTheHintWithAnotherHashIsRejected(t *testing.T) {
	fx, fake, verified := launchHarness(t)
	fake.candidatesFn = servesOne(pidOurs)
	// The impostor copied the argument but runs different code.
	fake.imageFn = func(int, int) (liveImage, error) {
		other := substituteHash(verified)
		other.Inode += 7
		return liveImage{Image: other, Start: startOurs}, nil
	}
	fake.startFn = func(int, int) (processStart, error) { return startOurs, nil }
	method, _ := fx.launch(t)
	if failure := recoveryFailure(t, method); failure.Code != "launch_image_mismatch" || failure.Uncertain || len(fake.kills) != 1 {
		t.Fatalf("impostor not contained: %+v kills=%v", failure, fake.kills)
	}
}

func TestMismatchMustBeStableBeforeAnythingIsKilled(t *testing.T) {
	t.Run("an exec transition that settles on the verified image is not killed", func(t *testing.T) {
		fx, fake, verified := launchHarness(t)
		fake.candidatesFn = servesOne(pidOurs)
		interpreter := liveImage{Image: launchImage{Device: 1, Inode: 2}, Start: startOurs}
		fake.imageFn = func(_ int, call int) (liveImage, error) {
			if call <= 2 {
				return interpreter, nil // still the launcher's interpreter
			}
			return liveImage{Image: verified, Start: startOurs}, nil
		}
		method, scope := fx.launch(t)
		if method != nil || scope != nil || len(fake.kills) != 0 {
			t.Fatal("a transient interpreter image was treated as a substitute", method, scope, fake.kills)
		}
	})
	t.Run("an image that keeps changing is never confirmed", func(t *testing.T) {
		fx, fake, verified := launchHarness(t)
		fake.candidatesFn = servesOne(pidOurs)
		fake.imageFn = func(_ int, call int) (liveImage, error) {
			image := substituteHash(verified)
			image.Inode += uint64(call)
			return liveImage{Image: image, Start: startOurs}, nil
		}
		fake.startFn = func(int, int) (processStart, error) { return startOurs, nil }
		method, _ := fx.launch(t)
		if failure := recoveryFailure(t, method); failure.Code != "launch_unverified" || !failure.Uncertain || len(fake.kills) != 0 {
			t.Fatalf("unstable observations must never kill: %+v kills=%v", failure, fake.kills)
		}
	})
	t.Run("a process that exits between observations is not killed", func(t *testing.T) {
		fx, fake, verified := launchHarness(t)
		fake.candidatesFn = servesOne(pidOurs)
		fake.imageFn = func(_ int, call int) (liveImage, error) {
			if call == 1 {
				return liveImage{Image: substituteHash(verified), Start: startOurs}, nil
			}
			return liveImage{}, errProcessGone
		}
		method, _ := fx.launch(t)
		if failure := recoveryFailure(t, method); failure.Code != "launch_unverified" || !failure.Uncertain || len(fake.kills) != 0 {
			t.Fatalf("exit was not uncertain: %+v kills=%v", failure, fake.kills)
		}
	})
}

func TestDeadlineExceededMidPollIsUncertain(t *testing.T) {
	fx, fake, _ := launchHarness(t)
	fake.realSleep = true
	fx.config.Until = time.Now().Add(400 * time.Millisecond)
	start := time.Now()
	method, _ := fx.launch(t)
	failure := recoveryFailure(t, method)
	if !failure.Uncertain || len(fake.kills) != 0 || fake.opens != 1 {
		t.Fatalf("expired deadline must leave the launch unknown: %+v", failure)
	}
	if time.Since(start) > 3*time.Second {
		t.Fatal("polling outlived the original deadline")
	}
}

func TestLaunchRunsOnceAndNeverReplays(t *testing.T) {
	fx, fake, verified := launchHarness(t)
	fake.candidatesFn = servesOne(pidOurs)
	fake.imageFn = func(int, int) (liveImage, error) {
		return liveImage{Image: substituteHash(verified), Start: startOurs}, nil
	}
	fake.startFn = func(int, int) (processStart, error) { return startOurs, nil }
	var second error
	_ = fx.with(context.Background(), func(native port.HelperRecoveryRuntime) error {
		effects := native.(port.HelperRelaunchEffects)
		self, err := effects.SelfIdentity(context.Background())
		must(t, err)
		_ = effects.LaunchTarget(context.Background(), self, nil)
		second = effects.LaunchTarget(context.Background(), self, nil)
		return nil
	})
	if failure := recoveryFailure(t, second); failure.Code != "recovery_attempt_unknown" || !failure.Uncertain {
		t.Fatalf("a second launch attempt was not refused: %+v", failure)
	}
	if fake.opens != 1 || len(fake.kills) != 1 {
		t.Fatal("replay opened or killed again", fake.opens, fake.kills)
	}
}

func TestHeldTreeIsReverifiedAfterTheMatch(t *testing.T) {
	fx, fake, want := launchHarness(t)
	fake.candidatesFn = servesOne(pidOurs)
	fake.imageFn = func(int, int) (liveImage, error) {
		// The resources change after the process was found. The executable is
		// still the verified one, but the held tree no longer is.
		must(t, os.WriteFile(fx.app+"/Contents/Resources/app/build-identity.json", []byte("{}"), 0600))
		return liveImage{Image: want, Start: startOurs}, nil
	}
	method, _ := fx.launch(t)
	if failure := recoveryFailure(t, method); failure.Code != "tree_mismatch" || len(fake.kills) != 0 {
		t.Fatalf("post-match tree change accepted: %+v", failure)
	}
}

func TestHintMustNameTheOperationAndHelper(t *testing.T) {
	good := `--farol-installed-update-relaunch={"operationId":"abc","action":"apply","phase":"completed","helper":{"pid":77,"processStart":"x"},"buildId":"b"}`
	for name, tc := range map[string]struct {
		op     string
		pid    int64
		hint   string
		accept bool
	}{
		"exact":                  {"abc", 77, good, true},
		"other operation":        {"abd", 77, good, false},
		"other helper":           {"abc", 78, good, false},
		"pid prefix only":        {"abc", 7, good, false},
		"missing prefix":         {"abc", 77, strings.TrimPrefix(good, "--"), false},
		"empty operation":        {"", 77, good, false},
		"operation in wrong key": {"abc", 77, strings.Replace(good, `"operationId"`, `"other"`, 1), false},
	} {
		t.Run(name, func(t *testing.T) {
			got, ok := relaunchHint(tc.op, tc.pid, []string{"/usr/bin/open", "-a", "/x", "--args", tc.hint})
			if ok != tc.accept || ok && got != tc.hint {
				t.Fatalf("relaunchHint ok=%v", ok)
			}
		})
	}
	if _, ok := relaunchHint("abc", 77, []string{"/usr/bin/open"}); ok {
		t.Fatal("short argument list accepted")
	}
}

func TestUnboundHintRefusesBeforeOpen(t *testing.T) {
	fx, fake, _ := launchHarness(t)
	fx.config.RelaunchArguments = func(_ context.Context, _ port.HelperSelfIdentity, _ *string) ([]string, error) {
		return []string{"/usr/bin/open", "-a", fx.app, "--args", "--farol-installed-update-relaunch={}"}, nil
	}
	method, _ := fx.launch(t)
	if failure := recoveryFailure(t, method); failure.Code != "launch_image_unconfirmed" || fake.opens != 0 {
		t.Fatalf("a hint without the nonce reached open: %+v opens=%d", failure, fake.opens)
	}
}

func TestExpectedImageComesFromTheHeldBundle(t *testing.T) {
	good := scratchExecutable(t, "good", stdruntime.GOARCH, "")
	other := scratchExecutable(t, "other", stdruntime.GOARCH, "")
	open := func(path string) *os.File {
		f, err := os.Open(path)
		must(t, err)
		t.Cleanup(func() { _ = f.Close() })
		return f
	}
	t.Run("two builds derive two hashes", func(t *testing.T) {
		a, b := t.TempDir()+"/A.app", t.TempDir()+"/B.app"
		writeBundle(t, a, good)
		writeBundle(t, b, other)
		x, err := expectedLaunchImage(open(a), stdruntime.GOARCH)
		must(t, err)
		y, err := expectedLaunchImage(open(b), stdruntime.GOARCH)
		must(t, err)
		if x.CDHash == y.CDHash || x.Inode == y.Inode {
			t.Fatal("distinct bundles derived the same image")
		}
		want, err := parsedCDHash(t, good, stdruntime.GOARCH)
		must(t, err)
		if x.CDHash != want {
			t.Fatal("derived hash is not the executable's code-directory hash")
		}
	})
	t.Run("script launcher resolves to the runtime executable", func(t *testing.T) {
		app := t.TempDir() + "/Farol.app"
		writeBundle(t, app, good)
		must(t, os.Remove(app+"/Contents/MacOS/Sleeper"))
		must(t, os.WriteFile(app+"/Contents/MacOS/Farol Next Preview", []byte("#!/bin/sh\nexec "+runtimeReference+" \"$@\"\n"), 0700))
		must(t, os.MkdirAll(app+"/Contents/Frameworks/Electron Runtime.app/Contents/MacOS", 0700))
		copyFile(t, other, app+"/"+runtimeExecutable, 0700)
		got, err := expectedLaunchImage(open(app), stdruntime.GOARCH)
		must(t, err)
		want, err := parsedCDHash(t, other, stdruntime.GOARCH)
		must(t, err)
		if got.CDHash != want {
			t.Fatal("script launcher bound the wrong image")
		}
	})
	t.Run("refusals", func(t *testing.T) {
		build := func(mutate func(app string)) error {
			app := t.TempDir() + "/Farol.app"
			writeBundle(t, app, good)
			mutate(app)
			_, err := expectedLaunchImage(open(app), stdruntime.GOARCH)
			return err
		}
		for name, mutate := range map[string]func(string){
			"two executables": func(app string) { copyFile(t, good, app+"/Contents/MacOS/Second", 0700) },
			"empty directory": func(app string) { must(t, os.Remove(app+"/Contents/MacOS/Sleeper")) },
			"symlinked executable": func(app string) {
				must(t, os.Remove(app+"/Contents/MacOS/Sleeper"))
				must(t, os.Symlink(good, app+"/Contents/MacOS/Sleeper"))
			},
			"script naming another path": func(app string) {
				must(t, os.WriteFile(app+"/Contents/MacOS/Sleeper", []byte("#!/bin/sh\nexec /bin/sh\n"), 0700))
			},
			"script naming a missing runtime": func(app string) {
				must(t, os.WriteFile(app+"/Contents/MacOS/Sleeper", []byte("#!/bin/sh\nexec "+runtimeReference+"\n"), 0700))
			},
			"unsigned executable": func(app string) {
				must(t, os.WriteFile(app+"/Contents/MacOS/Sleeper", []byte("not a mach-o"), 0700))
			},
		} {
			if err := build(mutate); !errors.Is(err, errLaunchImage) {
				t.Fatalf("%s: derived an image: %v", name, err)
			}
		}
	})
}
