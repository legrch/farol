package helperprotocol_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	inputapp "github.com/legrch/farol/modules/release/app/services/helperinput"
	protocolapp "github.com/legrch/farol/modules/release/app/services/helperprotocol"
	"github.com/legrch/farol/modules/release/infra/native/helperchannels"
	nativeinput "github.com/legrch/farol/modules/release/infra/native/helperinput"
	"github.com/legrch/farol/modules/release/infra/native/helperprotocol"
)

// These portable pipe compositions are executed as Linux mechanism evidence.
// Every process, home, predecessor and lease value is synthetic: no filesystem,
// process, borrowed descriptor, installed helper, Darwin or provider proof is
// obtained. Pure frame validation never stands in for journal/effect admission.
func compositionInput() map[string]any {
	return map[string]any{
		"schema": "farol.installed-update/1", "action": "apply", "home": "/synthetic/home",
		"operationId": strings.Repeat("1", 32),
		"source":      map[string]any{"digest": strings.Repeat("2", 64), "version": "1.0", "buildId": strings.Repeat("3", 64)},
		"target":      map[string]any{"digest": strings.Repeat("4", 64), "version": "1.1", "buildId": strings.Repeat("5", 64)},
		"drain":       map[string]any{"status": "reconciled", "acceptedSource": strings.Repeat("3", 64), "acceptedTarget": strings.Repeat("5", 64)},
		"pid":         2345, "processStart": "synthetic process start", "waitSeconds": 30, "relaunch": true,
		"installLocation": "shared",
		"predecessor": map[string]any{
			"kind": "confirmed_closed", "startedAt": "2026-10-15T12:00:00Z", "lastQuitSha256": strings.Repeat("6", 64),
			"stateIdentity": map[string]any{"device": "11", "inode": "12"},
		},
		"leaseIdentity": map[string]any{"device": "11", "inode": "13"},
	}
}

// Build independent wire expectations from the full valid input, not codec
// goldens (which intentionally contain structurally valid non-request values).
func compositionContinue() map[string]any {
	m := compositionInput()
	for _, key := range []string{"home", "drain", "waitSeconds", "relaunch", "installLocation"} {
		delete(m, key)
	}
	m["schema"] = "farol.installed-update-continue/1"
	return m
}

func compositionJSON(t *testing.T, value any) []byte {
	t.Helper()
	b, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func compositionBind(t *testing.T, ctx context.Context) *protocolapp.Service {
	t.Helper()
	s, err := protocolapp.Bind(ctx, compositionJSON(t, compositionInput()), inputapp.New(nativeinput.JSONDecoder{}), helperprotocol.JSONCodec{})
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func compositionAppFailure(t *testing.T, err error, code string) {
	t.Helper()
	var f *protocolapp.Failure
	if !errors.As(err, &f) || f.Code != code || f.Internal != (code == "internal") {
		t.Fatalf("application failure = %#v, want %s", err, code)
	}
}

func compositionTransportFailure(t *testing.T, err error, code string, uncertain bool) {
	t.Helper()
	var f *helperchannels.Failure
	if !errors.As(err, &f) || f.Code != "helper_channels_"+code || f.Uncertain != uncertain {
		t.Fatalf("transport failure = %#v, want %s uncertain=%v", err, code, uncertain)
	}
}

func compositionPipes(t *testing.T) (*helperchannels.Channels, *os.File, *os.File) {
	t.Helper()
	ackPeer, ackOwner, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ackPeer.Close() })
	contOwner, contPeer, err := os.Pipe()
	if err != nil {
		_ = ackOwner.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = contPeer.Close() })
	// Transfer only these uniquely owned ends; never touch them after Take.
	c, err := helperchannels.Take(ackOwner, contOwner)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := c.Close(); err != nil {
			t.Error(err)
		}
	})
	return c, ackPeer, contPeer
}

func compositionReadACK(t *testing.T, peer *os.File) []byte {
	t.Helper()
	if err := peer.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatal(err)
	}
	b, err := io.ReadAll(peer)
	if err != nil {
		t.Fatal("ACK not sealed by EOF:", err)
	}
	return b
}

