package mutation

import (
	"bytes"
	"context"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	domain "github.com/legrch/farol/modules/computer/domain/mutation"
)

// PublishProcessTerminal shares the existing repository's storage, lock, fence
// and Close lifetime. It never admits, spawns, renews or repairs an operation.
// The returned digest acknowledges only a known durable complete final readback.
func (r *Repository) PublishProcessTerminal(ctx context.Context, result processsvc.TerminalResult) (string, error) {
	if !processsvc.ValidTerminalResult(result) {
		return "", failure("WORKSPACE_MUTATION_STATE_INVALID")
	}
	result = result.Clone()
	raw, chunks, err := encodeProcessTerminal(result)
	if err != nil {
		return "", err
	}
	reserved, err := encodeProcess(result.Scope, result.Intent)
	if err != nil {
		return "", err
	}
	id := processIdentity(result.Scope, result.Intent.OperationID)
	key, err := recordKey(id)
	if err != nil {
		return "", err
	}
	if r == nil {
		return "", unavailable()
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if err = r.ready(ctx); err != nil {
		return "", err
	}
	previous, err := r.disk.read(key)
	if err != nil {
		return "", unavailable()
	}
	if previous == nil {
		if err = r.ready(ctx); err != nil {
			return "", err
		}
		return "", failure("WORKSPACE_MUTATION_STATE_MISSING")
	}
	if _, _, err = decodeProcess(previous); err != nil {
		terminal, _, decodeErr := decodeProcessTerminal(previous)
		if decodeErr != nil {
			return "", decodeErr
		}
		original, encodeErr := encodeProcess(terminal.Scope, terminal.Intent)
		if encodeErr != nil || !bytes.Equal(original, reserved) {
			return "", failure("WORKSPACE_MUTATION_BINDING_MISMATCH")
		}
		if !bytes.Equal(raw, previous) {
			return "", failure("WORKSPACE_MUTATION_TERMINAL_IMMUTABLE")
		}
		// An identical manifest alone is insufficient: all chunks must still
		// match. A failed confirmation cannot be upgraded by a later reload.
		if _, err = r.readProcessTerminal(ctx, key, id, previous); err != nil || r.ready(ctx) != nil {
			return r.processPublicationUnknown()
		}
		return processSHA256(raw), nil
	}
	if !bytes.Equal(previous, reserved) {
		return "", failure("WORKSPACE_MUTATION_BINDING_MISMATCH")
	}
	if err = r.ready(ctx); err != nil {
		return "", err
	}
	for _, chunk := range chunks {
		// No EEXIST salvage, partial repair, deletion or second create. Once
		// any publication may have happened, every late failure fences r.
		if r.ready(ctx) != nil {
			return r.processPublicationUnknown()
		}
		if err = r.disk.create(chunk.key, bytes.Clone(chunk.raw)); err != nil || ctx.Err() != nil || r.disk.check() != nil {
			return r.processPublicationUnknown()
		}
		observed, readErr := r.disk.read(chunk.key)
		if readErr != nil || !bytes.Equal(observed, chunk.raw) || ctx.Err() != nil || r.disk.check() != nil {
			return r.processPublicationUnknown()
		}
	}
	if r.ready(ctx) != nil {
		return r.processPublicationUnknown()
	}
	if err = r.disk.replace(key, bytes.Clone(raw), bytes.Clone(reserved)); err != nil || ctx.Err() != nil || r.disk.check() != nil {
		return r.processPublicationUnknown()
	}
	observed, err := r.disk.read(key)
	if err != nil || !bytes.Equal(raw, observed) || ctx.Err() != nil || r.disk.check() != nil {
		return r.processPublicationUnknown()
	}
	if _, err = r.readProcessTerminal(ctx, key, id, observed); err != nil || r.ready(ctx) != nil {
		return r.processPublicationUnknown()
	}
	return processSHA256(raw), nil
}
func (r *Repository) processPublicationUnknown() (string, error) {
	r.fenced = true
	return "", unknown()
}

// LoadProcessTerminal is read-only. Nil means qualified missing or a valid v4
// reservation. Root must apply current READ owner/profile/computer/workspace
// authority before disclosure. A saved result is never authority to restart.
func (r *Repository) LoadProcessTerminal(ctx context.Context, id domain.Identity) (*processsvc.TerminalResult, error) {
	if id.Scope != domain.ScopeConnector {
		return nil, failure("WORKSPACE_MUTATION_STATE_INVALID")
	}
	key, err := recordKey(id)
	if err != nil {
		return nil, err
	}
	if r == nil {
		return nil, unavailable()
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if err = r.ready(ctx); err != nil {
		return nil, err
	}
	raw, err := r.disk.read(key)
	if err != nil {
		return nil, unavailable()
	}
	if raw == nil {
		return nil, r.ready(ctx)
	}
	if scope, intent, err := decodeProcess(raw); err == nil {
		if processIdentity(scope, intent.OperationID) != id {
			return nil, failure("WORKSPACE_MUTATION_BINDING_MISMATCH")
		}
		return nil, r.ready(ctx)
	}
	result, err := r.readProcessTerminal(ctx, key, id, raw)
	if err != nil {
		return nil, err
	}
	if err = r.ready(ctx); err != nil {
		return nil, err
	}
	copy := result.Clone()
	return &copy, nil
}

// Caller holds r.mu. Every read is bounded and guarded; corruption never means
// absence. This helper neither writes nor clears the writer's sticky fence.
func (r *Repository) readProcessTerminal(ctx context.Context, key string, id domain.Identity, raw []byte) (*processsvc.TerminalResult, error) {
	v, e, err := decodeProcessTerminal(raw)
	if err != nil {
		return nil, err
	}
	if processIdentity(v.Scope, v.Intent.OperationID) != id {
		return nil, failure("WORKSPACE_MUTATION_BINDING_MISMATCH")
	}
	for _, stream := range []struct {
		name string
		data []byte
		list []processOutputDigest
	}{{"stdout", v.Observation.Stdout, e.Record.Stdout}, {"stderr", v.Observation.Stderr, e.Record.Stderr}} {
		for _, d := range stream.list {
			if err = r.ready(ctx); err != nil {
				return nil, err
			}
			raw, readErr := r.disk.read(processOutputKey(key, stream.name, d))
			if readErr != nil {
				return nil, unavailable()
			}
			data, decodeErr := decodeProcessOutput(raw, key, stream.name, d)
			if decodeErr != nil {
				return nil, decodeErr
			}
			copy(stream.data[d.Offset:d.Offset+uint64(d.Bytes)], data)
		}
	}
	if err = r.ready(ctx); err != nil {
		return nil, err
	}
	return v, nil
}
