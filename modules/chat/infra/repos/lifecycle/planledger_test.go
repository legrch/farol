package lifecycle

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/legrch/farol/modules/chat/app/port"
	"sync"
	"sync/atomic"
	"testing"
)

func planRecordRaw(t *testing.T) []byte {
	t.Helper()
	_, p := fresh(t)
	source := struct {
		Scope             any
		Revision          uint64
		PublicationDigest string
	}{scope, 0, digest}
	operation := struct {
		Source                                                      any
		OperationDigest, BindingDigest, IntentDigest, WitnessDigest string
		Outcome                                                     any `json:",omitempty"`
	}{source, digest, digest, digest, digest, nil}
	extension, err := json.Marshal([]any{operation})
	if err != nil {
		t.Fatal(err)
	}
	return append(append(append([]byte{}, p.raw[:len(p.raw)-1]...), []byte(`,"plans":`)...), append(extension, '}')...)
}

func TestPlanLedgerCanonicalReservedMetadataIsRetained(t *testing.T) {
	raw := planRecordRaw(t)
	got, err := decode(raw, Limits{Bytes: 1 << 20, Records: 256})
	if err != nil {
		t.Fatalf("valid content-free original reservation rejected: %v", err)
	}
	again, err := encode(got, Limits{Bytes: 1 << 20, Records: 256})
	if err != nil || !bytes.Equal(raw, again) {
		t.Fatal("operation evidence lost", err)
	}
}

func TestPlanLedgerPlanOnlyJournalCannotQualifyAsEmpty(t *testing.T) {
	raw := planRecordRaw(t)
	got, err := inspectRecord(raw, Root{ProfileID: "profile", Device: 11, Inode: 23, OwnerUID: 501}, Limits{Bytes: 1 << 20, Records: 256})
	if err != nil {
		t.Fatalf("reserved operation inspection rejected: %v", err)
	}
	if got.EmptyFirstIncarnation {
		t.Fatal("consumed inference operation was classified as empty journal")
	}
}