func compositionNoACK(t *testing.T, c *helperchannels.Channels, peer *os.File) {
	t.Helper()
	if err := c.Close(); err != nil {
		t.Fatal(err)
	}
	if got := compositionReadACK(t, peer); len(got) != 0 {
		t.Fatalf("pure application call unexpectedly emitted %d ACK bytes", len(got))
	}
}

func compositionSealed(t *testing.T, c *helperchannels.Channels, peer *os.File, ctx context.Context, until time.Time, b []byte) ([]byte, error) {
	t.Helper()
	// A concurrent owned writer also handles byte 4097 on smaller pipe buffers.
	written := make(chan error, 1)
	go func() {
		_, err := peer.Write(b)
		closeErr := peer.Close()
		if err == nil {
			err = closeErr
		}
		written <- err
	}()
	got, err := c.AwaitContinue(ctx, until)
	if writeErr := <-written; writeErr != nil {
		t.Fatal(writeErr)
	}
	return got, err
}

func TestCompositionRealInputHandoffACKAndContinuation(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	until, _ := ctx.Deadline()
	s := compositionBind(t, ctx)
	request, err := s.Request(ctx)
	if err != nil {
		t.Fatal(err)
	}
	request.OperationID = "caller mutation"
	request.Source.Version = "caller mutation"
	request.Predecessor.StateIdentity.Inode = "999"
	request.LeaseIdentity.Inode = "999"
	*request.InstallLocation = "legacy"
	retained, err := s.Request(ctx)
	if err != nil || retained.OperationID != strings.Repeat("1", 32) || retained.Source.Version != "1.0" ||
		retained.Predecessor.StateIdentity.Inode != "12" || retained.LeaseIdentity.Inode != "13" || *retained.InstallLocation != "shared" {
		t.Fatal("caller request copy mutated bound request", err)
	}
	for _, phase := range []string{"closed_predecessor_ready", "refused"} {
		t.Run(phase, func(t *testing.T) {
			var code *string
			expected := compositionContinue()
			expected["schema"], expected["phase"] = "farol.installed-update-handoff/1", phase
			if phase == "refused" {
				v := "synthetic_refusal"
				code, expected["error"] = &v, v
			}
			frame, err := s.BuildHandoff(ctx, phase, code)
			if err != nil || !bytes.HasSuffix(frame, []byte("\n")) {
				t.Fatal("handoff frame", err)
			}
			var got, want any
			if json.Unmarshal(frame, &got) != nil || json.Unmarshal(compositionJSON(t, expected), &want) != nil || !reflect.DeepEqual(got, want) {
				t.Fatalf("handoff shape/correlation drift: %s", frame)
			}
			again, err := s.BuildHandoff(ctx, phase, code)
			if err != nil || !bytes.Equal(frame, again) {
				t.Fatal("pure frame building was not repeatable", err)
			}
			c, ackPeer, contPeer := compositionPipes(t)
			copied := *c
			if err := c.Emit(ctx, until, frame); err != nil {
				t.Fatal(err)
			}
			if got := compositionReadACK(t, ackPeer); !bytes.Equal(got, frame) {
				t.Fatalf("ACK bytes differ: %q", got)
			}
			compositionTransportFailure(t, copied.Emit(ctx, until, again), "ack_used", true)
			wire := compositionJSON(t, compositionContinue())
			sealed, err := compositionSealed(t, c, contPeer, ctx, until, wire)
			if err != nil || !bytes.Equal(sealed, wire) {
				t.Fatal("continuation transport", err)
			}
			for range 2 {
				if err := s.ValidateContinuation(ctx, sealed); err != nil {
					t.Fatal("pure matching continuation", err)
				}
			}
			_, err = copied.AwaitContinue(ctx, until)
			compositionTransportFailure(t, err, "continue_used", false)
			if err := c.Close(); err != nil {
				t.Fatal(err)
			}
			compositionTransportFailure(t, copied.Emit(ctx, until, frame), "closed", true)
		})
	}
	frame, err := s.BuildHandoff(ctx, "waiting_for_exit", nil)
	if frame != nil {
		t.Fatal("closed predecessor produced waiting frame")
	}
	compositionAppFailure(t, err, "handoff_phase")
}

