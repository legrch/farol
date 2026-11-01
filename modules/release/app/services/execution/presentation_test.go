package execution

import (
	"github.com/legrch/farol/modules/release/app/port"
	"testing"
)

func TestReadinessComparesPresentationValuesRatherThanPointers(t *testing.T) {
	a, b := "sidecar-only", "sidecar-only"
	left, right := port.HelperRequest{RelaunchPresentation: &a}, port.HelperRequest{RelaunchPresentation: &b}
	if !sameHelperRequest(left, right) {
		t.Fatal("independently owned equal values refused")
	}
	b = "other"
	if sameHelperRequest(left, right) {
		t.Fatal("changed presentation accepted")
	}
	right.RelaunchPresentation = nil
	if sameHelperRequest(left, right) {
		t.Fatal("omitted presentation accepted")
	}
}
