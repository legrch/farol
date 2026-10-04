package boot

// This is the controlled peer for the TypeScript TaskBridge integration test.
// Only the real framed Server, Chat parent, Task profile/service and Codex client
// run here. Journal/current host/provider sockets remain labelled CPU doubles.
// Dedicated inherited pipes separate actual protocol bytes from fixture control
// and the Go test runner. No fixture method enters the production wire schema.
import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"testing"
	"time"

	"github.com/legrch/farol/pkg/ipc"
	"github.com/legrch/farol/transport/desktop"
)

type taskBridgeCPUControl struct {
	ID      string `json:"id"`
	Command string `json:"command"`
	TurnID  string `json:"turnId,omitempty"`
}

func TestTaskBridgeCPUFixture(t *testing.T) {
	scenario := os.Getenv("FAROL_TASK_BRIDGE_CPU_SCENARIO")
	if scenario == "" {
		t.Skip("Controlled peer; executed by tests/integration/go-task-surface-peer.test.ts")
	}
	if scenario != "followup" && scenario != "provider-lost-reply" {
		t.Fatal("fixture scenario refused")
	}
	input := os.NewFile(3, "task-bridge-cpu-requests")
	output := os.NewFile(4, "task-bridge-cpu-replies")
	if input == nil || output == nil {
		t.Fatal("fixture inherited pipes unavailable")
	}
	t.Cleanup(func() { _ = input.Close(); _ = output.Close() })
	f := taskProfileTestSetup(t, scenario == "provider-lost-reply")
	taskProgressEnable(f.task)
	surface, err := NewTaskSurface(f.profile)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := surface.SelectCodex(context.Background(), f.input)
	if err != nil {
		t.Fatal(err)
	}
	server, err := desktop.New(desktop.Config{BuildID: "task-bridge-cpu", ProfileID: f.profile.peer.ProfileId, Generation: f.profile.peer.BackendGeneration, Methods: surface.Methods()})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- server.Serve(ctx, input, output) }()
	closed := false
	closePeer := func() error {
		if closed {
			return errors.New("fixture close repeated")
		}
		closed = true
		cancel()
		select {
		case err := <-done:
			if err != nil && !errors.Is(err, context.Canceled) {
				return err
			}
		case <-time.After(2 * time.Second):
			return errors.New("fixture original server terminal unknown")
		}
		closeCtx, closeCancel := context.WithTimeout(context.Background(), time.Second)
		defer closeCancel()
		return f.profile.Close(closeCtx)
	}
	t.Cleanup(func() {
		if !closed {
			if err := closePeer(); err != nil {
				t.Error(err)
			}
		}
	})
	counters := func() map[string]int {
		return map[string]int{"launches": int(f.task.pipe.launches.Load()), "threadStart": f.task.pipe.count("thread/start"), "turnStart": f.task.pipe.count("turn/start"), "threadRead": f.task.pipe.count("thread/read")}
	}
	encoder := json.NewEncoder(os.Stdout)
	emit := func(value any) {
		if err := encoder.Encode(value); err != nil {
			t.Fatal("fixture control write failed")
		}
	}
	emit(map[string]any{"kind": "ready", "buildId": "task-bridge-cpu", "profileId": f.profile.peer.ProfileId, "backendGeneration": f.profile.peer.BackendGeneration, "handle": handle})
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 1024), 4096)
	followed := false
	for scanner.Scan() {
		raw := scanner.Bytes()
		var control taskBridgeCPUControl
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.DisallowUnknownFields()
		if ipc.ValidateJSON(raw) != nil || decoder.Decode(&control) != nil || !validIngressID(control.ID) {
			t.Fatal("fixture control invalid")
		}
		var extra any
		if decoder.Decode(&extra) != io.EOF {
			t.Fatal("fixture control trailing value")
		}
		reply := map[string]any{"kind": "reply", "id": control.ID, "ok": true}
		valid := control.TurnID == ""
		switch control.Command {
		case "complete":
			valid = scenario == "followup" && (control.TurnID == "turn-1" || followed && control.TurnID == "turn-2")
			if valid {
				f.task.pipe.complete(control.TurnID)
			}
		case "follow":
			valid = valid && scenario == "followup" && !followed
			if valid {
				in := f.input
				in.Scope.TaskEpoch, in.Scope.TurnID = 2, "follow-up"
				next, err := surface.SelectCodex(ctx, in)
				if err != nil {
					t.Fatal("fixture next trusted selection failed")
				}
				followed = true
				reply["handle"] = next
			}
		case "stats":
			if valid {
				reply["stats"] = counters()
			}
		case "close":
			if valid {
				if err := closePeer(); err != nil {
					t.Fatal(err)
				}
				reply["stats"], reply["serverClosed"], reply["profileClosed"] = counters(), true, f.closed.Load() == 1
				emit(reply)
				return
			}
		default:
			valid = false
		}
		if !valid {
			reply["ok"], reply["code"] = false, "fixture_control_refused"
		}
		emit(reply)
	}
	if err := scanner.Err(); err != nil {
		t.Fatal("fixture control read failed")
	}
}