// These are original storage-protocol fixtures; they do not qualify native
// rename, locking, power loss, descriptor admission or a production reopen.
func planReservation(t *testing.T, r *Repository, operation string) PlanReservation {
	t.Helper()
	head, err := r.CapturePlanHead(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return PlanReservation{Source: head, OperationDigest: planHash([]byte(operation)), BindingDigest: digest, IntentDigest: digest, WitnessDigest: digest}
}
func TestPlanLedgerReserveConsumesOriginalBeforeIOAndDuplicateNeverFresh(t *testing.T) {
	r, p := fresh(t)
	original := planReservation(t, r, "plan-op")
	copy := *r
	fresh, err := copy.ReservePlan(context.Background(), original)
	if err != nil || !fresh || p.replaces != 1 {
		t.Fatal(fresh, err, p.replaces)
	}
	reserved, err := r.ReservePlan(context.Background(), original)
	if err != nil || reserved || p.replaces != 1 {
		t.Fatal("same owner copy replay", reserved, err)
	}
	decoded, err := decode(p.raw, r.owner.limits)
	if err != nil || len(decoded.Plans) != 1 || decoded.Plans[0].Outcome != nil {
		t.Fatal("lost consumed unknown operation", err)
	}
}
func TestPlanLedgerLostReservationACKPoisonsOriginalOwnerAndRetainsDisk(t *testing.T) {
	for _, cancelled := range []bool{false, true} {
		t.Run(fmt.Sprint(cancelled), func(t *testing.T) {
			r, p := fresh(t)
			original := planReservation(t, r, "plan-op")
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if cancelled {
				p.hook = cancel
			} else {
				p.replaceFault = true
			}
			got, err := r.ReservePlan(ctx, original)
			if got || !errors.Is(err, Unknown) || p.replaces != 1 {
				t.Fatal(got, err)
			}
			p.hook = nil
			p.replaceFault = false
			if got, err = r.ReservePlan(context.Background(), original); got || !errors.Is(err, Unknown) || p.replaces != 1 {
				t.Fatal("uncertain original retried", got, err)
			}
			image, err := decode(p.raw, r.owner.limits)
			if err != nil || len(image.Plans) != 1 || image.Plans[0].Outcome != nil {
				t.Fatal("uncertain original bytes lost", err)
			}
			// Adapter-private reconstructed state proves persisted evidence is not fresh.
			// Production New still refuses the permanent native claim and supplies no
			// constructor capable of minting this fixture state.
			restored := newOwner("profile", r.owner.limits, &fixtureStorage{root: p}, fixtureRoot)
			restored.owner.current, restored.owner.digest, restored.owner.opened = image, sha256.Sum256(p.raw), true
			if got, err = restored.ReservePlan(context.Background(), original); got || err != nil || p.replaces != 1 {
				t.Fatal("stored unknown operation became fresh", got, err)
			}
		})
	}
}
func TestPlanLedgerSourceHeadCASRefusesBrowserOrPlanChange(t *testing.T) {
	for _, browser := range []bool{false, true} {
		t.Run(fmt.Sprint(browser), func(t *testing.T) {
			r, p := fresh(t)
			stale := planReservation(t, r, "plan-op")
			if browser {
				if _, err := r.Commit(context.Background(), admissionWrite(t)); err != nil {
					t.Fatal(err)
				}
			} else {
				other := stale
				other.OperationDigest = planHash([]byte("other-plan"))
				if fresh, err := r.ReservePlan(context.Background(), other); err != nil || !fresh {
					t.Fatal(err)
				}
			}
			if got, err := r.ReservePlan(context.Background(), stale); got || !errors.Is(err, Refused) || p.replaces != 1 {
				t.Fatal("stale original head authorized IO", got, err)
			}
		})
	}
}
func TestPlanLedgerOperationCollisionRejectsBothBrowserAndPlanDirections(t *testing.T) {
	for _, browserFirst := range []bool{false, true} {
		t.Run(fmt.Sprint(browserFirst), func(t *testing.T) {
			r, p := fresh(t)
			if browserFirst {
				if _, err := r.Commit(context.Background(), admissionWrite(t)); err != nil {
					t.Fatal(err)
				}
				got, err := r.ReservePlan(context.Background(), planReservation(t, r, "operation"))
				if got || !errors.Is(err, Refused) || p.replaces != 1 {
					t.Fatal("browser operation ID reused", got, err)
				}
			} else {
				if got, err := r.ReservePlan(context.Background(), planReservation(t, r, "operation")); !got || err != nil {
					t.Fatal(err)
				}
				if _, err := r.Commit(context.Background(), admissionWrite(t)); !errors.Is(err, Refused) || p.replaces != 1 {
					t.Fatal("plan operation ID reused", err)
				}
			}
		})
	}
}
func TestPlanLedgerHistoricalConflictCannotReplaceAnyOriginalWitness(t *testing.T) {
	mutations := []func(*PlanReservation){func(v *PlanReservation) { v.IntentDigest = planHash([]byte("changed")) }, func(v *PlanReservation) { v.BindingDigest = planHash([]byte("changed")) }, func(v *PlanReservation) { v.WitnessDigest = planHash([]byte("changed")) }, func(v *PlanReservation) { v.Source.PublicationDigest = planHash([]byte("changed")) }, func(v *PlanReservation) { v.Source.Scope.BackendGeneration = "changed" }}
	for n, change := range mutations {
		t.Run(fmt.Sprint(n), func(t *testing.T) {
			r, p := fresh(t)
			original := planReservation(t, r, "plan-op")
			if got, err := r.ReservePlan(context.Background(), original); !got || err != nil {
				t.Fatal(err)
			}
			altered := original
			change(&altered)
			if got, err := r.ReservePlan(context.Background(), altered); got || !errors.Is(err, Refused) || p.replaces != 1 {
				t.Fatal("consumed operation replaced", got, err)
			}
		})
	}
}
func TestPlanLedgerSettlementSurvivesSourceChangeWithoutTextOrReplay(t *testing.T) {
	r, p := fresh(t)
	original := planReservation(t, r, "plan-op")
	if got, err := r.ReservePlan(context.Background(), original); !got || err != nil {
		t.Fatal(err)
	}
	if _, err := r.Commit(context.Background(), admissionWrite(t)); err != nil {
		t.Fatal(err)
	}
	outcome := PlanOutcome{State: "completed", ResponseDigest: planHash([]byte("response-original")), HTTPStatus: 200}
	if err := r.SettlePlan(context.Background(), original, outcome); err != nil {
		t.Fatal("original remote completion erased after source change", err)
	}
	image, err := decode(p.raw, r.owner.limits)
	if err != nil || image.Plans[0].Outcome == nil || *image.Plans[0].Outcome != outcome || len(image.Writes) != 1 {
		t.Fatal("completion metadata lost", err)
	}
	before := p.replaces
	if err := r.SettlePlan(context.Background(), original, outcome); err != nil || p.replaces != before {
		t.Fatal("known original settlement replayed", err)
	}
	if got, err := r.ReservePlan(context.Background(), original); got || err != nil || p.replaces != before {
		t.Fatal("completed original became fresh", got, err)
	}
	altered := outcome
	altered.ResponseDigest = planHash([]byte("replacement"))
	if err := r.SettlePlan(context.Background(), original, altered); !errors.Is(err, Refused) || p.replaces != before {
		t.Fatal("known remote facts overwritten", err)
	}
}
func TestPlanLedgerLostSettlementACKRetainsOriginalFactsAndUnknown(t *testing.T) {
	r, p := fresh(t)
	original := planReservation(t, r, "plan-op")
	if _, err := r.ReservePlan(context.Background(), original); err != nil {
		t.Fatal(err)
	}
	p.replaceFault = true
	outcome := PlanOutcome{State: "completed", ResponseDigest: digest, HTTPStatus: 200}
	if err := r.SettlePlan(context.Background(), original, outcome); !errors.Is(err, Unknown) || p.replaces != 2 {
		t.Fatal(err)
	}
	p.replaceFault = false
	if err := r.SettlePlan(context.Background(), original, outcome); !errors.Is(err, Unknown) || p.replaces != 2 {
		t.Fatal("settlement retried", err)
	}
	image, err := decode(p.raw, r.owner.limits)
	if err != nil || image.Plans[0].Outcome == nil || *image.Plans[0].Outcome != outcome {
		t.Fatal("original remote facts discarded", err)
	}
}
func TestPlanLedgerInspectionAndRetirementCannotPruneConsumedOperations(t *testing.T) {
	r, p := fresh(t)
	original := planReservation(t, r, "plan-op")
	if _, err := r.ReservePlan(context.Background(), original); err != nil {
		t.Fatal(err)
	}
	view, err := inspectRecord(p.raw, Root{ProfileID: "profile", Device: 11, Inode: 23, OwnerUID: 501}, r.owner.limits)
	if err != nil || view.PlanCount != 1 || view.EmptyFirstIncarnation {
		t.Fatal(view, err)
	}
	if _, err := closedInspectionMetadata(view, scope); !errors.Is(err, Refused) {
		t.Fatal("plan-only snapshot minted closed-empty proof", err)
	}
	retirement := port.RetirementWrite{Scope: scope, Root: fixtureRoot, Revision: 1, Turns: []port.RetirementTurn{}}
	if receipt, err := r.Retire(context.Background(), retirement); receipt != nil || !errors.Is(err, Refused) || p.replaces != 1 {
		t.Fatal("plan metadata discarded by browser retirement", receipt, err)
	}
}
func TestPlanLedgerBoundsCanonicalAndOldBytesRemainExact(t *testing.T) {
	for _, variant := range []struct {
		version   int
		admission bool
	}{{2, false}, {2, true}, {3, false}, {3, true}} {
		r, _ := fresh(t)
		image := r.owner.current
		image.Version = variant.version
		if variant.admission {
			image.Writes = []port.JournalWrite{admissionWrite(t)}
		}
		before, err := encode(image, r.owner.limits)
		if err != nil {
			t.Fatal(err)
		}
		var old struct {
			Root         port.JournalRoot      `json:"root"`
			Incarnations []string              `json:"incarnations"`
			Retirement   *port.RetirementWrite `json:"retirement"`
			Version      int                   `json:"version"`
			Scope        port.JournalScope     `json:"scope"`
			Writes       []port.JournalWrite   `json:"writes"`
		}
		old.Root = image.Root
		old.Incarnations = image.Incarnations
		old.Retirement = image.Retirement
		old.Version = image.Version
		old.Scope = image.Scope
		old.Writes = image.Writes
		expected, _ := json.Marshal(old)
		if !bytes.Equal(before, expected) {
			t.Fatal("unused v2/v3 image changed")
		}
		decoded, err := decode(before, r.owner.limits)
		if err != nil || len(decoded.Plans) != 0 {
			t.Fatal(err)
		}
	}
	raw := planRecordRaw(t)
	for n, alter := range []func([]byte) []byte{
		func(b []byte) []byte { return append(b, ' ') },
		func(b []byte) []byte { return bytes.Replace(b, []byte(`"plans":`), []byte(`"unrecognizedPlans":`), 1) },
		func(b []byte) []byte { return bytes.Replace(b, []byte(`"version":3`), []byte(`"version":2`), 1) },
		func(b []byte) []byte {
			return bytes.Replace(b, []byte(`"WitnessDigest":"`+digest+`"`), []byte(`"WitnessDigest":"invalid"`), 1)
		},
		func(b []byte) []byte { return bytes.Replace(b, []byte(`"Revision":0`), []byte(`"Revision":1`), 1) },
	} {
		if _, err := decode(alter(raw), Limits{Bytes: 1 << 20, Records: 256}); !errors.Is(err, Invalid) {
			t.Fatalf("invalid metadata %d accepted: %v", n, err)
		}
	}
	r, p := fresh(t)
	r.owner.limits.Records = 1
	original := planReservation(t, r, "plan-op")
	if _, err := r.ReservePlan(context.Background(), original); err != nil {
		t.Fatal(err)
	}
	if err := r.SettlePlan(context.Background(), original, PlanOutcome{State: "unknown", Code: "INFERENCE_TRANSPORT_UNKNOWN"}); !errors.Is(err, Refused) || p.replaces != 1 {
		t.Fatal("budget evicted consumed operation", err)
	}
}
func TestPlanLedgerConcurrentCopiesHaveOneOriginalReservation(t *testing.T) {
	r, p := fresh(t)
	original := planReservation(t, r, "plan-op")
	copy := *r
	var freshCount atomic.Int32
	var wait sync.WaitGroup
	for n := 0; n < 16; n++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			got, err := copy.ReservePlan(context.Background(), original)
			if err != nil {
				t.Error(err)
			}
			if got {
				freshCount.Add(1)
			}
		}()
	}
	wait.Wait()
	if freshCount.Load() != 1 || p.replaces != 1 {
		t.Fatal("multiple original writers", freshCount.Load(), p.replaces)
	}
}