func TestCompositionOrdinaryProcessHandoffStillRequiresLiveMode(t *testing.T) {
	for _, action := range []string{"apply", "recover", "rollback"} {
		for _, relaunch := range []bool{false, true} {
			t.Run(action+"/"+map[bool]string{false: "closed", true: "relaunch"}[relaunch], func(t *testing.T) {
				ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
				defer cancel()
				until, _ := ctx.Deadline()
				input := compositionInput()
				delete(input, "predecessor")
				delete(input, "leaseIdentity")
				input["action"], input["relaunch"] = action, relaunch
				s, err := protocolapp.Bind(ctx, compositionJSON(t, input), inputapp.New(nativeinput.JSONDecoder{}), helperprotocol.JSONCodec{})
				if err != nil {
					t.Fatal(err)
				}
				frame, err := s.BuildHandoff(ctx, protocolapp.WaitingForExit, nil)
				if action == "recover" && !relaunch {
					compositionAppFailure(t, err, "handoff_phase")
					if frame != nil {
						t.Fatal("offline recovery produced normal-Quit frame")
					}
					return
				}
				if err != nil {
					t.Fatal(err)
				}
				var observed map[string]any
				if json.Unmarshal(frame, &observed) != nil || observed["phase"] != "waiting_for_exit" || len(observed) != 8 || observed["action"] != action {
					t.Fatal("ordinary handoff shape changed", string(frame))
				}
				c, peer, _ := compositionPipes(t)
				if err := c.Emit(ctx, until, frame); err != nil {
					t.Fatal(err)
				}
				if !bytes.Equal(compositionReadACK(t, peer), frame) {
					t.Fatal("ordinary frame lost EOF seal")
				}
				compositionAppFailure(t, s.ValidateContinuation(ctx, compositionJSON(t, compositionContinue())), "continue_identity")
			})
		}
	}
}

func TestCompositionEveryCrossedCorrelationRefusesAfterEOF(t *testing.T) {
	paths := []string{
		"schema", "operationId", "action", "pid", "processStart",
		"source.digest", "source.version", "source.buildId", "target.digest", "target.version", "target.buildId",
		"predecessor.kind", "predecessor.startedAt", "predecessor.lastQuitSha256",
		"predecessor.stateIdentity.device", "predecessor.stateIdentity.inode", "leaseIdentity.device", "leaseIdentity.inode",
		"omit_predecessor", "omit_leaseIdentity",
	}
	for _, path := range paths {
		t.Run(path, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			until, _ := ctx.Deadline()
			s := compositionBind(t, ctx)
			m := compositionContinue()
			if key, omit := strings.CutPrefix(path, "omit_"); omit {
				delete(m, key)
			} else {
				parts := strings.Split(path, ".")
				field := m
				for _, part := range parts[:len(parts)-1] {
					field = field[part].(map[string]any)
				}
				if path == "pid" {
					field[path] = 2346
				} else {
					field[parts[len(parts)-1]] = "crossed"
				}
			}
			c, ackPeer, contPeer := compositionPipes(t)
			sealed, err := compositionSealed(t, c, contPeer, ctx, until, compositionJSON(t, m))
			if err != nil {
				t.Fatal(err)
			}
			compositionAppFailure(t, s.ValidateContinuation(ctx, sealed), "continue_identity")
			compositionNoACK(t, c, ackPeer)
		})
	}
}

func TestCompositionIndependentMalformedContinuation(t *testing.T) {
	valid := compositionJSON(t, compositionContinue())
	for name, wire := range map[string][]byte{
		"malformed":      []byte("{"),
		"duplicate":      append([]byte(`{"action":"apply",`), valid[1:]...),
		"unpaired_utf16": bytes.Replace(valid, []byte(`"synthetic process start"`), []byte(`"\ud800"`), 1),
	} {
		t.Run(name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			until, _ := ctx.Deadline()
			s := compositionBind(t, ctx)
			c, ackPeer, contPeer := compositionPipes(t)
			sealed, err := compositionSealed(t, c, contPeer, ctx, until, wire)
			if err != nil {
				t.Fatal(err)
			}
			compositionAppFailure(t, s.ValidateContinuation(ctx, sealed), "continue_invalid")
			compositionNoACK(t, c, ackPeer)
		})
	}
	s := compositionBind(t, context.Background())
	compositionAppFailure(t, s.ValidateContinuation(context.Background(), bytes.Repeat([]byte(" "), 4097)), "continue_size")
}

