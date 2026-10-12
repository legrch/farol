package boot

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"reflect"
	"time"

	"github.com/legrch/farol/pkg/ipc"
)

// This separate diagnostic mode has no NativeRuntime/serve/provider/admission
// path. Its terminal zero qualifies this observation only, never recovery.
func runEmptyRecoveryInspection(args []string, in io.Reader, out io.Writer, diagnostics io.Writer) int {
	binding, ok := nativeInspectionBinding(args)
	if !ok {
		fmt.Fprintln(diagnostics, "EMPTY_RECOVERY_INSPECTION_INPUT_INVALID")
		return 2
	}
	raw, err := io.ReadAll(io.LimitReader(in, 65537))
	if err != nil || len(raw) > 65536 || ipc.ValidateJSON(raw) != nil || !emptyRecoveryCanonicalFields(raw, reflect.TypeFor[emptyRecoveryInspectionInput]()) {
		return 2
	}
	var selected emptyRecoveryInspectionInput
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(&selected) != nil || d.Decode(new(any)) != io.EOF || selected.Profile != (ProfileBinding{}) {
		return 2
	}
	selected.Profile = binding
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err = inspectEmptyRecovery(ctx, selected, func(v emptyRecoveryInspection) error {
		// Do not serialize the Head, original receipt, file contents or scope
		// paths. Exact hashes/root identities bind the private owner diagnostic.
		type retained struct {
			Key    string `json:"key"`
			SHA256 string `json:"sha256"`
		}
		observed := struct {
			Schema             string     `json:"schema"`
			BuildID            string     `json:"inspectionBuildId"`
			ProfileID          string     `json:"profileId"`
			Scope              string     `json:"observedChatGeneration"`
			Head               string     `json:"chatHandoffSha256"`
			Lifecycle          string     `json:"chatLifecycleSha256"`
			Access             string     `json:"computerAccessSha256"`
			Steps              int        `json:"emptyHandoffSteps"`
			Retained           []retained `json:"retainedMutationResults"`
			RecoveryAuthorized bool       `json:"recoveryAuthorized"`
		}{Schema: "farol-empty-recovery-inspection/1", BuildID: BuildID, ProfileID: binding.ProfileID, Scope: v.Plan.Selection.Current.BackendGeneration, Head: hex.EncodeToString(v.Plan.Selection.HeadDigest[:]), Lifecycle: hex.EncodeToString(v.Plan.Selection.LifecycleDigest[:]), Access: hex.EncodeToString(v.Access.Digest[:]), Steps: v.HandoffSteps}
		if v.InterruptedRetained != nil {
			for _, r := range v.InterruptedRetained.Retained {
				observed.Retained = append(observed.Retained, retained{r.Key, r.SHA256})
			}
		} else if v.PreservedRetained != nil {
			for _, r := range v.PreservedRetained.Retained {
				observed.Retained = append(observed.Retained, retained{r.Key, r.SHA256})
			}
		} else if v.EmptyRetained != nil {
			observed.Retained = []retained{}
		} else {
			for _, r := range v.Retained.Retained {
				observed.Retained = append(observed.Retained, retained{r.Key, r.SHA256})
			}
		}
		encoded, err := json.Marshal(observed)
		if err != nil {
			return err
		}
		encoded = append(encoded, '\n')
		n, err := out.Write(encoded)
		if err == nil && n != len(encoded) {
			err = io.ErrShortWrite
		}
		return err
	})
	if err != nil || ctx.Err() != nil {
		fmt.Fprintln(diagnostics, "EMPTY_RECOVERY_INSPECTION_REFUSED")
		return 1
	}
	return 0
}

// encoding/json accepts case aliases even with DisallowUnknownFields. Require
// exact destination spellings recursively before any native observation so two
// differently spelled keys cannot overwrite one selected identity.
func emptyRecoveryCanonicalFields(raw json.RawMessage, target reflect.Type) bool {
	switch target.Kind() {
	case reflect.Pointer:
		if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			return true
		}
		return emptyRecoveryCanonicalFields(raw, target.Elem())
	case reflect.Struct:
		var object map[string]json.RawMessage
		if json.Unmarshal(raw, &object) != nil || object == nil {
			return false
		}
		for name, value := range object {
			field, ok := target.FieldByName(name)
			if !ok || field.PkgPath != "" || field.Name != name || !emptyRecoveryCanonicalFields(value, field.Type) {
				return false
			}
		}
	case reflect.Array, reflect.Slice:
		var elements []json.RawMessage
		if json.Unmarshal(raw, &elements) != nil {
			return false
		}
		for _, value := range elements {
			if !emptyRecoveryCanonicalFields(value, target.Elem()) {
				return false
			}
		}
	}
	return true
}
