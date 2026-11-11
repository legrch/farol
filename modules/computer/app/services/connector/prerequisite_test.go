package connector

import (
	"context"
	"errors"
	"strings"
	"testing"

	journal "github.com/legrch/farol/modules/computer/domain/journal"
)

const stopTestParent = "11111111-1111-4111-8111-111111111111"
const stopTestBoot = "22222222-2222-4222-8222-222222222222"
const stopTestEffect = "33333333-3333-4333-8333-333333333333"

type originalStopRepository struct {
	ledger           journal.StopLedger
	begins, advances int
	unknown          bool
}

func (r *originalStopRepository) BeginStop(_ context.Context, req journal.StopRequest) (journal.StopEntry, bool, error) {
	r.begins++
	if r.unknown {
		return journal.StopEntry{}, false, journal.ErrStopUnknown
	}
	next, first, err := r.ledger.Begin(req)
	if err != nil {
		return journal.StopEntry{}, false, err
	}
	r.ledger = next
	entry, _ := next.Find(req.OperationID)
	return entry, first, nil
}
func (r *originalStopRepository) AdvanceStop(_ context.Context, id string, next journal.StopEntry) error {
	r.advances++
	if r.unknown {
		return journal.ErrStopUnknown
	}
	updated, err := r.ledger.Update(id, next)
	if err == nil {
		r.ledger = updated
	}
	return err
}
func (r *originalStopRepository) ObserveOriginalStop(_ context.Context, id string) (journal.StopEntry, error) {
	entry, ok := r.ledger.Find(id)
	if !ok {
		return journal.StopEntry{}, journal.ErrStopRefused
	}
	return entry, nil
}
func (r *originalStopRepository) ObserveStopLedger(context.Context) (journal.StopLedger, error) {
	return r.ledger.Clone(), nil
}
func (r *originalStopRepository) RefuseStopBeforeDispatch(_ context.Context, id string) error {
	entry, ok := r.ledger.Find(id)
	if !ok || entry.Phase != journal.StopAdmissionIntent {
		return journal.ErrStopRefused
	}
	entry.Phase = journal.StopRefusedBeforeDispatch
	entry.Refusal = "cancelled_before_dispatch"
	updated, err := r.ledger.Update(id, entry)
	if err == nil {
		r.ledger = updated
	}
	return err
}

type originalStopBoot struct{}

func (originalStopBoot) Current(context.Context) (string, error) { return stopTestBoot, nil }

type originalStopConnector struct {
	verifyCalls int
	verified    bool
}

func (c *originalStopConnector) CurrentStopBinding(context.Context) (StopConnectorBinding, error) {
	return StopConnectorBinding{
		BuildID: strings.Repeat("a", 64), BackendGeneration: "backend",
		RuntimeID: "runtime", ConnectorGeneration: "5",
	}, nil
}
func (c *originalStopConnector) VerifyOriginalClose(_ context.Context, parent, op, digest, backend, runtime string) error {
	c.verifyCalls++
	if !c.verified || parent != stopTestParent || op != "44444444-4444-4444-8444-444444444444" ||
		digest != strings.Repeat("f", 64) || backend != "backend" || runtime != "runtime" {
		return journal.ErrStopRefused
	}
	return nil
}
func originalStopSelection() journal.StopRequest {
	return journal.StopRequest{
		OperationID:   stopTestParent,
		RequestDigest: strings.Repeat("b", 64),
		CommandDigest: strings.Repeat("c", 64),
		CommandKind:   "computer.update-access", Purpose: "workspace-change",
		WorkspaceID: "workspace", Root: "/Users/example/approved",
		ConsentDigest:    strings.Repeat("d", 64),
		ExpectedRevision: "3", ComputerGeneration: "4", ConnectorGeneration: "99",
		SettingsDigest:   strings.Repeat("e", 64),
		StopEffectID:     stopTestEffect,
		SettingsEffectID: "55555555-5555-4555-8555-555555555555",
		CleanupEffectID:  "66666666-6666-4666-8666-666666666666",
	}
}
func originalStopService() (*OriginalStopOwner, *originalStopRepository, *originalStopConnector) {
	r := &originalStopRepository{ledger: journal.StopLedger{Entries: []journal.StopEntry{}}}
	c := &originalStopConnector{verified: true}
	owner := NewOriginalStopOwner(r, originalStopBoot{}, c, StopScope{
		ProfileID: "profile", OwnerID: "owner", ComputerID: "computer",
		BackendGeneration: "backend", HostLifetimeID: "host",
	})
	return owner, r, c
}

