package journal

import "testing"

const a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const b = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
const id1 = "11111111-1111-4111-8111-111111111111"
const id2 = "22222222-2222-4222-8222-222222222222"
const boot1 = "33333333-3333-4333-8333-333333333333"
const boot2 = "44444444-4444-4444-8444-444444444444"

var good = Request{OperationID: id1, RequestDigest: a, ConsentDigest: b, ProfileID: "profile", OwnerID: "owner", ComputerID: "computer", WorkspaceID: "workspace", Root: "/Users/example", ExpectedRevision: "4", ExpectedGeneration: "2", BootUUID: boot1, HostLifetimeID: "runtime"}
var receipt = Receipt{EffectID: "effect-a", Digest: a}

func TestAdmissionFirstDurableIntentAndNoDuplicateDispatch(t *testing.T) {
	j := Journal{Entries: []Entry{}}
	if !j.Valid() {
		t.Fatal("empty journal invalid")
	}
	n, err := j.Begin(good)
	if err != nil || n.Entries[0].Phase != Intent {
		t.Fatal(n, err)
	}
	if again, e := n.Begin(good); e != nil || len(again.Entries) != 1 {
		t.Fatal("same request was duplicated")
	}
	changed := good
	changed.ConsentDigest = a
	if _, e := n.Begin(changed); e != ErrRefused {
		t.Fatalf("changed UUID payload: %v", e)
	}
	another := good
	another.OperationID = id2
	if _, e := n.Begin(another); e != ErrPending {
		t.Fatalf("unsettled owner lost: %v", e)
	}
	if _, e := n.Advance(id1, WithdrawIntent, receipt); e != ErrRefused {
		t.Fatalf("effect before prepare: %v", e)
	}
}
func TestEffectIntentsRequireExactAckAndCannotSkipOrRetry(t *testing.T) {
	j, _ := (Journal{Entries: []Entry{}}).Begin(good)
	steps := []Phase{Prepared, WithdrawIntent, WithdrawAcknowledged, SettingsIntent, SettingsAcknowledged, PublishIntent, PublishAcknowledged, CloseIntent, CloseAcknowledged}
	for _, p := range steps {
		if _, e := j.Advance(id1, Committed, receipt); e != ErrRefused {
			t.Fatalf("early commit %s: %v", p, e)
		}
		n, e := j.Advance(id1, p, receipt)
		if e != nil {
			t.Fatalf("step %s: %v", p, e)
		}
		j = n
	}
	if j.Unresolved() != true {
		t.Fatal("close ACK prematurely became approval")
	}
	if _, e := j.Advance(id1, CloseAcknowledged, receipt); e != ErrRefused {
		t.Fatal("repeated cleanup ACK")
	}
	j, e := j.Certify(id1, Committed, receipt)
	if e != nil || j.Unresolved() {
		t.Fatal("certificate", e)
	}
	if _, e = j.Certify(id1, Committed, receipt); e != ErrRefused {
		t.Fatal("double terminal")
	}
}
func TestKnownCancellationBeforeWithdrawalRequiresCleanupCertificate(t *testing.T) {
	j, _ := (Journal{Entries: []Entry{}}).Begin(good)
	if _, e := j.Certify(id1, Refused, Receipt{}); e != ErrRefused {
		t.Fatal("missing cleanup")
	}
	next, e := j.Certify(id1, Refused, receipt)
	if e != nil || next.Unresolved() {
		t.Fatal("known refusal", e)
	}
	j, _ = j.Advance(id1, Prepared, receipt)
	j, _ = j.Advance(id1, WithdrawIntent, receipt)
	if _, e = j.Certify(id1, Refused, receipt); e != ErrRefused {
		t.Fatal("post-intent refused")
	}
}
func TestDifferentBootRecoveryRetainsOriginalUnknown(t *testing.T) {
	j, _ := (Journal{Entries: []Entry{}}).Begin(good)
	next := good
	next.OperationID = id2
	next.RequestDigest = b
	next.BootUUID = boot2
	next.RecoveryParent = id1
	if _, e := j.Begin(next); e != nil {
		t.Fatal(e)
	}
	sameBoot := next
	sameBoot.BootUUID = boot1
	if _, e := j.Begin(sameBoot); e != ErrRefused {
		t.Fatal("same boot recovery", e)
	}
	j, _ = j.Begin(next)
	for _, p := range []Phase{Prepared, WithdrawIntent, WithdrawAcknowledged, SettingsIntent, SettingsAcknowledged, PublishIntent, PublishAcknowledged, CloseIntent, CloseAcknowledged} {
		var e error
		j, e = j.Advance(id2, p, receipt)
		if e != nil {
			t.Fatal(p, e)
		}
	}
	j, e := j.Certify(id2, Committed, receipt)
	if e != nil || j.Unresolved() {
		t.Fatal("discharge", e)
	}
	parent, _ := j.Find(id1)
	if parent.Phase != Intent || parent.DischargedBy != id2 {
		t.Fatal("historical outcome overwritten")
	}
	broken := j.Clone()
	broken.Entries[0].DischargedBy = "invalid"
	if broken.Valid() {
		t.Fatal("malformed discharge accepted")
	}
}
func TestCapacityAndMalformedJournal(t *testing.T) {
	j := Journal{Entries: []Entry{}}
	if _, e := j.Begin(Request{}); e != ErrRefused {
		t.Fatal("invalid intent")
	}
	j, _ = j.Begin(good)
	for _, p := range []Phase{Prepared, WithdrawIntent, WithdrawAcknowledged, SettingsIntent, SettingsAcknowledged, PublishIntent, PublishAcknowledged, CloseIntent, CloseAcknowledged} {
		j, _ = j.Advance(id1, p, receipt)
	}
	j, _ = j.Certify(id1, Committed, receipt)
	wrong := j.Clone()
	wrong.Entries[0].Certificate.Publication = Receipt{}
	if wrong.Valid() {
		t.Fatal("missing publication receipt accepted")
	}
	wrong = j.Clone()
	wrong.Entries[0].Phase = Intent
	if wrong.Valid() {
		t.Fatal("terminal certificate on intent accepted")
	}
}

