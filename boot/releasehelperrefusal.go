package boot

import (
	"context"
	"time"

	executionapp "github.com/legrch/farol/modules/release/app/services/execution"
	inputapp "github.com/legrch/farol/modules/release/app/services/helperinput"
	protocolapp "github.com/legrch/farol/modules/release/app/services/helperprotocol"
	"github.com/legrch/farol/modules/release/app/services/processwait"
	"github.com/legrch/farol/modules/release/infra/native/handoff"
	"github.com/legrch/farol/modules/release/infra/native/helperlocks"
	"github.com/legrch/farol/modules/release/infra/native/helperroutes"
	"github.com/legrch/farol/modules/release/infra/native/slotbinding"
)

// The pre-ACK refusal contract mirrors resources/native/update_helper.py main():
// a Refusal raised after the request was parsed and before any handoff frame
// was sent emits ONE `refused` handoff frame carrying the code, then reports
// {"phase": P, "error": C, "operationId": ID} and exits 70.
//
// A refusal reaches that path only when it is provably clean: a DIRECT, non-nil
// classified error whose own flags say neither Internal nor Uncertain (see
// closedHelperRefusalOf). Wrapped, joined, opaque, internal or uncertain errors,
// a refusal after the first frame, and any failure of the refused frame itself
// keep the unknown outcome (79) and send no further frame. The single actual
// attempt is never retried.

// closedHelperRefusalRecord carries a clean refusal out of a scope whose
// wrappers would otherwise erase its classification (closedHelperReady). It is
// recorded at the refusal site, inside a scope that then settles normally, and
// is only a request to refuse: it has not emitted anything.
type closedHelperRefusalRecord struct{ phase, code string }

func (*closedHelperRefusalRecord) Error() string { return "release_closed_helper_clean_refusal" }

// closedHelperRefused is the outer outcome after exactly one refused frame was
// written. Only closedHelperRefusalPath.refuse constructs it, and only
// closedHelperTerminal maps it to exit 70. It is not wrapped by custody cleanup
// unless a cleanup step fails, which makes the outcome unknown.
type closedHelperRefused struct{ operationID, phase, code string }

func (*closedHelperRefused) Error() string { return "release_closed_helper_refused" }

// closedHelperRefusalOf classifies a DIRECT error only. It never unwraps: each
// application or custody owner already derives Internal/Uncertain from its own
// causes, so those flags are authoritative and no second cause rule applies.
// Typed-nil, wrapped, joined and foreign errors are not refusals. Codes that a
// type canonicalizes in Error() must equal that canonical text.
func closedHelperRefusalOf(err error) (phase, code string, ok bool) {
	phase = "refused"
	switch f := err.(type) {
	case *closedHelperRefusalRecord:
		if f != nil {
			phase, code, ok = f.phase, f.code, true
		}
	case *executionapp.Failure:
		if f != nil && !f.Internal && !f.Uncertain {
			phase, code, ok = f.Phase, f.Code, true
		}
	case *handoff.Failure:
		if f != nil && !f.Internal && !f.Uncertain {
			code, ok = string(f.Code), true
		}
	case handoff.Code:
		code, ok = string(f), true
	case *slotbinding.VerificationFailure:
		if f != nil && !f.Internal && f.Error() == f.Code && f.Code != "slot_binding_internal" {
			code, ok = f.Code, true
		}
	case *helperroutes.Error:
		if f != nil && !f.Internal && f.Error() == "helper routes: "+string(f.Code) {
			code, ok = string(f.Code), true
		}
	case *helperlocks.Failure:
		if f != nil && !f.Internal && !f.Uncertain && f.Error() == f.Code && f.Code != "lock_io" {
			code, ok = f.Code, true
		}
	case *inputapp.Failure:
		if f != nil {
			code, ok = f.Code, true
		}
	case *protocolapp.Failure:
		if f != nil && !f.Internal {
			code, ok = f.Code, true
		}
	case *processwait.Failure:
		if f != nil && !f.Uncertain {
			code, ok = f.Code, true
		}
	}
	if !ok || !closedHelperPhasePattern.MatchString(phase) || !closedHelperCodePattern.MatchString(code) {
		return "", "", false
	}
	return phase, code, true
}

