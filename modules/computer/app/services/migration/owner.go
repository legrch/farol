// Package transition coordinates one Go-owned continuity source proposal.
// It publishes no Computer approval and registers no desktop/RPC method.
// Existing Computer authority remains fenced by the access WAL on uncertainty.
package migration

import (
	"context"
	"errors"
	"strconv"

	"github.com/legrch/farol/modules/computer/app/port"
	leaseport "github.com/legrch/farol/modules/computer/app/port/lease"
	observationport "github.com/legrch/farol/modules/computer/app/port/observation"
	journal "github.com/legrch/farol/modules/computer/domain/journal"
	observation "github.com/legrch/farol/modules/computer/domain/observation"
)

// JournalStore is implemented by the existing protected Go access owner. The
// same Store mutex and lifetime lock serialize its initial intent and receipts.
type JournalStore interface {
	BeginTransition(context.Context, journal.Request) (journal.Entry, bool, error)
	AdvanceTransition(context.Context, string, journal.Phase, journal.Receipt) error
	CertifyTransition(context.Context, string, journal.Phase, journal.Receipt) error
}

// BootUUID is a trusted native scalar read, before ANY operation-owned
// workspace/anchor descriptors. It is not supplied by a caller/renderer.
type BootUUID interface {
	Current(context.Context) (string, error)
}

// The separately owned connector drain AND stopped-state Settings publication
// must both be known complete before Begin. Unknown never selects a new owner.
type Prerequisite interface{ Completed(context.Context) bool }

type Mode string

const (
	Legacy Mode = "legacy-confirm"
	Rebind Mode = "enrolled-rebind"
)

type Selection struct {
	Request journal.Request
	Mode    Mode
	Saved   observation.Saved
}

type BeginResult struct {
	OperationID string
	Admitted    bool
	PriorPhase  journal.Phase
}

type held struct {
	id             string
	root           string
	mode           Mode
	saved          observation.Saved
	anchor         leaseport.Anchor
	candidate      observationport.HeldObservation
	phase          journal.Phase
	closeAttempted bool
}

type Owner struct {
	mu           port.MigrationGate
	digester     port.ObservationDigester
	store        JournalStore
	boot         BootUUID
	prerequisite Prerequisite
	anchor       leaseport.Acquirer
	candidate    observationport.Holder
	active       *held
	poisoned     bool
}

func New(store JournalStore, boot BootUUID, prerequisite Prerequisite, anchor leaseport.Acquirer, candidate observationport.Holder, gate port.MigrationGate, digester port.ObservationDigester) *Owner {
	return &Owner{mu: gate, digester: digester, store: store, boot: boot, prerequisite: prerequisite, anchor: anchor, candidate: candidate}
}