func TestEffectAckMustNameOriginalIntentAndMayDifferInDigest(t *testing.T) {
	j, _ := (Journal{Entries: []Entry{}}).Begin(good)
	j, _ = j.Advance(id1, Prepared, receipt)
	j, _ = j.Advance(id1, WithdrawIntent, receipt)
	bad := Receipt{EffectID: "different", Digest: b}
	if _, e := j.Advance(id1, WithdrawAcknowledged, bad); e != ErrRefused {
		t.Fatalf("accepted foreign ACK: %v", e)
	}
	ack := Receipt{EffectID: receipt.EffectID, Digest: b}
	next, e := j.Advance(id1, WithdrawAcknowledged, ack)
	if e != nil || next.Entries[0].WithdrawAck.Digest != b || next.Entries[0].Withdraw.Digest != a {
		t.Fatalf("lost intent/ACK separation: %v", e)
	}
}

func TestStrictReaderRejectsFutureReceiptsAndParallelUnknown(t *testing.T) {
	base, _ := (Journal{Entries: []Entry{}}).Begin(good)
	future := base.Clone()
	future.Entries[0].PublicationAck = receipt
	if future.Valid() {
		t.Fatal("future publish ACK bypassed prior intents")
	}
	future = base.Clone()
	future.Entries[0].Native = receipt
	if future.Valid() {
		t.Fatal("native proof appeared before prepared")
	}
	second := good
	second.OperationID = id2
	second.RequestDigest = b
	concurrent := base.Clone()
	concurrent.Entries = append(concurrent.Entries, Entry{Request: second, Phase: Intent})
	if concurrent.Valid() {
		t.Fatal("two unrelated live operations accepted")
	}
}

func TestTransitionRootMustBeCanonicalAndNoControlCharacters(t *testing.T) {
	for _, root := range []string{"/Users//test", "/Users/../test", "/Users/./test", "/Users/test/", "/Users/\\test", "/Users/test\nsecret"} {
		req := good
		req.Root = root
		if ValidRequest(req) {
			t.Fatalf("accepted ambiguous root %q", root)
		}
	}
}

func TestStrictReaderRejectsMismatchedAckIdentities(t *testing.T) {
	j, _ := (Journal{Entries: []Entry{}}).Begin(good)
	for _, phase := range []Phase{Prepared, WithdrawIntent, WithdrawAcknowledged, SettingsIntent, SettingsAcknowledged, PublishIntent, PublishAcknowledged, CloseIntent, CloseAcknowledged} {
		var err error
		j, err = j.Advance(id1, phase, receipt)
		if err != nil {
			t.Fatal(err)
		}
		if phase == WithdrawAcknowledged || phase == SettingsAcknowledged || phase == PublishAcknowledged || phase == CloseAcknowledged {
			bad := j.Clone()
			switch phase {
			case WithdrawAcknowledged:
				bad.Entries[0].WithdrawAck.EffectID = "foreign"
			case SettingsAcknowledged:
				bad.Entries[0].SettingsAck.EffectID = "foreign"
			case PublishAcknowledged:
				bad.Entries[0].PublicationAck.EffectID = "foreign"
			case CloseAcknowledged:
				bad.Entries[0].CleanupAck.EffectID = "foreign"
			}
			if bad.Valid() {
				t.Errorf("accepted mismatched %s", phase)
			}
		}
	}
	j, _ = j.Certify(id1, Committed, receipt)
	j.Entries[0].WithdrawAck.EffectID = "foreign"
	if j.Valid() {
		t.Error("accepted mismatched committed withdrawal ACK")
	}
}
