package catalogue

import (
	"context"
	"github.com/legrch/farol/modules/chat/app/port"
	browserpolicy "github.com/legrch/farol/modules/chat/app/services/modelselection"
	selection "github.com/legrch/farol/modules/chat/domain/modelselection"
)

// BrowserPrepared preserves the existing application's alias/control mapping.
// The added catalogue pin is correlation only; existing admission and public
// control/account verification remain mandatory before Send.
type BrowserPrepared struct {
	Capture  port.ModelSelectionCapture
	Resolved selection.Resolved
}

func PrepareBrowser(cache *Cache, scope selection.Scope, now uint64, digester port.IntentDigester, policy port.ModelPolicy, request port.ModelRequest, profiles []port.BrowserModelProfile) (BrowserPrepared, error) {
	if cache == nil || scope.Route.Backend != selection.BrowserChat {
		return BrowserPrepared{}, Invalid
	}
	snapshot, err := cache.Current()
	if err != nil {
		return BrowserPrepared{}, err
	}
	capture, err := browserpolicy.Resolve(digester, policy, request, profiles, scope.AccountID)
	if err != nil {
		return BrowserPrepared{}, err
	}
	resolved, err := selection.Resolve(snapshot, scope, now, selection.Request{Slug: capture.Selection.ModelID, Effort: capture.Selection.Effort, Requirements: selection.Requirements{Text: true}})
	if err != nil {
		return BrowserPrepared{}, err
	}
	current, err := cache.Current()
	if err != nil {
		return BrowserPrepared{}, err
	}
	if err := selection.RecheckBeforeStart(resolved, current, scope, now); err != nil {
		return BrowserPrepared{}, err
	}
	return BrowserPrepared{*capture, resolved}, nil
}

// InferenceBuilder is a controlled no-effect consumer port. The INFERENCE
// owner supplies its actual request builder through the shared composition seam.
// A builder must return the pin it consumed; host/account execution remains
// outside this package. No builder call is made for stale/unsupported selection.
type InferenceBuilder interface {
	Prepare(context.Context, InferenceInput) (InferencePrepared, error)
}
type InferenceInput struct {
	Pin  selection.Pin
	Text string
}
type InferencePrepared struct {
	Pin  selection.Pin
	Body []byte
}

func PrepareInference(ctx context.Context, cache *Cache, scope selection.Scope, now uint64, request selection.Request, input string, builder InferenceBuilder) (InferencePrepared, error) {
	if ctx == nil || cache == nil || builder == nil || scope.Route.Backend != selection.PlanInference {
		return InferencePrepared{}, Invalid
	}
	if ctx.Err() != nil {
		return InferencePrepared{}, Unavailable
	}
	snapshot, err := cache.Current()
	if err != nil {
		return InferencePrepared{}, err
	}
	request.Requirements.Text = true
	resolved, err := selection.Resolve(snapshot, scope, now, request)
	if err != nil {
		return InferencePrepared{}, err
	}
	out, err := builder.Prepare(ctx, InferenceInput{resolved.Pin(), input})
	if err != nil || ctx.Err() != nil {
		return InferencePrepared{}, Unavailable
	}
	if out.Pin != resolved.Pin() {
		return InferencePrepared{}, ScopeMismatch
	}
	current, err := cache.Current()
	if err != nil {
		return InferencePrepared{}, err
	}
	if err := selection.RecheckBeforeStart(resolved, current, scope, now); err != nil {
		return InferencePrepared{}, err
	}
	out.Body = append([]byte(nil), out.Body...)
	return out, nil
}

// TaskMapping supplies exact model and correlation to a Task-facing consumer.
// The existing Task contract's Selection carries an alias, not an account/model
// epoch. Its Authority owner must compare Pin against its measured binding and
// current account before admission; this mapping supplies no workspace grant.
type TaskMapping struct {
	Pin        selection.Pin
	ModelAlias string
}

func MapTask(resolved selection.Resolved, alias string) (TaskMapping, error) {
	p := resolved.Pin()
	if p.Route.Backend != selection.CodexTask || p.Epoch == 0 || !token(alias, 80) {
		return TaskMapping{}, Invalid
	}
	return TaskMapping{p, alias}, nil
}
