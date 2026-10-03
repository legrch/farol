package claude

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/legrch/farol/modules/task/domain"
)

func TestEveryByteFragmentationAndCRLFKeepsUsefulTextAndIdentity(t *testing.T) {
	s := streamFixture(t)
	var events []Event
	raw := strings.ReplaceAll(fixtureInit+fixtureDelta+fixtureResult, "\n", "\r\n")
	for _, b := range []byte(raw) {
		part, err := s.Feed([]byte{b})
		if err != nil {
			t.Fatal(err)
		}
		events = append(events, part...)
	}
	if err := s.Finish(); err != nil {
		t.Fatal(err)
	}
	if len(events) != 3 || events[1].Kind != "output_delta" || events[1].Text != "Useful café 🐙" || s.Snapshot().ProviderResult.Text != "fixture final" {
		t.Fatal(events, s.Snapshot())
	}
	data, _ := json.Marshal(s.Snapshot())
	if bytes.Contains(data, []byte("HIDDEN_REASONING")) {
		t.Fatal("reasoning retained")
	}
	copy := s.Snapshot()
	copy.ProviderResult.Text = "mutated"
	if s.Snapshot().ProviderResult.Text != "fixture final" {
		t.Fatal("snapshot aliases result")
	}
}
func TestProtocolFailuresAreStickyAndNeverRetainCompletion(t *testing.T) {
	cases := map[string]string{
		"wrong-session":      strings.Replace(fixtureInit, fixtureSession, "87654321-1234-1234-1234-123456789abc", 1),
		"wrong-model":        strings.Replace(fixtureInit, "fixture-model-a", "fixture-model-b", 1),
		"wrong-cwd":          strings.Replace(fixtureInit, "/fixture/writer", "/different", 1),
		"bypass-permission":  strings.Replace(fixtureInit, "default", "bypassPermissions", 1),
		"duplicate-init":     fixtureInit + fixtureInit,
		"duplicate-type":     `{"type":"system","type":"result"}` + "\n",
		"case-alias":         `{"type":"system","Type":"result"}` + "\n",
		"duplicate-result":   fixtureInit + fixtureResult + fixtureResult,
		"trailing-record":    fixtureInit + fixtureResult + fixtureDelta,
		"result-before-init": fixtureResult,
		"blank-line":         fixtureInit + "\n",
		"unknown-record":     fixtureInit + `{"type":"fantasy_input_ack"}` + "\n",
		"null-result":        fixtureInit + strings.Replace(fixtureResult, `"result":"fixture final"`, `"result":null`, 1),
		"null-error":         fixtureInit + strings.Replace(fixtureResult, `"is_error":false`, `"is_error":null`, 1),
		"null-denials":       fixtureInit + strings.Replace(fixtureResult, `"permission_denials":[]`, `"permission_denials":null`, 1),
		"nil-denial":         fixtureInit + strings.Replace(fixtureResult, `"permission_denials":[]`, `"permission_denials":[null]`, 1),
		"unknown-success":    fixtureInit + strings.Replace(fixtureResult, "success", "not_success", 1),
		"oversized-stream":   strings.Repeat("x", StreamLimit+1),
		"oversized-result":   fixtureInit + strings.Replace(fixtureResult, "fixture final", strings.Repeat("x", ResultLimit+1), 1),
		"nul":                fixtureInit + "\x00\n",
		"invalid-utf8":       fixtureInit + string([]byte{0xff, '\n'}),
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			s := streamFixture(t)
			if _, err := s.Feed([]byte(raw)); err == nil {
				t.Fatal("invalid stream accepted")
			}
			snapshot := s.Snapshot()
			if !snapshot.Unknown || snapshot.ProviderResult != nil || snapshot.Ended {
				t.Fatal("failure became completion", snapshot)
			}
			if _, err := s.Feed([]byte(fixtureInit + fixtureResult)); !errors.Is(err, task.ErrUnknown) {
				t.Fatal("failed parser revived", err)
			}
		})
	}
	for _, raw := range []string{fixtureInit, fixtureInit + strings.TrimSuffix(fixtureResult, "\n"), fixtureInit + fixtureDelta[:len(fixtureDelta)-1]} {
		s := streamFixture(t)
		s.Feed([]byte(raw))
		if err := s.Finish(); err == nil || !s.Snapshot().Unknown {
			t.Fatal("incomplete EOF completed", err)
		}
	}
}
func TestProviderResultDenialsAndFailuresNeverAcknowledgeInput(t *testing.T) {
	for _, tc := range []struct {
		name, raw string
		want      task.Lifecycle
	}{
		{"denied", strings.Replace(fixtureResult, `"permission_denials":[]`, `"permission_denials":[{"tool_name":"Write"}]`, 1), task.NeedsInput},
		{"failed", strings.Replace(strings.Replace(fixtureResult, `"is_error":false`, `"is_error":true`, 1), "success", "error_during_execution", 1), task.Failed},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := streamFixture(t)
			if _, err := s.Feed([]byte(fixtureInit + tc.raw)); err != nil {
				t.Fatal(err)
			}
			if err := s.Finish(); err != nil || s.Snapshot().ProviderResult.Lifecycle != tc.want {
				t.Fatal(s.Snapshot(), err)
			}
		})
	}
}
func TestToolPreviewAndHeartbeatAreNotUsefulOutputOrTaskCompletion(t *testing.T) {
	s := streamFixture(t)
	s.Feed([]byte(fixtureInit))
	frames := `{"type":"system","subtype":"heartbeat"}` + "\n" + `{"type":"stream_event","event":{"type":"input_json_delta","partial_json":"{\"path\":"}}` + "\n" + `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tool-one","name":"Write","input":{"path":"fixture.txt"}}]}}` + "\n"
	events, err := s.Feed([]byte(frames))
	if err != nil || len(events) != 0 || s.Snapshot().ProviderResult != nil {
		t.Fatal(events, err)
	}
	// Parser has no execution port: even complete tool data cannot dispatch a tool.
	if err := s.Finish(); err == nil {
		t.Fatal("tool round completed task")
	}
}
func TestUsefulOutputThroughSourceBytePipeBeforeTerminalRelease(t *testing.T) {
	// io.Pipe is an in-memory boundary, not native CLI/process containment proof.
	reader, writer := io.Pipe()
	defer reader.Close()
	defer writer.Close()
	first := make(chan Event, 4)
	release := make(chan struct{})
	var releaseOnce sync.Once
	var workers sync.WaitGroup
	t.Cleanup(func() { releaseOnce.Do(func() { close(release) }); reader.Close(); writer.Close(); workers.Wait() })
	done := make(chan error, 1)
	s := streamFixture(t)
	workers.Add(1)
	go func() {
		defer workers.Done()
		buf := make([]byte, 7)
		for {
			n, err := reader.Read(buf)
			if n > 0 {
				events, e := s.Feed(buf[:n])
				if e != nil {
					done <- e
					return
				}
				for _, event := range events {
					first <- event
				}
			}
			if err == io.EOF {
				done <- s.Finish()
				return
			}
			if err != nil {
				done <- err
				return
			}
		}
	}()
	generated := make(chan struct{})
	producerDone := make(chan error, 1)
	workers.Add(1)
	go func() {
		defer workers.Done()
		if _, err := writer.Write([]byte(fixtureInit + fixtureDelta)); err != nil {
			producerDone <- err
			return
		}
		<-release
		close(generated)
		_, err := writer.Write([]byte(fixtureResult))
		writer.Close()
		producerDone <- err
	}()
	var useful Event
	timeout := time.NewTimer(3 * time.Second)
	defer timeout.Stop()
	for useful.Kind != "output_delta" {
		select {
		case useful = <-first:
		case <-timeout.C:
			t.Fatal("useful output withheld until final")
		}
	}
	if useful.Text != "Useful café 🐙" || s.Snapshot().ProviderResult != nil {
		t.Fatal("future final invented", useful, s.Snapshot())
	}
	select {
	case <-generated:
		t.Fatal("terminal generated before release")
	default:
	}
	releaseOnce.Do(func() { close(release) })
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-timeout.C:
		t.Fatal("consumer did not finish")
	}
	if err := <-producerDone; err != nil {
		t.Fatal(err)
	}
	if !s.Snapshot().Ended || s.Snapshot().ProviderResult.Text != "fixture final" {
		t.Fatal(s.Snapshot())
	}
}

