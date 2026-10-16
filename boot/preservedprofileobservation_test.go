package boot

import (
	"bytes"
	"io"
	"strings"
	"testing"
	"time"
)

func TestPreservedProfileObservationCommandRejectsBeforeIO(t *testing.T) {
	for _, args := range [][]string{nil, {"--profile"}, append(preservedCommandArgs(), "--discover", "true")} {
		var diagnostic bytes.Buffer
		if code := runPreservedProfileObservation(args, preservedCommandUntouched{}, preservedCommandUntouched{}, &diagnostic); code != 2 || diagnostic.Len() != 0 {
			t.Fatal("invalid arguments reached observation", code)
		}
	}
	args := preservedCommandArgs()
	args[3] = "/private/tmp/Farol Next Preview/farol-next-state/go-core"
	var diagnostic bytes.Buffer
	if code := runPreservedProfileObservation(args, preservedCommandUntouched{}, preservedCommandUntouched{}, &diagnostic); code != 2 {
		t.Fatal("installed namespace reached observation", code)
	}
	if code := Run([]string{"observe-preserved-profile"}, preservedCommandUntouched{}, preservedCommandUntouched{}, &diagnostic); code != 2 {
		t.Fatal("missing observation dispatch", code)
	}
}

func TestPreservedProfileObservationCommandFramesAndOriginalBudget(t *testing.T) {
	for _, raw := range []string{"", "{} {}\n", "null\n", "{\"ownerid\":\"owner\"}\n", "{\"OwnerID\":\"a\",\"OwnerID\":\"b\"}\n", "{\"Profile\":null}\n", "{\"Profile\":{\"Root\":\"override\"}}\n", "{\"discover\":true}\n", strings.Repeat(" ", 65537) + "\n"} {
		until := time.Now().Add(time.Second)
		r := &preservedCommandInput{Reader: strings.NewReader(raw)}
		var w preservedCommandOutput
		var diagnostic bytes.Buffer
		if code := runPreservedProfileObservationDeadline(preservedCommandArgs(), r, &w, &diagnostic, until); code != 2 || w.Len() != 0 || diagnostic.Len() != 0 || r.deadline != until || w.deadline != until {
			t.Fatal("invalid observation frame/budget admitted", code)
		}
	}
	for _, stream := range []string{"reader", "writer", "failed-read", "failed-write", "expired", "late"} {
		var in io.Reader = &preservedCommandInput{Reader: preservedCommandUntouched{}, failure: stream == "failed-read"}
		var out io.Writer = &preservedCommandOutput{failure: stream == "failed-write"}
		until, want := time.Now().Add(time.Second), 2
		if stream == "reader" {
			in = preservedCommandUntouched{}
		}
		if stream == "writer" {
			out = preservedCommandUntouched{}
		}
		if stream == "expired" {
			until, want = time.Now().Add(-time.Second), 1
		}
		if stream == "late" {
			until, want = time.Now().Add(20*time.Millisecond), 1
			in = &preservedCommandInput{Reader: preservedCommandLateInput{until}}
		}
		var diagnostic bytes.Buffer
		if code := runPreservedProfileObservationDeadline(preservedCommandArgs(), in, out, &diagnostic, until); code != want {
			t.Fatal("unsupported or expired observation admitted", stream, code)
		}
		if want == 1 && diagnostic.String() != "PRESERVED_PROFILE_OBSERVATION_UNCONFIRMED\n" {
			t.Fatal("unsafe diagnostic")
		}
	}
}
