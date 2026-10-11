//go:build darwin && farol_native_process

package process

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"os/exec"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
)

// Opt-in lower-boundary leaf test ONLY. No Seatbelt/Qualification, held role,
// kqueue/no-fork certificate, shell, watchdog, connector or product activation.
// Execute once only after Lead confirms the serialized native lane. Each child
// runs only the helper below, with synthetic output and explicit environment.
func TestNativeOwnedLeafDrain(t *testing.T) {
	for _, mode := range []string{"nonzero-quick-input", "signal"} {
		if !t.Run(mode, func(t *testing.T) { nativeDrainLeaf(t, mode) }) {
			return // Denied/unknown native work ends this route; no next leaf.
		}
	}
}

func TestNativeDrainLeafHelper(t *testing.T) {
	mode := os.Getenv("FAROL_NATIVE_DRAIN_LEAF")
	if mode == "" {
		t.Skip("only the explicitly owned leaf launcher invokes this helper")
	}
	if mode != "nonzero-quick-input" && mode != "signal" {
		os.Exit(90)
	}
	if _, err := os.Stdout.Write([]byte{0, 255, 'O'}); err != nil {
		os.Exit(91)
	}
	if _, err := os.Stderr.Write([]byte{0, 255, 'E'}); err != nil {
		os.Exit(92)
	}
	if mode == "signal" {
		// Bounded natural exit even if the parent's single stop is refused.
		time.Sleep(2 * time.Second)
	}
	// Quick exit deliberately does not consume the large synthetic stdin.
	os.Exit(7)
}

type nativeDrainCollector struct {
	mutex sync.Mutex
	data  []byte
	ready chan struct{}
	once  sync.Once
}

func (c *nativeDrainCollector) Write(data []byte) (int, error) {
	c.mutex.Lock()
	c.data = append(c.data, data...)
	c.mutex.Unlock()
	c.once.Do(func() { close(c.ready) })
	return len(data), nil
}
func (c *nativeDrainCollector) snapshot() []byte {
	c.mutex.Lock()
	defer c.mutex.Unlock()
	return append([]byte(nil), c.data...)
}

type nativeDrainOwner struct {
	*nativeChild
	waits, stops atomic.Int32
}

func (o *nativeDrainOwner) Wait() (exit, error) {
	o.waits.Add(1)
	return o.nativeChild.Wait()
}
func (o *nativeDrainOwner) Kill() error {
	o.stops.Add(1)
	return o.nativeChild.Kill()
}

func nativeDrainLeaf(t *testing.T, mode string) {
	t.Helper()
	base, err := os.MkdirTemp("/private/tmp", "farol-native-drain-")
	if err != nil {
		t.Fatal("disposable setup refused; no native attempt:", err)
	}
	var child *Child
	var owner *nativeDrainOwner
	settled, startUnknown := false, false
	t.Cleanup(func() {
		if startUnknown {
			t.Errorf("start refused/unknown; retain %s; no retry", base)
			return
		}
		if child != nil && !settled {
			// SAME original handle, at most one stop. Never retry a failed stop.
			if owner.stops.Load() == 0 {
				child.stop(false)
			}
			select {
			case <-child.done:
				settled = true
			case <-time.After(3 * time.Second):
			}
		}
		if child != nil {
			if !settled {
				t.Errorf("exact owned Wait unresolved; retain %s; no retry", base)
				return
			}
			observation, readErr := child.Read(context.Background(), processsvc.Window{})
			child.mutex.Lock()
			stopUnknown := child.signalUnknown
			child.mutex.Unlock()
			if readErr != nil || !observation.Waited || !observation.OutputDrained || stopUnknown {
				t.Errorf("owned wait/drain/stop unknown; retain %s; stop native route", base)
				return
			}
		}
		if err := os.RemoveAll(base); err != nil {
			t.Error("remove exact disposable tree:", err)
		}
	})
	image, err := os.Executable()
	if err != nil {
		t.Fatal("test image unavailable:", err)
	}
	imageBytes, err := os.ReadFile(image)
	if err != nil {
		t.Fatal("test image measurement unavailable:", err)
	}
	digest := sha256.Sum256(imageBytes)
	out := &nativeDrainCollector{ready: make(chan struct{})}
	diagnostic := &nativeDrainCollector{ready: make(chan struct{})}
	cmd := exec.Command(image, "-test.run=^TestNativeDrainLeafHelper$", "-test.count=1")
	cmd.Env, cmd.Dir = []string{"FAROL_NATIVE_DRAIN_LEAF=" + mode}, base
	cmd.Stdin = bytes.NewReader(bytes.Repeat([]byte{'I'}, 1024*1024))
	cmd.Stdout, cmd.Stderr = &drainWitness{writer: out}, &drainWitness{writer: diagnostic}
	cmd.WaitDelay = time.Second
	if err := configure(cmd); err != nil {
		t.Fatal("leaf configuration refused:", err)
	}
	if err := cmd.Start(); err != nil {
		// No retry or alternate launcher. Preserve this attempt's disposable tree.
		startUnknown = true
		t.Fatalf("native leaf start refused/unknown; retain %s: %v", base, err)
	}
	retained := cmd.Process
	owner = &nativeDrainOwner{nativeChild: &nativeChild{command: cmd}}
	child = &Child{handle: "disposable-leaf", process: owner, done: make(chan struct{})}
	go child.wait() // One existing Child waiter, one original Cmd.Wait.
	t.Logf("owned leaf: mode=%s imageSHA256=%s tree=%s retainedPID=%d", mode, hex.EncodeToString(digest[:]), base, retained.Pid)
	if mode == "signal" {
		for _, ready := range []<-chan struct{}{out.ready, diagnostic.ready} {
			select {
			case <-ready:
			case <-time.After(time.Second):
				t.Fatal("leaf readiness unknown; stop route")
			}
		}
		receipt, err := child.Cancel(context.Background())
		if err != nil || receipt.Status != processsvc.CancelRequested {
			t.Fatal("original stop refused/unknown; no retry", receipt, err)
		}
	}
	select {
	case <-child.done:
		settled = true
	case <-time.After(3 * time.Second):
		t.Fatal("original Wait/drain unknown; stop route")
	}
	observed, err := child.Read(context.Background(), processsvc.Window{})
	if err != nil || !observed.Waited || !observed.OutputDrained || cmd.Process != retained || cmd.ProcessState == nil || owner.waits.Load() != 1 {
		t.Fatal("original Wait and independent EOF facts unavailable", observed, err)
	}
	if mode == "nonzero-quick-input" && (observed.ExitCode == nil || *observed.ExitCode != 7 || observed.ExitSignal != 0 || owner.stops.Load() != 0) {
		t.Fatal("quick nonzero exit differed from exact Wait", observed)
	}
	if mode == "signal" && (observed.ExitCode != nil || observed.ExitSignal != 9 || owner.stops.Load() != 1) {
		t.Fatal("original signal exit differed from exact Wait", observed)
	}
	if !bytes.Equal(out.snapshot(), []byte{0, 255, 'O'}) || !bytes.Equal(diagnostic.snapshot(), []byte{0, 255, 'E'}) {
		t.Fatal("binary leaf output differed from independently retained bytes")
	}
	if observed.GroupCleanup != processsvc.CleanupUnverified || observed.DescendantCleanup != processsvc.CleanupUnverified {
		t.Fatal("direct leaf invented process-tree containment")
	}
	t.Logf("one original Wait, stops=%d, both EOF/copies observed; group/descendants unverified; stdin acceptance unproven", owner.stops.Load())
}