// Begin captures the trusted boot and CONFIRMS the first WAL intent before
// acquiring any C1/C3 native handles. A duplicate never reacquires them.
func (o *Owner) Begin(ctx context.Context, selection Selection) (BeginResult, error) {
	if ctx == nil || ctx.Err() != nil || o.store == nil || o.boot == nil || o.prerequisite == nil ||
		o.anchor == nil || o.candidate == nil || o.mu == nil || o.digester == nil || (selection.Mode != Legacy && selection.Mode != Rebind) {
		return BeginResult{}, journal.ErrRefused
	}
	// Independent drain/stopped-state owner and native boot scalar are observed
	// BEFORE taking this Go coordinator mutex. Never call back to TS while a Go
	// native/access lock is held; the protected WAL admission serializes the
	// original operation after these prerequisites have been acknowledged.
	if !o.prerequisite.Completed(ctx) {
		return BeginResult{}, journal.ErrRefused
	}
	boot, err := o.boot.Current(ctx)
	if err != nil || ctx.Err() != nil {
		return BeginResult{}, journal.ErrRefused
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.poisoned || o.active != nil || ctx.Err() != nil {
		return BeginResult{}, journal.ErrRefused
	}
	req := selection.Request
	// No caller-supplied boot observation survives trusted composition.
	req.BootUUID = boot
	if selection.Saved.Binding.Path != req.Root {
		return BeginResult{}, journal.ErrRefused
	}
	if selection.Mode == Rebind {
		if observation.Preflight(selection.Saved, observation.Settled) != "" {
			return BeginResult{}, journal.ErrRefused
		}
	} else if selection.Saved.Evidence != nil {
		return BeginResult{}, journal.ErrRefused
	}
	existing, admitted, err := o.store.BeginTransition(ctx, req)
	if err != nil {
		return BeginResult{}, err
	}
	result := BeginResult{OperationID: req.OperationID, Admitted: admitted, PriorPhase: existing.Phase}
	if !admitted {
		return result, nil
	}
	// The original intent is durable. From here, missing close evidence is an
	// existing-operation UNKNOWN, not permission to mint a fresh attempt.
	anchor, err := o.anchor.Acquire(ctx)
	if err != nil {
		o.poisoned = true
		return result, err
	}
	observed, err := o.candidate.Hold(ctx, req.Root)
	if err != nil {
		if closeErr := anchor.Close(); closeErr != nil {
			o.poisoned = true
			return result, closeErr
		}
		o.poisoned = true // No persisted cleanup receipt: intentionally restricted.
		return result, err
	}
	o.active = &held{id: req.OperationID, root: req.Root, mode: selection.Mode, saved: selection.Saved, anchor: anchor, candidate: observed, phase: journal.Intent}
	return result, nil
}

// Confirm checks the current startup Data instance and the ORIGINAL retained
// directory chain. Legacy requires a separate native picker confirmation whose
// fixed original root and operation ID are identical. It never trusts an inode.
func (o *Owner) Confirm(ctx context.Context, operationID, selectedRoot string, ownerPicked bool) (observation.Observation, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	a := o.active
	if o.poisoned || a == nil || a.id != operationID || ctx == nil || ctx.Err() != nil || a.phase != journal.Intent {
		return observation.Observation{}, journal.ErrRefused
	}
	if a.mode == Legacy && (!ownerPicked || selectedRoot != a.root) {
		return observation.Observation{}, journal.ErrRefused
	}
	if a.mode == Rebind && ownerPicked {
		return observation.Observation{}, journal.ErrRefused
	}
	if err := a.anchor.Requalify(ctx); err != nil {
		o.poisoned = true
		return observation.Observation{}, err
	}
	if err := a.candidate.Requalify(ctx); err != nil {
		o.poisoned = true
		return observation.Observation{}, err
	}
	candidate, err := a.anchor.Check(ctx, a.root)
	if err != nil || candidate.Kind != "current-data-candidate" || candidate.Authority != "not-established" || candidate.Path != a.root {
		o.poisoned = true
		return observation.Observation{}, journal.ErrRefused
	}
	measured, err := a.candidate.Snapshot()
	if err != nil || !measured.Valid() || measured.Binding.Path != a.root {
		o.poisoned = true
		return observation.Observation{}, journal.ErrRefused
	}
	device, e1 := strconv.ParseUint(measured.Binding.Device, 10, 64)
	inode, e2 := strconv.ParseUint(measured.Binding.Inode, 10, 64)
	if e1 != nil || e2 != nil || device != candidate.Device || inode != candidate.Inode {
		o.poisoned = true
		return observation.Observation{}, journal.ErrRefused
	}
	if a.mode == Rebind {
		assessment := observation.Compare(a.saved, measured, observation.Settled)
		if assessment != observation.SameMountCandidate && assessment != observation.RemountCandidate {
			o.poisoned = true
			return observation.Observation{}, journal.ErrRefused
		}
	}
	digest, err := o.digester.Digest(measured)
	if err != nil {
		return observation.Observation{}, journal.ErrRefused
	}
	proof := journal.Receipt{EffectID: a.id, Digest: digest}
	if err = o.store.AdvanceTransition(ctx, a.id, journal.Prepared, proof); err != nil {
		o.poisoned = true
		return observation.Observation{}, err
	}
	a.phase = journal.Prepared
	return measured, nil
}

// Record persists the NEXT original-operation effect intent or ACK. The caller
// performs its effect only AFTER a returned intent, and never asks Go to call
// back into TS while any Go access/activation mutex is held.
func (o *Owner) Record(ctx context.Context, id string, phase journal.Phase, receipt journal.Receipt) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	a := o.active
	if o.poisoned || a == nil || a.id != id || ctx == nil || ctx.Err() != nil || phase == journal.CloseAcknowledged {
		return journal.ErrRefused
	}
	if err := a.anchor.Requalify(ctx); err != nil {
		o.poisoned = true
		return err
	}
	if err := a.candidate.Requalify(ctx); err != nil {
		o.poisoned = true
		return err
	}
	if err := o.store.AdvanceTransition(ctx, id, phase, receipt); err != nil {
		o.poisoned = true
		return err
	}
	a.phase = phase
	return nil
}

func (o *Owner) Finish(ctx context.Context, id string, kind journal.Phase, cleanup journal.Receipt) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	a := o.active
	if o.poisoned || a == nil || a.id != id || ctx == nil || ctx.Err() != nil || a.closeAttempted {
		return journal.ErrRefused
	}
	if kind == journal.Committed && a.phase != journal.CloseIntent {
		return journal.ErrRefused
	}
	if kind == journal.Refused && a.phase != journal.Intent && a.phase != journal.Prepared {
		return journal.ErrRefused
	}
	// The close-intent phase is already durable for COMMITTED. An early known
	// refusal has no covered withdrawal effect and must still observe cleanup.
	a.closeAttempted = true
	var failures error
	if err := a.candidate.Close(); err != nil {
		failures = errors.Join(failures, err)
	}
	if err := a.anchor.Close(); err != nil {
		failures = errors.Join(failures, err)
	}
	if failures != nil {
		o.poisoned = true
		return failures
	}
	if kind == journal.Committed {
		// Native close is a one-shot effect. Retain its ACK only after both
		// owners confirmed Close; a lost journal write leaves the original
		// close_intent pending and never permits numeric-fd replay.
		if err := o.store.AdvanceTransition(ctx, id, journal.CloseAcknowledged, cleanup); err != nil {
			o.poisoned = true
			return err
		}
		a.phase = journal.CloseAcknowledged
	}
	if err := o.store.CertifyTransition(ctx, id, kind, cleanup); err != nil {
		o.poisoned = true
		return err
	}
	o.active = nil
	return nil
}
