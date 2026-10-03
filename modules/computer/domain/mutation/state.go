package mutation

import "github.com/legrch/farol/modules/computer/domain/authority"

type Identity struct {
	OperationID, OwnerID, SessionID, TaskID string
	TaskEpoch                               uint64
	ParticipantID                           string
}
type Binding struct {
	Identity                   Identity
	WorkspaceID, RequestDigest string
}
type Receipt struct {
	Operation    Kind
	RelativePath string
	Bytes        uint64
	Replacements uint32
	BeforeSHA256 *string
	AfterSHA256  string
}

func (r Receipt) Clone() Receipt { r.BeforeSHA256 = cloneHash(r.BeforeSHA256); return r }

type Failure struct{ Code, Source string }
type Phase string

const (
	Prepared       Phase = "prepared"
	Completed      Phase = "completed"
	Failed         Phase = "failed"
	OutcomeUnknown Phase = "outcome_unknown"
)

// State retains fingerprints and receipts only, never write/edit text. Its
// fields are private so a terminal record cannot be reopened or rebound.
type State struct {
	binding Binding
	phase   Phase
	receipt *Receipt
	failure *Failure
}

func (r State) Binding() Binding { return r.binding }
func (r State) Phase() Phase     { return r.phase }
func (r State) Receipt() *Receipt {
	if r.receipt == nil {
		return nil
	}
	copy := r.receipt.Clone()
	return &copy
}
func (r State) Failure() *Failure {
	if r.failure == nil {
		return nil
	}
	copy := *r.failure
	return &copy
}
func (r State) Clone() State { r.receipt = r.Receipt(); r.failure = r.Failure(); return r }
func validBinding(b Binding) bool {
	i := b.Identity
	return Identifier(i.OperationID, 160) && Identifier(i.OwnerID, 160) && Identifier(i.SessionID, 160) && Identifier(i.TaskID, 160) && i.TaskEpoch <= MaxSafeInteger && Identifier(i.ParticipantID, 160) && Identifier(b.WorkspaceID, 160) && SHA256(b.RequestDigest)
}

// Stored receipt policy matches the existing private journal schema. Native
// receipt correlation/operation constraints are checked separately.
func ValidStoredReceipt(r Receipt) bool {
	return (r.Operation == WriteKind || r.Operation == EditKind) && Identifier(r.RelativePath, 4096) && r.Bytes <= MaxBytes && r.Replacements <= MaxEdits && (r.BeforeSHA256 == nil || SHA256(*r.BeforeSHA256)) && SHA256(r.AfterSHA256)
}
func ValidNativeReceipt(r Receipt, op Operation) bool {
	if ValidateNative(op) != nil || !ValidStoredReceipt(r) || r.RelativePath != op.Path() || r.Operation != op.Kind() {
		return false
	}
	return r.Operation == WriteKind && r.Replacements == 0 || r.Operation == EditKind && r.Replacements >= 1
}
func NewPrepared(b Binding) (*State, error) { return Restore(b, Prepared, nil, nil) }

// Restore validates the existing content-free journal shape, not authority.
func Restore(b Binding, phase Phase, receipt *Receipt, failure *Failure) (*State, error) {
	valid := validBinding(b)
	switch phase {
	case Prepared:
		valid = valid && receipt == nil && failure == nil
	case Completed:
		valid = valid && receipt != nil && failure == nil && ValidStoredReceipt(*receipt)
	case Failed:
		valid = valid && receipt == nil && failure != nil && validFailure(*failure, false)
	case OutcomeUnknown:
		valid = valid && receipt == nil && failure != nil && validFailure(*failure, true)
	default:
		valid = false
	}
	if !valid {
		return nil, stateError("WORKSPACE_MUTATION_STATE_INVALID")
	}
	r := State{binding: b, phase: phase, receipt: receipt, failure: failure}
	copy := r.Clone()
	return &copy, nil
}
func (r State) Complete(receipt Receipt) (*State, error) {
	next, err := Restore(r.binding, Completed, &receipt, nil)
	if err != nil {
		return nil, err
	}
	return r.Apply(*next)
}
func (r State) Refuse(f Failure) (*State, error) {
	phase := Failed
	if f.Code == "WORKSPACE_MUTATION_OUTCOME_UNKNOWN" {
		phase = OutcomeUnknown
	}
	next, err := Restore(r.binding, phase, nil, &f)
	if err != nil {
		return nil, err
	}
	return r.Apply(*next)
}
func (r State) Apply(next State) (*State, error) {
	if _, err := Restore(r.binding, r.phase, r.receipt, r.failure); err != nil {
		return nil, err
	}
	if _, err := Restore(next.binding, next.phase, next.receipt, next.failure); err != nil {
		return nil, err
	}
	if r.binding != next.binding {
		return nil, stateError("WORKSPACE_MUTATION_BINDING_MISMATCH")
	}
	if equalState(r, next) {
		copy := r.Clone()
		return &copy, nil
	}
	if r.phase != Prepared || next.phase == Prepared {
		return nil, stateError("WORKSPACE_MUTATION_TERMINAL_IMMUTABLE")
	}
	copy := next.Clone()
	return &copy, nil
}
func equalState(a, b State) bool {
	if a.binding != b.binding || a.phase != b.phase {
		return false
	}
	if a.receipt == nil || b.receipt == nil {
		if a.receipt != nil || b.receipt != nil {
			return false
		}
	} else {
		x, y := *a.receipt, *b.receipt
		if !sameHash(x.BeforeSHA256, y.BeforeSHA256) {
			return false
		}
		x.BeforeSHA256, y.BeforeSHA256 = nil, nil
		if x != y {
			return false
		}
	}
	return a.failure == nil && b.failure == nil || a.failure != nil && b.failure != nil && *a.failure == *b.failure
}

// Recover returns only an existing result or an interrupted-preparation unknown
// tombstone. There is deliberately no "execute again" recovery state.
type Recovery interface{ recovery() }
type CompletedRecovery struct{ Receipt Receipt }
type FailedRecovery struct{ Failure Failure }
type InterruptedRecovery struct{ Tombstone State }

func (CompletedRecovery) recovery()   {}
func (FailedRecovery) recovery()      {}
func (InterruptedRecovery) recovery() {}
func (r State) Recover(expected Binding) (Recovery, error) {
	if _, err := Restore(r.binding, r.phase, r.receipt, r.failure); err != nil {
		return nil, err
	}
	if r.binding != expected {
		return nil, authority.Fail("COMPUTER_MUTATION_OPERATION_CONFLICT", "operation-store")
	}
	switch r.phase {
	case Completed:
		return CompletedRecovery{Receipt: *r.Receipt()}, nil
	case Failed, OutcomeUnknown:
		return FailedRecovery{Failure: *r.Failure()}, nil
	case Prepared:
		tombstone, err := r.Refuse(Failure{Code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", Source: "operation-store"})
		if err != nil {
			return nil, err
		}
		return InterruptedRecovery{Tombstone: *tombstone}, nil
	}
	return nil, stateError("WORKSPACE_MUTATION_STATE_INVALID")
}

// StateError is internal repository policy. A future app maps storage errors to
// COMPUTER_MUTATION_STORE_UNAVAILABLE; raw diagnostics never cross contracts.
type StateError struct{ Code string }

func (e *StateError) Error() string { return e.Code }
func stateError(code string) error  { return &StateError{Code: code} }
