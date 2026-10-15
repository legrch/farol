//go:build !linux && !darwin

package installcopy

import "context"

type rootPins struct{}

func prepareSystem(*captured) error { return refusal("unsupported") }
func runSystem(o *Operation, _ context.Context) error {
	if o == nil || o.capture == nil || !o.capture.used.CompareAndSwap(false, true) {
		return &Failure{Code: "launch_copy_consumed", Uncertain: true}
	}
	return refusal("unsupported")
}