func TestOriginalStopOwnerDurablyAdmitsOriginalEffectBeforeNativeDispatch(t *testing.T) {
	owner, store, _ := originalStopService()
	entry, first, err := owner.Begin(context.Background(), originalStopSelection())
	if err != nil || !first || entry.Phase != journal.StopEffectIntent ||
		entry.Request.BootUUID != stopTestBoot ||
		entry.Request.ConnectorGeneration != "5" ||
		entry.Request.RuntimeID != "runtime" ||
		entry.Request.BackendGeneration != "backend" ||
		entry.Request.HostLifetimeID != "host" ||
		store.begins != 1 || store.advances != 1 {
		t.Fatal("trusted Go Stop intent not admitted before effect", err)
	}
	repeated, first, err := owner.Begin(context.Background(), originalStopSelection())
	if err != nil || first || repeated.Phase != journal.StopEffectIntent ||
		store.advances != 1 {
		t.Fatal("duplicate original was granted a second effect", err)
	}
}

func TestOriginalStopOwnerUnknownFirstIntentCannotDispatchStop(t *testing.T) {
	owner, store, _ := originalStopService()
	store.unknown = true
	_, first, err := owner.Begin(context.Background(), originalStopSelection())
	if !errors.Is(err, journal.ErrStopUnknown) || first || store.advances != 0 {
		t.Fatal("unknown admission was treated as Stop permit", err)
	}
}

func TestOriginalStopOwnerRequiresOriginalGoConnectorClosureReceipt(t *testing.T) {
	owner, store, connector := originalStopService()
	first, allowed, err := owner.Begin(context.Background(), originalStopSelection())
	if err != nil || !allowed {
		t.Fatal(err)
	}
	closure := &journal.StopClosure{
		EffectID:          first.Request.StopEffectID,
		BackendGeneration: first.Request.BackendGeneration,
		RuntimeID:         first.Request.RuntimeID,
		LifecycleID:       "77777777-7777-4777-8777-777777777777",
		StopRevision:      "1", PreparationRevision: "0",
		ClosureOperationID: "44444444-4444-4444-8444-444444444444",
		ClosureDigest:      strings.Repeat("f", 64),
	}
	connector.verified = false
	if _, err := owner.Advance(context.Background(), stopTestParent, journal.StopAcknowledged, closure, nil, nil, nil); err == nil {
		t.Fatal("unverified connector close became durable Stop ACK")
	}
	if store.advances != 1 {
		t.Fatal("refused closure touched original ledger")
	}
	connector.verified = true
	bad := *closure
	bad.RuntimeID = "foreign"
	if _, err := owner.Advance(context.Background(), stopTestParent, journal.StopAcknowledged, &bad, nil, nil, nil); err == nil {
		t.Fatal("crossed runtime became original Stop ACK")
	}
	verified, err := owner.Advance(context.Background(), stopTestParent, journal.StopAcknowledged, closure, nil, nil, nil)
	if err != nil || verified.Phase != journal.StopAcknowledged ||
		connector.verifyCalls != 3 {
		t.Fatal("original positive close not recorded", err)
	}
	if _, err := owner.Advance(context.Background(), stopTestParent, journal.StopAcknowledged, closure, nil, nil, nil); err == nil {
		t.Fatal("duplicate positive ACK replayed phase")
	}
}

