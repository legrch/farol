package boot

import (
	"bytes"
	"context"
	"encoding/json"
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

// Only wire correlation is exercised here. Complete zero structs do not grant
// domain validity or native eligibility; the existing inspections still do.
func preservedBindingWireFixture(t *testing.T) (preservedProfileInspectionInput, []byte) {
	t.Helper()
	var selected preservedProfileInspectionInput
	if err := json.Unmarshal([]byte(`{"Mutations":[{"Binding":{"Identity":{"OperationID":"operation","OwnerID":"owner","Scope":"owner-settings","ProfileID":"profile","ComputerID":"computer"},"WorkspaceID":"workspace","RequestDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","ComputerGeneration":1,"RelativePath":"note.md"}}]}`), &selected); err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(selected)
	if err != nil {
		t.Fatal(err)
	}
	return selected, raw
}

func TestPreservedProfileIntentBindingWireComparison(t *testing.T) {
	selected, canonical := preservedBindingWireFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if !preservedProfileIntentBindingsMatch(ctx, canonical, selected) {
		t.Fatal("complete native binding refused")
	}
	var frame map[string]any
	decoder := json.NewDecoder(bytes.NewReader(canonical))
	decoder.UseNumber()
	if err := decoder.Decode(&frame); err != nil {
		t.Fatal(err)
	}
	binding := frame["Mutations"].([]any)[0].(map[string]any)["Binding"].(map[string]any)
	identity := binding["Identity"].(map[string]any)
	for _, key := range []string{"SessionID", "TaskID", "TaskEpoch", "ParticipantID"} {
		delete(identity, key)
	}
	omitted, err := json.Marshal(frame)
	if err != nil || !preservedProfileIntentBindingsMatch(ctx, omitted, selected) {
		t.Fatal("existing four omitted Identity zeros refused", err)
	}
	for _, field := range []string{"Identity", "Connector", "ComputerGeneration", "WorkspaceID", "RequestDigest", "RelativePath"} {
		t.Run("missing-"+field, func(t *testing.T) {
			var value map[string]any
			if json.Unmarshal(canonical, &value) != nil {
				t.Fatal("fixture JSON")
			}
			binding := value["Mutations"].([]any)[0].(map[string]any)["Binding"].(map[string]any)
			delete(binding, field)
			raw, err := json.Marshal(value)
			if err != nil || preservedProfileIntentBindingsMatch(ctx, raw, selected) {
				t.Fatal("omitted native binding field admitted", err)
			}
		})
	}
	for _, value := range []any{nil, map[string]any{}, map[string]any{"SessionID": ""}} {
		binding["Connector"] = value
		raw, err := json.Marshal(frame)
		if err != nil || preservedProfileIntentBindingsMatch(ctx, raw, selected) {
			t.Fatal("noncanonical Connector admitted", err)
		}
	}
	// An explicit null is not one of the four omitted defaults accepted by the
	// host codec, even though Go's ordinary string decoder would leave zero.
	identity["SessionID"] = nil
	var original map[string]any
	if json.Unmarshal(canonical, &original) != nil {
		t.Fatal("fixture JSON")
	}
	binding["Connector"] = original["Mutations"].([]any)[0].(map[string]any)["Binding"].(map[string]any)["Connector"]
	raw, err := json.Marshal(frame)
	if err != nil || preservedProfileIntentBindingsMatch(ctx, raw, selected) {
		t.Fatal("explicit noncanonical value admitted", err)
	}
}

func TestPreservedProfileIntentBindingWireKeepsExactNumbersAndBudget(t *testing.T) {
	selected, _ := preservedBindingWireFixture(t)
	selected.Mutations[0].Binding.Connector.Generation = 9007199254740993
	raw, err := json.Marshal(selected)
	if err != nil || !preservedProfileIntentBindingsMatch(context.Background(), raw, selected) {
		t.Fatal("exact wire integer lost", err)
	}
	changed := bytes.Replace(raw, []byte("9007199254740993"), []byte("9007199254740992"), 1)
	if bytes.Equal(raw, changed) || preservedProfileIntentBindingsMatch(context.Background(), changed, selected) {
		t.Fatal("adjacent integer collapsed through float precision")
	}
	expired, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	if preservedProfileIntentBindingsMatch(nil, raw, selected) || preservedProfileIntentBindingsMatch(expired, raw, selected) {
		t.Fatal("missing or expired context admitted")
	}
}