func TestPlanLedgerStrictRemoteMetadataRefusesUnboundedOrPrivateShapes(t *testing.T) {
	valid := PlanOutcome{State: "completed", ResponseDigest: digest, HTTPStatus: 200}
	for n, change := range []func(*PlanOutcome){
		func(v *PlanOutcome) { v.State = "suppressed" },
		func(v *PlanOutcome) { v.ResponseDigest = "raw-response-id" },
		func(v *PlanOutcome) { v.HTTPStatus = 600 },
		func(v *PlanOutcome) { v.HTTPStatus = -1 },
		func(v *PlanOutcome) { v.Code = "provider private diagnostic" },
		func(v *PlanOutcome) { v.ResponseDigest = "" },
	} {
		t.Run(fmt.Sprint(n), func(t *testing.T) {
			r, p := fresh(t)
			original := planReservation(t, r, "plan-op")
			if _, err := r.ReservePlan(context.Background(), original); err != nil {
				t.Fatal(err)
			}
			outcome := valid
			change(&outcome)
			if err := r.SettlePlan(context.Background(), original, outcome); !errors.Is(err, Refused) || p.replaces != 1 {
				t.Fatal("unsafe remote metadata persisted", err)
			}
		})
	}
	for _, state := range []string{"not_sent", "failed", "unknown"} {
		r, p := fresh(t)
		original := planReservation(t, r, "plan-op")
		if _, err := r.ReservePlan(context.Background(), original); err != nil {
			t.Fatal(err)
		}
		if err := r.SettlePlan(context.Background(), original, PlanOutcome{State: state, Code: "INFERENCE_TRANSPORT_UNKNOWN"}); err != nil {
			t.Fatal(err)
		}
		image, err := decode(p.raw, r.owner.limits)
		if err != nil || image.Plans[0].Outcome.State != state {
			t.Fatal(err)
		}
	}
}
func TestPlanLedgerCanonicalDuplicateNullAndPrivateFieldsAreRejected(t *testing.T) {
	raw := planRecordRaw(t)
	image, err := decode(raw, Limits{Bytes: 1 << 20, Records: 256})
	if err != nil {
		t.Fatal(err)
	}
	image.Plans = append(image.Plans, image.Plans[0])
	if _, err := encode(image, Limits{Bytes: 1 << 20, Records: 256}); !errors.Is(err, Invalid) {
		t.Fatal("duplicate operation accepted", err)
	}
	for n, bad := range [][]byte{
		bytes.Replace(raw, []byte(`,"plans":`), []byte(`,"plans":null,"plans":`), 1),
		bytes.Replace(raw, []byte(`"WitnessDigest":"`+digest+`"`), []byte(`"WitnessDigest":"`+digest+`","Text":"private response"`), 1),
		bytes.Replace(raw, []byte(`"WitnessDigest":"`+digest+`"`), []byte(`"WitnessDigest":"`+digest+`","Outcome":null`), 1),
	} {
		if _, err := decode(bad, Limits{Bytes: 1 << 20, Records: 256}); !errors.Is(err, Invalid) {
			t.Fatalf("noncanonical/private shape %d accepted: %v", n, err)
		}
	}
}
func TestPlanLedgerOriginalPublicationChangeRefusesBeforeAnyReplace(t *testing.T) {
	r, p := fresh(t)
	original := planReservation(t, r, "plan-op")
	p.raw = append(p.raw, ' ')
	if got, err := r.ReservePlan(context.Background(), original); got || !errors.Is(err, Unavailable) || p.replaces != 0 {
		t.Fatal("externally changed image replaced", got, err)
	}
	r, p = fresh(t)
	original = planReservation(t, r, "plan-op")
	r.owner.limits.Bytes = len(p.raw)
	if got, err := r.ReservePlan(context.Background(), original); got || !errors.Is(err, Refused) || p.replaces != 0 {
		t.Fatal("metadata byte bound evicted original image", got, err)
	}
}
