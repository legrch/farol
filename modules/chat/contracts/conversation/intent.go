package conversation

import (
	"context"

	admissionsvc "github.com/legrch/farol/modules/chat/app/services/admission"
	"github.com/legrch/farol/modules/chat/app/services/lifecycle"
	"github.com/legrch/farol/modules/chat/contracts/admission"
)

// ReadIntent captures one actual live bare read admission minted by this Facade.
// It carries no wire IDs or app/domain DTOs on its public surface. Computer keeps
// Current through final disclosure; promotion retains that exact owning handle.
type ReadIntent struct {
	facade  *Facade
	actual  *lifecycle.Handle
	current *admission.Current
}

func (f *Facade) AdmitReadIntent(ctx context.Context, binding Binding, digest string) (*ReadIntent, error) {
	if f == nil || f.service == nil {
		return nil, failure(lifecycle.Invalid)
	}
	h, err := f.service.Admit(ctx, toBinding(binding), digest)
	if err != nil {
		return nil, failure(err)
	}
	s, err := admissionsvc.New(h)
	if err != nil {
		return nil, failure(err)
	}
	return &ReadIntent{facade: f, actual: h, current: admission.New(s)}, nil
}

// Current returns the once-captured public admission guard, not a new owner.
func (r *ReadIntent) Current() (*admission.Current, error) {
	if r == nil || r.facade == nil || r.actual == nil || r.current == nil {
		return nil, failure(lifecycle.Invalid)
	}
	return r.current, nil
}

func (f *Facade) PromoteReadIntent(ctx context.Context, r *ReadIntent, input Input) (*Handle, error) {
	if f == nil || f.service == nil || r == nil || r.facade != f || r.actual == nil {
		return nil, failure(lifecycle.Invalid)
	}
	c, err := f.service.PromoteConversation(ctx, r.actual, toInput(input))
	if err != nil {
		return nil, failure(err)
	}
	return &Handle{facade: f, current: c}, nil
}

func (f *Facade) WithdrawReadIntent(ctx context.Context, r *ReadIntent) error {
	if f == nil || f.service == nil || r == nil || r.facade != f || r.actual == nil {
		return failure(lifecycle.Invalid)
	}
	return failure(f.service.WithdrawReadIntent(ctx, r.actual))
}