func TestOriginalStopOwnerRefusesUnknownSettingsWithoutTerminalCertificate(t *testing.T) {
	owner, store, _ := originalStopService()
	first, allowed, err := owner.Begin(context.Background(), originalStopSelection())
	if err != nil || !allowed {
		t.Fatal(err)
	}
	closure := &journal.StopClosure{
		EffectID:          first.Request.StopEffectID,
		BackendGeneration: first.Request.BackendGeneration,
		RuntimeID:         first.Request.RuntimeID,
		LifecycleID:       "77777777-7777-4777-8777-777777777777",
		StopRevision:      "1", PreparationRevision: "0",
		ClosureOperationID: "44444444-4444-4444-8444-444444444444",
		ClosureDigest:      strings.Repeat("f", 64),
	}
	if _, err := owner.Advance(context.Background(), stopTestParent, journal.StopAcknowledged, closure, nil, nil, nil); err != nil {
		t.Fatal(err)
	}
	plan := &journal.StopSettingsPlan{
		EffectID:         first.Request.SettingsEffectID,
		ExpectedRevision: first.Request.ExpectedRevision,
		ExpectedDigest:   first.Request.SettingsDigest,
		NextRevision:     "4", NextDigest: strings.Repeat("1", 64),
		ComputerGeneration:  first.Request.ComputerGeneration,
		ConnectorGeneration: first.Request.ConnectorGeneration,
		ConsentDigest:       first.Request.ConsentDigest,
	}
	if _, err := owner.Advance(context.Background(), stopTestParent, journal.StoppedSettingsIntent, nil, plan, nil, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Advance(context.Background(), stopTestParent, journal.StopComplete, nil, nil, nil, nil); err == nil {
		t.Fatal("missing Settings original ACK and cleanup became certificate")
	}
	if store.ledger.Entries[0].Phase != journal.StoppedSettingsIntent || !store.ledger.Pending() {
		t.Fatal("unknown Settings was silently settled")
	}
}

func TestOriginalCleanupAndTerminalRequireFreshGoConnectorClosureWitness(t *testing.T) {
	owner, store, connector := originalStopService()
	ctx := context.Background()
	entry, allowed, err := owner.Begin(ctx, originalStopSelection())
	if err != nil || !allowed {
		t.Fatal(err)
	}
	closure := &journal.StopClosure{
		EffectID:          entry.Request.StopEffectID,
		BackendGeneration: entry.Request.BackendGeneration,
		RuntimeID:         entry.Request.RuntimeID,
		LifecycleID:       "77777777-7777-4777-8777-777777777777",
		StopRevision:      "1", PreparationRevision: "0",
		ClosureOperationID: "44444444-4444-4444-8444-444444444444",
		ClosureDigest:      strings.Repeat("f", 64),
	}
	if _, err := owner.Advance(ctx, stopTestParent, journal.StopAcknowledged, closure, nil, nil, nil); err != nil {
		t.Fatal(err)
	}
	plan := &journal.StopSettingsPlan{
		EffectID:         entry.Request.SettingsEffectID,
		ExpectedRevision: entry.Request.ExpectedRevision,
		ExpectedDigest:   entry.Request.SettingsDigest,
		NextRevision:     "4", NextDigest: strings.Repeat("1", 64),
		ComputerGeneration:  entry.Request.ComputerGeneration,
		ConnectorGeneration: entry.Request.ConnectorGeneration,
		ConsentDigest:       entry.Request.ConsentDigest,
	}
	if _, err := owner.Advance(ctx, stopTestParent, journal.StoppedSettingsIntent, nil, plan, nil, nil); err != nil {
		t.Fatal(err)
	}
	ack := &journal.StopSettingsReceipt{
		EffectID: plan.EffectID, Revision: plan.NextRevision,
		DocumentDigest: plan.NextDigest, ComputerGeneration: plan.ComputerGeneration,
		ConnectorGeneration: plan.ConnectorGeneration, ConsentDigest: plan.ConsentDigest,
	}
	if _, err := owner.Advance(ctx, stopTestParent, journal.StoppedSettingsAcknowledged, nil, nil, ack, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Advance(ctx, stopTestParent, journal.StopCleanupIntent, nil, nil, nil, nil); err != nil {
		t.Fatal(err)
	}
	cleanup := &journal.StopCleanupReceipt{
		EffectID:          entry.Request.CleanupEffectID,
		BackendGeneration: entry.Request.BackendGeneration,
		RuntimeID:         entry.Request.RuntimeID, Digest: strings.Repeat("9", 64),
	}
	connector.verified = false
	if _, err := owner.Advance(ctx, stopTestParent, journal.StopCleanupAcknowledged, nil, nil, nil, cleanup); err == nil {
		t.Fatal("TS cleanup claimed a Go-absent original closure")
	}
	if store.ledger.Entries[0].Phase != journal.StopCleanupIntent {
		t.Fatal("unverified cleanup changed protected phase")
	}
	connector.verified = true
	if _, err := owner.Advance(ctx, stopTestParent, journal.StopCleanupAcknowledged, nil, nil, nil, cleanup); err != nil {
		t.Fatal("matching original Go closure should allow original cleanup readback", err)
	}
	connector.verified = false
	if _, err := owner.Advance(ctx, stopTestParent, journal.StopComplete, nil, nil, nil, nil); err == nil {
		t.Fatal("terminal certificate did not independently requalify Go closure")
	}
	if store.ledger.Entries[0].Phase != journal.StopCleanupAcknowledged {
		t.Fatal("unconfirmed terminal altered historical custody")
	}
	connector.verified = true
	if terminal, err := owner.Advance(ctx, stopTestParent, journal.StopComplete, nil, nil, nil, nil); err != nil ||
		terminal.Phase != journal.StopComplete || connector.verifyCalls < 4 {
		t.Fatal("known cleanup and original Go closure failed terminal", err)
	}
}
