package boot

import (
	"bytes"
	"errors"
	"io"
	"strings"
	"testing"
	"time"
)

type preservedCommandInput struct {
	io.Reader
	deadline time.Time
	calls    int
	failure  bool
}

func (r *preservedCommandInput) SetReadDeadline(deadline time.Time) error {
	r.deadline, r.calls = deadline, r.calls+1
	if r.failure {
		return errors.New("private input failure")
	}
	return nil
}

type preservedCommandOutput struct {
	bytes.Buffer
	deadline time.Time
	calls    int
	failure  bool
}

func (w *preservedCommandOutput) SetWriteDeadline(deadline time.Time) error {
	w.deadline, w.calls = deadline, w.calls+1
	if w.failure {
		return errors.New("private output failure")
	}
	return nil
}

func preservedCommandArgs() []string {
	return []string{"--profile", "synthetic", "--profile-root", "/private/tmp/Farol Dev/farol-next-state/go-core", "--profile-device", "1", "--profile-inode", "2", "--expected-build", BuildID}
}

type preservedCommandUntouched struct{}

func (preservedCommandUntouched) Read([]byte) (int, error)  { panic("unexpected input") }
func (preservedCommandUntouched) Write([]byte) (int, error) { panic("unexpected output") }
func (preservedCommandUntouched) Close() error              { panic("unexpected caller stream close") }

func TestPreservedProfileCommandRejectsArgumentsAndNamespaceBeforeIO(t *testing.T) {
	cases := [][]string{nil, {"--profile"}, append(preservedCommandArgs(), "--deadline", "5000")}
	for index, value := range map[int]string{0: "--unknown", 2: "--profile", 5: "01", 7: "0", 9: "wrong-build"} {
		args := preservedCommandArgs()
		args[index] = value
		cases = append(cases, args)
	}
	for _, root := range []string{
		"/private/tmp/Farol Next Preview/farol-next-state/go-core",
		"/private/tmp/Farol/farol-next-state/go-core",
		"/private/tmp/Farol Dev copy/farol-next-state/go-core",
		"/private/tmp/Farol Dev/go-core",
		"/private/tmp/Farol Dev/farol-next-state/../farol-next-state/go-core",
	} {
		args := preservedCommandArgs()
		args[3] = root
		cases = append(cases, args)
	}
	for _, args := range cases {
		var diagnostics bytes.Buffer
		if code := runPreservedProfilePreparation(args, preservedCommandUntouched{}, preservedCommandUntouched{}, &diagnostics); code != 2 {
			t.Fatal("invalid argument/namespace admitted", code)
		}
	}
	var diagnostics bytes.Buffer
	if code := Run([]string{"prepare-preserved-recovery"}, preservedCommandUntouched{}, preservedCommandUntouched{}, &diagnostics); code != 2 || diagnostics.Len() != 0 {
		t.Fatal("Run did not dispatch private preparation", code, diagnostics.String())
	}
}

func TestPreservedProfileCommandRejectsUnboundedOrFailedStreamsBeforeRead(t *testing.T) {
	for _, fault := range []string{"input-unsupported", "output-unsupported", "read-deadline", "write-deadline"} {
		t.Run(fault, func(t *testing.T) {
			r := &preservedCommandInput{Reader: preservedCommandUntouched{}, failure: fault == "read-deadline"}
			w := &preservedCommandOutput{failure: fault == "write-deadline"}
			var in io.Reader = r
			var out io.Writer = w
			if fault == "input-unsupported" {
				in = preservedCommandUntouched{}
			}
			if fault == "output-unsupported" {
				out = preservedCommandUntouched{}
			}
			var diagnostics bytes.Buffer
			if code := runPreservedProfilePreparation(preservedCommandArgs(), in, out, &diagnostics); code != 2 || w.Len() != 0 {
				t.Fatal("unsupported stream reached preparation", code)
			}
		})
	}
}

func TestPreservedProfileCommandRejectsMalformedFramesBeforeEffects(t *testing.T) {
	cases := []string{
		"", "{}", "{\n", "null\n", "[]\n", "{} {}\n",
		"{\"unknown\":true}\n", "{\"InstalledPreserved\":true}\n",
		"{\"OwnerID\":\"one\",\"OwnerID\":\"two\"}\n",
		"{\"OwnerID\":\"one\",\"ownerid\":\"two\"}\n",
		"{\"Selection\":{\"Next\":{\"profileId\":\"other\"}}}\n",
		"{\"Selection\":{\"Next\":{\"ProfileID\":\"a\",\"ProfileID\":\"b\"}}}\n",
		"{\"Selection\":{\"Next\":{\"Unexpected\":true}}}\n",
		"{\"Mutations\":[{\"binding\":{}}]}\n",
		"{\"Mutations\":[{\"Binding\":{\"Identity\":{\"operationId\":\"other\"}}}]}\n",
		"{\"Profile\":null}\n", "{\"Profile\":{\"ProfileID\":\"synthetic\"}}\n",
		"{\"Profile\":{\"Root\":\"/private/tmp/private-path\"}}\n",
		"{\"Profile\":{\"Device\":1}}\n", "{\"Profile\":{\"Inode\":2}}\n",
		strings.Repeat(" ", 65537) + "\n", strings.Repeat("x", 65539) + "\n",
	}
	for n, raw := range cases {
		r := &preservedCommandInput{Reader: strings.NewReader(raw)}
		var w preservedCommandOutput
		var diagnostics bytes.Buffer
		deadline := time.Now().Add(time.Second)
		if code := runPreservedProfilePreparationDeadline(preservedCommandArgs(), r, &w, &diagnostics, deadline); code != 2 || w.Len() != 0 || diagnostics.Len() != 0 {
			t.Fatal("malformed frame reached preparation", n, code)
		}
		if r.calls != 1 || w.calls != 1 || r.deadline != deadline || w.deadline != deadline {
			t.Fatal("original stream deadline changed", n)
		}
	}
}

type preservedCommandLateInput struct{ until time.Time }

func (r preservedCommandLateInput) Read(b []byte) (int, error) {
	time.Sleep(time.Until(r.until) + time.Millisecond)
	return copy(b, "{}\n"), nil
}

func TestPreservedProfileCommandExpiredDeadlineCannotBecomeInputOrSuccess(t *testing.T) {
	for _, lateRead := range []bool{false, true} {
		deadline := time.Now().Add(-time.Second)
		var in io.Reader = preservedCommandUntouched{}
		if lateRead {
			deadline = time.Now().Add(20 * time.Millisecond)
			in = &preservedCommandInput{Reader: preservedCommandLateInput{deadline}}
		}
		var out preservedCommandOutput
		var diagnostics bytes.Buffer
		code := runPreservedProfilePreparationDeadline(preservedCommandArgs(), in, &out, &diagnostics, deadline)
		if code != 1 || out.Len() != 0 || diagnostics.String() != "PRESERVED_RECOVERY_PREPARATION_REFUSED_OR_UNKNOWN\n" {
			t.Fatal("expired budget was not safely refused", code, diagnostics.String())
		}
	}
}
