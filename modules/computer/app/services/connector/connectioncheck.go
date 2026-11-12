package connector

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"

	check "github.com/legrch/farol/modules/computer/domain/connector"
)

// Existing Access Store owns durable attempts. This pure app service selects the
// original scope and sequences ONLY short Go calls. It has no browser or
// filesystem implementation and cannot Send while an owner lock is held.
type ConnectionCheckStore interface {
	ClaimConnectionCheck(context.Context, check.Request) (check.Entry, bool, error)
	PrepareConnectionCheck(context.Context, string, check.Scope) (check.Entry, string, error)
	AdvanceConnectionCheck(context.Context, string, check.Phase, *check.Receipt) (check.Entry, bool, error)
	CheckStatus(context.Context, string) (check.Entry, bool, error)
	CheckPending(context.Context) (bool, error)
}

type ConnectionCheckBinding struct {
	BuildID, BackendGeneration, RuntimeID, ConnectorGeneration, ComputerGeneration, ChallengeDigest string
	ProofDigest, ProofWorkspaceID                                                                   string
	ProofCurrent                                                                                    bool
}
type ConnectionCheckNative interface {
	CurrentConnectionCheck(context.Context) (ConnectionCheckBinding, error)
	ArmOriginalStatusCheck(context.Context, string, string, check.Scope) error
	ConfirmOriginalConnectionCheck(context.Context, string, check.Scope) (string, error)
	RetireOriginalConnectionCheck(context.Context, string, check.Scope) error
}

// Only trusted host main may propose the exact selected app and original
// challenge/attachment. The Go connector independently supplies runtime, proof
// and challenge identity. The renderer cannot choose mode or a status nonce.
type ConnectionCheckSelection struct {
	Mode               check.Mode `json:"mode"`
	AppName            string     `json:"appName"`
	Model              string     `json:"model"`
	TunnelID           string     `json:"tunnelId"`
	WorkspaceID        string     `json:"workspaceId"`
	Challenge          string     `json:"challenge"`
	ChallengeDigest    string     `json:"challengeDigest"`
	AttachmentDigest   string     `json:"attachmentDigest"`
	ComputerGeneration string     `json:"computerGeneration"`
	DocumentDigest     string     `json:"documentDigest"`
}
type ConnectionCheckScope struct {
	ProfileID, OwnerID, ComputerID string
}
type ConnectionCheckOwner struct {
	store  ConnectionCheckStore
	native ConnectionCheckNative
	scope  ConnectionCheckScope
}

func NewConnectionCheckOwner(store ConnectionCheckStore, native ConnectionCheckNative, scope ConnectionCheckScope) *ConnectionCheckOwner {
	return &ConnectionCheckOwner{store: store, native: native, scope: scope}
}
func (o *ConnectionCheckOwner) valid() bool {
	return o != nil && o.store != nil && o.native != nil && o.scope.ProfileID != "" &&
		o.scope.OwnerID != "" && o.scope.ComputerID != ""
}
func (o *ConnectionCheckOwner) Claim(ctx context.Context, id, fingerprint string) (check.Entry, bool, error) {
	if !o.valid() || ctx == nil || ctx.Err() != nil {
		return check.Entry{}, false, check.ErrRefused
	}
	return o.store.ClaimConnectionCheck(ctx, check.Request{
		OperationID: id, Fingerprint: fingerprint, ProfileID: o.scope.ProfileID,
		OwnerID: o.scope.OwnerID, ComputerID: o.scope.ComputerID,
	})
}
func (o *ConnectionCheckOwner) Observe(ctx context.Context, id string) (check.Entry, error) {
	if !o.valid() || ctx == nil || ctx.Err() != nil {
		return check.Entry{}, check.ErrRefused
	}
	e, ok, err := o.store.CheckStatus(ctx, id)
	if err != nil {
		return check.Entry{}, err
	}
	if !ok {
		return check.Entry{}, check.ErrRefused
	}
	return e, nil
}

// Prepare is called only after the browser document/draft/selection preflight.
// It does not arm or dispatch anything. The exact prompt and fresh status check
// nonce are produced by Go, stored with their digest and returned unchanged.
func (o *ConnectionCheckOwner) Prepare(ctx context.Context, id string, selected ConnectionCheckSelection) (check.Entry, string, error) {
	if !o.valid() || ctx == nil || ctx.Err() != nil {
		return check.Entry{}, "", check.ErrRefused
	}
	existing, err := o.Observe(ctx, id)
	if err != nil || existing.Phase != check.Claimed {
		return check.Entry{}, "", check.ErrRefused
	}
	current, err := o.native.CurrentConnectionCheck(ctx)
	if err != nil || ctx.Err() != nil {
		return check.Entry{}, "", check.ErrRefused
	}
	if selected.ChallengeDigest != current.ChallengeDigest ||
		selected.ComputerGeneration == "" || selected.ComputerGeneration != current.ComputerGeneration || selected.AppName == "" ||
		len(selected.DocumentDigest) != 64 ||
		selected.Model != "temporary-instant" ||
		selected.TunnelID == "" {
		return check.Entry{}, "", check.ErrRefused
	}
	switch selected.Mode {
	case check.Status:
		if !current.ProofCurrent || current.ProofDigest == "" ||
			(selected.AttachmentDigest != "" && selected.AttachmentDigest != current.ProofDigest) ||
			selected.Challenge != "" ||
			selected.WorkspaceID != current.ProofWorkspaceID {
			return check.Entry{}, "", check.ErrRefused
		}
		// Never take the current Go proof digest from Settings or renderer.
		// The exact original native verifier is the source of this field.
		selected.AttachmentDigest = current.ProofDigest
	case check.Bootstrap:
		if current.ProofCurrent || selected.AttachmentDigest != "" ||
			selected.Challenge == "" {
			return check.Entry{}, "", check.ErrRefused
		}
		h := sha256.Sum256([]byte(selected.Challenge))
		if hex.EncodeToString(h[:]) != current.ChallengeDigest {
			return check.Entry{}, "", check.ErrRefused
		}
	default:
		return check.Entry{}, "", check.ErrRefused
	}
	original := struct {
		Request  check.Request            `json:"request"`
		Selected ConnectionCheckSelection `json:"selected"`
		Native   ConnectionCheckBinding   `json:"native"`
	}{existing.Request, selected, current}
	raw, err := json.Marshal(original)
	if err != nil {
		return check.Entry{}, "", check.ErrRefused
	}
	sum := sha256.Sum256(raw)
	return o.store.PrepareConnectionCheck(ctx, id, check.Scope{
		Mode:        selected.Mode,
		ScopeDigest: hex.EncodeToString(sum[:]),
		BuildID:     current.BuildID, BackendGeneration: current.BackendGeneration,
		RuntimeID: current.RuntimeID, ConnectorGeneration: current.ConnectorGeneration,
		ComputerGeneration: selected.ComputerGeneration,
		TunnelID:           selected.TunnelID, AppName: selected.AppName, Model: selected.Model,
		WorkspaceID: selected.WorkspaceID, ChallengeDigest: current.ChallengeDigest,
		Challenge: selected.Challenge, AttachmentDigest: selected.AttachmentDigest,
		DocumentDigest: selected.DocumentDigest,
	})
}

