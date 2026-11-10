package observation

import (
	"context"
	"errors"
	port "github.com/legrch/farol/modules/computer/app/port/observation"
	svc "github.com/legrch/farol/modules/computer/app/services/observation"
	domain "github.com/legrch/farol/modules/computer/domain/observation"
	"testing"
)

type fakeProbe struct {
	calls int
	fail  error
}

func (p *fakeProbe) Observe(context.Context, string) (domain.Observation, error) {
	p.calls++
	return domain.Observation{Binding: domain.Binding{Path: "/approved/work", Device: "7", Inode: "2"}, Evidence: evidence()}, p.fail
}
func evidence() domain.Evidence {
	return domain.Evidence{Schema: domain.EvidenceSchema, Filesystem: "apfs", VolumeUUID: "11111111-2222-3333-4444-555555555555", FileID: "2", BirthSeconds: "3", BirthNanoseconds: "0"}
}
func TestDTOClosedStatesAndNoAuthority(t *testing.T) {
	raw, _ := domain.EncodeEvidence(evidence())
	req := Request{Root: "/approved/work", Device: "1", Inode: "2", Settlement: "settled", EvidenceJSON: raw}
	for _, tc := range []struct {
		name    string
		raw     []byte
		state   string
		want    string
		failure bool
		calls   int
	}{
		{"candidate", raw, "settled", "remount-candidate", false, 1}, {"legacy", nil, "settled", "legacy-reconfirmation-required", false, 0}, {"empty", []byte{}, "settled", "", true, 0}, {"null", []byte("null"), "settled", "", true, 0}, {"unknown dominates invalid", []byte("broken"), "unknown", "unresolved-outcome", false, 0}, {"missing settlement", raw, "", "unresolved-outcome", false, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := &fakeProbe{}
			r := req
			r.EvidenceJSON = tc.raw
			r.Settlement = tc.state
			got, err := New(svc.New(p)).Assess(context.Background(), r)
			if (err != nil) != tc.failure || p.calls != tc.calls {
				t.Fatalf("got=%v err=%v calls=%d", got, err, p.calls)
			}
			if err == nil && (got.Classification != tc.want || got.Authority != "not-established") {
				t.Fatalf("unexpected authority %v", got)
			}
		})
	}
}
func TestErrorsAreSanitizedAndNeverRetry(t *testing.T) {
	raw, _ := domain.EncodeEvidence(evidence())
	req := Request{Root: "/approved/work", Device: "1", Inode: "2", Settlement: "settled", EvidenceJSON: raw}
	for _, input := range []error{errors.New("private native path /secret"), &port.Failure{Code: "PRIVATE_UNKNOWN"}, &port.Failure{Code: "WORKSPACE_PATH_REFUSED"}} {
		p := &fakeProbe{fail: input}
		response, err := New(svc.New(p)).Assess(context.Background(), req)
		var f *Failure
		if response != nil || !errors.As(err, &f) || f.Retry != "never" || p.calls != 1 {
			t.Fatalf("%v %v", response, err)
		}
		expected := "WORKSPACE_IDENTITY_UNAVAILABLE"
		if input.Error() == "WORKSPACE_PATH_REFUSED" {
			expected = input.Error()
		}
		if f.Code != expected {
			t.Fatal(f.Code)
		}
	}
}