// closedHelperRefusalPath is the one pre-ACK refusal outcome shared by the
// closed and live compositions. It holds only the parsed request's protocol
// service, the effective context bound to the original absolute limit, and the
// composition's single ACK channel.
type closedHelperRefusalPath struct {
	ctx         context.Context
	until       time.Time
	protocol    *protocolapp.Service
	operationID string
	emit        func(context.Context, time.Time, []byte) error
	exposed     *bool
	// sent is the refusal whose frame was written inside the borrowed route
	// scope (see settle). It is read only after that scope returned.
	sent *closedHelperRefused
	// entered is set when the route scope actually invoked the callback.
	entered bool
}

// refuse turns a pre-ACK failure into its outcome. A provably clean refusal
// emits exactly one refused frame and returns *closedHelperRefused; everything
// else returns the same unknown failure the composition returned before. It is
// never called after a frame was sent.
func (p *closedHelperRefusalPath) refuse(err error) error {
	phase, code, ok := closedHelperRefusalOf(err)
	if !ok || *p.exposed {
		return closedHelperFail(*p.exposed, err)
	}
	// The original absolute bound still governs: a late refusal sends nothing.
	if bounds := closedHelperBounds(p.ctx, p.until); bounds != nil {
		return closedHelperFail(false, err, bounds)
	}
	frame, buildErr := p.protocol.BuildHandoff(p.ctx, protocolapp.Refused, &code)
	if buildErr != nil || len(frame) == 0 {
		return closedHelperFail(buildErr == nil, err, buildErr)
	}
	// The one actual attempt. A failed write may still have exposed bytes, so it
	// is unknown; there is no second frame, retry or receipt.
	*p.exposed = true
	if emitErr := p.emit(p.ctx, p.until, frame); emitErr != nil {
		return closedHelperFail(true, err, emitErr)
	}
	return &closedHelperRefused{operationID: p.operationID, phase: phase, code: code}
}

// settle runs the pre-ACK/post-ACK body inside the borrowed route scope. The
// native route scope re-wraps every callback error as an opaque failure, which
// would erase a sent refusal, so the refusal is recorded here and the scope
// settles normally: its own post-callback custody verification still runs, and
// any failure of it, of the cleanup or of the bound makes the outcome unknown
// (finish). It never converts anything else.
func (p *closedHelperRefusalPath) settle(fn func(helperroutes.Files) error) func(helperroutes.Files) error {
	return func(files helperroutes.Files) error {
		p.entered = true
		err := fn(files)
		if refused, ok := err.(*closedHelperRefused); ok && refused != nil {
			p.sent = refused
			return nil
		}
		return err
	}
}

// finish reports the outcome of the whole scope. A recorded refusal is the
// result only when every scope around it also returned cleanly.
func (p *closedHelperRefusalPath) finish(outer error) error {
	if p.sent == nil {
		return outer
	}
	if outer != nil {
		return closedHelperFail(true, outer, p.sent)
	}
	return p.sent
}

// beforeCallback judges an error that WithFiles returned WITHOUT entering the
// callback (its own pre-borrow verification, for example a pinned directory
// replaced since OpenExisting). Such an error is a direct classification, not a
// callback cause, so it takes the same refusal path, but only after the routes
// closed successfully: a cleanup failure, a wrapped, joined, internal or
// uncertain error, an elapsed bound or an already-sent frame stay unknown. The
// caller's deferred cleanup must not close the routes a second time.
func (p *closedHelperRefusalPath) beforeCallback(err error, closeRoutes func() error) error {
	if err == nil || p.entered {
		return err
	}
	if closeErr := closeRoutes(); closeErr != nil {
		return closedHelperFail(*p.exposed, err, closeErr)
	}
	return p.refuse(err)
}