// Arm publishes the one original dispatch intent BEFORE permitting browser
// activation. Go owns the active checkId and arms only the matching live slot.
// A failed status arm after WAL intent leaves UNKNOWN, never a second dispatch.
func (o *ConnectionCheckOwner) Arm(ctx context.Context, id string) (check.Entry, error) {
	if !o.valid() || ctx == nil || ctx.Err() != nil {
		return check.Entry{}, check.ErrRefused
	}
	e, first, err := o.store.AdvanceConnectionCheck(ctx, id, check.DispatchIntent, nil)
	if err != nil || !first {
		return check.Entry{}, check.ErrUnknown
	}
	if e.Scope == nil {
		return check.Entry{}, check.ErrUnknown
	}
	// Both modes bind the original Go slot. Bootstrap has no status nonce;
	// its sealed challenge/verification fuse remains a distinct prerequisite.
	if err = o.native.ArmOriginalStatusCheck(ctx, id, e.Scope.CheckID, *e.Scope); err != nil {
		return check.Entry{}, check.ErrUnknown
	}
	if ctx.Err() != nil {
		return check.Entry{}, check.ErrUnknown
	}
	return e, nil
}
func (o *ConnectionCheckOwner) RetainSend(ctx context.Context, id string, knownSend bool) (check.Entry, error) {
	if !o.valid() || ctx == nil || ctx.Err() != nil {
		return check.Entry{}, check.ErrRefused
	}
	phase := check.OutcomeUnknown
	if knownSend {
		phase = check.SendAcknowledged
	}
	e, _, err := o.store.AdvanceConnectionCheck(ctx, id, phase, nil)
	return e, err
}
func (o *ConnectionCheckOwner) RefuseBeforeDispatch(ctx context.Context, id string) (check.Entry, error) {
	if !o.valid() || ctx == nil || ctx.Err() != nil {
		return check.Entry{}, check.ErrRefused
	}
	e, _, err := o.store.AdvanceConnectionCheck(ctx, id, check.RefusedBeforeSend, nil)
	return e, err
}

// A sent result is not verification. Only the retained Go connector owner can
// supply an exact matching current proof (status nonce or original challenge).
func (o *ConnectionCheckOwner) Confirm(ctx context.Context, id string) (check.Entry, error) {
	if !o.valid() || ctx == nil || ctx.Err() != nil {
		return check.Entry{}, check.ErrRefused
	}
	e, err := o.Observe(ctx, id)
	if err != nil || (e.Phase != check.SendAcknowledged && e.Phase != check.DispatchIntent) || e.Scope == nil {
		return check.Entry{}, check.ErrRefused
	}
	digest, err := o.native.ConfirmOriginalConnectionCheck(ctx, id, *e.Scope)
	if err != nil || digest == "" || ctx.Err() != nil {
		return check.Entry{}, check.ErrUnknown
	}
	receipt := check.Receipt{CheckID: e.Scope.CheckID, Kind: string(e.Scope.Mode), Digest: digest}
	verified, _, err := o.store.AdvanceConnectionCheck(ctx, id, check.Verified, &receipt)
	if err == nil {
		// Only a confirmed durable terminal record releases this transient slot.
		// Failure to retire withholds a later check; it cannot erase this receipt.
		_ = o.native.RetireOriginalConnectionCheck(ctx, id, *e.Scope)
	}
	return verified, err
}

// ReceiptAvailable is a READ-ONLY original-attempt observation. Polling it never
// publishes a phase, arms an expectation, or obtains another dispatch right.
// A late proof can be reported for UNKNOWN, but cannot rewrite its history.
func (o *ConnectionCheckOwner) ReceiptAvailable(ctx context.Context, id string) bool {
	e, err := o.Observe(ctx, id)
	if err != nil || e.Scope == nil {
		return false
	}
	if e.Phase == check.Verified {
		return true
	}
	if e.Phase != check.DispatchIntent && e.Phase != check.SendAcknowledged && e.Phase != check.OutcomeUnknown {
		return false
	}
	digest, err := o.native.ConfirmOriginalConnectionCheck(ctx, id, *e.Scope)
	return err == nil && digest != "" && ctx.Err() == nil
}
