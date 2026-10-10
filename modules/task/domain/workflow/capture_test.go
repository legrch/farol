package workflow

import "testing"

func TestCaptureSeparatesAllMutablePlanSlices(t *testing.T) {
	p := fixture(3)
	p.Steps[2].Dependencies = []string{p.Steps[0].ID, p.Steps[1].ID}
	captured, err := Capture(p)
	if err != nil {
		t.Fatal(err)
	}
	p.Steps[0].OperationID = "changed"
	p.Steps[2].Dependencies[0] = "changed"
	p.Steps[2].Required[0] = CapabilityResume
	if captured.Steps[0].OperationID != "create-step-0" || captured.Steps[2].Dependencies[0] != "step-0" || captured.Steps[2].Required[0] != CapabilityCreate {
		t.Fatalf("capture retained caller aliases: %+v", captured)
	}
	consumer := captured.Steps[2].Clone()
	consumer.Dependencies[1] = "changed"
	consumer.Required[0] = CapabilityCancel
	if captured.Steps[2].Dependencies[1] != "step-1" || captured.Steps[2].Required[0] != CapabilityCreate {
		t.Fatal("consumer clone changed captured plan")
	}
}

func TestCaptureRefusesMalformedOrUnboundedMetadata(t *testing.T) {
	for _, p := range []Plan{{}, fixture(MaxSteps + 1), {ID: "bad", Steps: fixture(1).Steps}} {
		if got, err := Capture(p); err == nil || len(got.Steps) != 0 {
			t.Fatalf("invalid capture retained data: %+v %v", got, err)
		}
	}
	for _, capabilities := range []bool{false, true} {
		p := fixture(1)
		if capabilities {
			p.Steps[0].Required = make([]Capability, 6)
		} else {
			p.Steps[0].Dependencies = make([]string, MaxEdges+1)
		}
		if got, err := Capture(p); err == nil || len(got.Steps) != 0 {
			t.Fatalf("unbounded metadata captured: %+v %v", got, err)
		}
	}
}