func TestReportedCanonicalModelIsSeparateFromRequestedNativeAlias(t *testing.T) {
	config := fixtureSelection()
	config.Binding.Model = "native-alias"
	config.ReportedModel = "fixture-model-a"
	selected, err := NewSelection(config)
	if err != nil {
		t.Fatal(err)
	}
	inv, err := selected.Build(fixtureDispatch(config))
	if err != nil {
		t.Fatal(err)
	}
	s, _ := NewStream(inv.Expected())
	if _, err := s.Feed([]byte(fixtureInit)); err != nil {
		t.Fatal(err)
	}
	if inv.Models().Resolved.Model != "native-alias" || s.Snapshot().Observed.Model != "fixture-model-a" || s.Snapshot().Observed.Evidence != "provider_reported" {
		t.Fatal("requested/resolved/report conflated")
	}
}
func TestPreInitNoticeDoesNotCreateObservationAndNestedJSONIsBounded(t *testing.T) {
	s := streamFixture(t)
	notice := `{"type":"system","subtype":"hook_started","session_id":"12345678-1234-1234-1234-123456789abc"}` + "\n"
	events, err := s.Feed([]byte(notice))
	if err != nil || len(events) != 0 || s.Snapshot().Observed.Evidence != "" {
		t.Fatal("notice became init", events, err)
	}
	nested := `{"type":"system","subtype":"hook_progress","extension":` + strings.Repeat("[", 33) + "0" + strings.Repeat("]", 33) + "}\n"
	if _, err := s.Feed([]byte(nested)); err == nil {
		t.Fatal("depth budget ignored")
	}
}