func TestCompositionRealInputRefusalsCannotBind(t *testing.T) {
	acceptance := compositionInput()
	acceptance["drain"].(map[string]any)["status"] = "pending"
	for _, tc := range []struct {
		name, code string
		wire       []byte
	}{
		{"malformed", "input", []byte("{")},
		{"duplicate", "input", append([]byte(`{"action":"apply",`), compositionJSON(t, compositionInput())[1:]...)},
		{"acceptance", "acceptance", compositionJSON(t, acceptance)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, err := protocolapp.Bind(context.Background(), tc.wire, inputapp.New(nativeinput.JSONDecoder{}), helperprotocol.JSONCodec{})
			if s != nil {
				t.Fatal("refused real input bound a service")
			}
			compositionAppFailure(t, err, tc.code)
		})
	}
}

func TestCompositionContextRemainsOriginalAcrossReadAndValidation(t *testing.T) {
	for _, mode := range []string{"nil", "cancel", "deadline"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
			defer cancel()
			until, _ := ctx.Deadline()
			s := compositionBind(t, ctx)
			c, ackPeer, contPeer := compositionPipes(t)
			sealed, err := compositionSealed(t, c, contPeer, ctx, until, compositionJSON(t, compositionContinue()))
			if err != nil {
				t.Fatal(err)
			}
			// Deliberately expire AFTER successful read, without refreshing ctx or
			// its original deadline before the application validates the bytes.
			callCtx, code := ctx, "canceled"
			switch mode {
			case "nil":
				callCtx, code = nil, "internal"
			case "cancel":
				cancel()
			case "deadline":
				<-ctx.Done()
			}
			compositionAppFailure(t, s.ValidateContinuation(callCtx, sealed), code)
			frame, err := s.BuildHandoff(callCtx, "closed_predecessor_ready", nil)
			if frame != nil {
				t.Fatal("invalid context produced frame")
			}
			compositionAppFailure(t, err, code)
			if _, err := s.Request(callCtx); err == nil {
				t.Fatal("invalid context returned request")
			}
			bound, err := protocolapp.Bind(callCtx, compositionJSON(t, compositionInput()), inputapp.New(nativeinput.JSONDecoder{}), helperprotocol.JSONCodec{})
			if bound != nil {
				t.Fatal("invalid context bound service")
			}
			compositionAppFailure(t, err, code)
			compositionNoACK(t, c, ackPeer)
		})
	}
}

func TestCompositionTransportStillConsumesOriginalAttempt(t *testing.T) {
	for _, mode := range []string{"withheld_eof", "byte_4097", "cancel", "deadline", "close"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
			defer cancel()
			until, _ := ctx.Deadline()
			s := compositionBind(t, ctx)
			wire := compositionJSON(t, compositionContinue())
			if err := s.ValidateContinuation(ctx, wire); err != nil {
				t.Fatal(err)
			}
			c, ackPeer, contPeer := compositionPipes(t)
			copied := *c
			var got []byte
			var err error
			code := "deadline"
			switch mode {
			case "byte_4097":
				code = "continue_size"
				got, err = compositionSealed(t, c, contPeer, ctx, until, append(wire, bytes.Repeat([]byte(" "), 4097-len(wire))...))
			default:
				if _, writeErr := contPeer.Write(wire); writeErr != nil {
					t.Fatal(writeErr)
				}
				switch mode {
				case "cancel":
					code = "cancelled"
					cancel()
				case "deadline":
					<-ctx.Done()
				case "close":
					code = "closed"
					if closeErr := copied.Close(); closeErr != nil {
						t.Fatal(closeErr)
					}
				}
				got, err = c.AwaitContinue(ctx, until)
			}
			compositionTransportFailure(t, err, code, false)
			if got != nil {
				t.Fatal("transport refusal exposed continuation bytes")
			}
			_, err = copied.AwaitContinue(ctx, until)
			replayCode := "continue_used"
			if mode == "close" {
				replayCode = "closed"
			}
			compositionTransportFailure(t, err, replayCode, false)
			compositionNoACK(t, c, ackPeer)
		})
	}
}
