// Package egress contains consumer-owned ports for an unselected managed
// transport. Implementations MUST be supplied by existing Computer ownership;
// this packet supplies no new approval store, journal, executor or SSH launcher.
package egress

import (
	"context"

	"github.com/legrch/farol/modules/computer/domain/egress"
)

// Custody is an already-admitted original-operation fence. BeforeRelease must
// durably record the MAY_HAVE_EFFECT transition in the EXISTING operation owner
// before returning nil. It must refuse an unqualified network policy, changed
// source/destination/roots, expired/revoked grant and reused operation. Check
// observes that same binding after each yield; it does not grant or renew it.
// Callbacks must be bounded and must honor the original context/deadline.
type Custody interface {
	Check(context.Context, string) error
	BeforeRelease(context.Context, string) error
}

// Objects reads only an explicitly declared immutable source/base object. The
// caller verifies type, size and both digests before use. No config evaluation,
// lazy fetch, credential lookup or arbitrary path is permitted by this port.
type Objects interface {
	ReadObject(context.Context, string) (string, []byte, error)
}

// Peer is an already-owned, already-authenticated duplex stream to the exact
// remote service. No dial or process spawn happens inside the protocol adapter.
// Binding must attest the effective endpoint/repository, not just github.com.
// Close must unblock both reads and writes. It closes only this original stream;
// it is not a claim that the owning SSH process or its descendants have exited.
type Peer interface {
	Read([]byte) (int, error)
	Write([]byte) (int, error)
	Close() error
	Binding() egress.Target
}
