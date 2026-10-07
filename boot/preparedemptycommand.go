//go:build darwin

package boot

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"reflect"
	"time"

	"github.com/legrch/farol/pkg/ipc"
)

// Private read-only diagnostic. Original publication identity is selected;
// --expected-build pins this observer, never replaces the original BuildID.
func runPreparedEmptyInspection(args []string, in io.Reader, out, diagnostics io.Writer) int {
	binding, ok := nativeInspectionBinding(args)
	if !ok || !emptyRecoveryDevRoot(binding.Root) {
		return 2
	}
	raw, err := io.ReadAll(io.LimitReader(in, 65537))
	if err != nil || len(raw) > 65536 || ipc.ValidateJSON(raw) != nil || !emptyRecoveryCanonicalFields(raw, reflect.TypeFor[preparedEmptyInspectionInput]()) {
		return 2
	}
	var selected preparedEmptyInspectionInput
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(&selected) != nil || d.Decode(new(any)) != io.EOF || selected.Original.Profile != (ProfileBinding{}) {
		return 2
	}
	selected.Original.Profile = binding
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var observed preparedEmptyInspection
	err = inspectPreparedEmptyRecovery(ctx, selected, func(value preparedEmptyInspection) error {
		observed = value
		return nil
	})
	// Serialize only after every retained claim and final readback closes cleanly.
	if err != nil || ctx.Err() != nil || observed.Schema != "farol-prepared-empty-inspection/1" {
		fmt.Fprintln(diagnostics, "PREPARED_EMPTY_INSPECTION_REFUSED")
		return 1
	}
	encoded, err := json.Marshal(observed)
	if err != nil || len(encoded) > 8191 {
		return 1
	}
	encoded = append(encoded, '\n')
	n, err := out.Write(encoded)
	if err != nil || n != len(encoded) {
		return 1
	}
	return 0
}
