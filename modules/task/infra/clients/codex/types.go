// Package codex owns one selected existing App Server proxy connection. It does
// not start a server, select an account/model, retry, or issue Task admission.
package codex

import (
	"context"
	"io"
	"path/filepath"
	"strings"
	"time"

	"github.com/legrch/farol/modules/task/app/port"
	"github.com/legrch/farol/modules/task/domain"
)

// Selection is supplied by the trusted composition from the current selected
// route and qualified host schema. Paths are never discovered by this adapter.
// Its trusted handoff schema digest covers create/status/steer, but does not
// identify an account or qualify the independent descending-history follow-up.
type Selection struct {
	Binding                                                                      task.Binding
	ExecutablePath, ExecutableSHA256, SocketPath, ExpectedCodexHome, ScratchRoot string
	Protocol, SchemaSHA256                                                       string
	Sandbox, ApprovalPolicy                                                      string
	GrantedAt, ExpiresAt                                                         time.Time
}

// Boundary is consumer-owned. Verify measures the selected executable, socket,
// physical project/writer and shared Git identity. Launch returns only the
// selected proxy's pipes; never an alternate socket, daemon or executor.
type Boundary interface {
	Verify(context.Context, Selection) error
	Launch(context.Context, Selection) (Process, error)
}

// Process belongs to this connection only. Close stops its exact proxy once;
// Wait proves its exit. Proxy cleanup never proves provider task cancellation.
type Process interface {
	io.ReadWriteCloser
	Wait(context.Context) error
}

// FollowupSchemaKind names the independent source witness emitted by
// inspectCodexFollowupHostContract. The baseline create/status digest is not it.
const FollowupSchemaKind = "codex-followup-schema/v1"

type FollowupSchemaWitness struct {
	Kind, Protocol, BaseSchemaSHA256, SchemaSHA256 string
}

// FollowupQualification is supplied only by trusted composition. It binds the
// separate schema witness to the whole immutable selection and grant lifetime.
// It neither issues admission nor attests live account/permission support.
type FollowupQualification struct {
	Selection Selection
	Witness   FollowupSchemaWitness
}

func (q FollowupQualification) valid(s Selection) bool {
	w := q.Witness
	return q.Selection == s && w.Kind == FollowupSchemaKind && w.Protocol == s.Protocol &&
		w.BaseSchemaSHA256 == s.SchemaSHA256 && digest(w.SchemaSHA256) && w.SchemaSHA256 != s.SchemaSHA256
}

type Options struct {
	Selection Selection
	// Zero leaves Continue unsupported. A nonzero value must match Selection.
	Followup FollowupQualification
	Boundary Boundary
	Now      func() time.Time
	// Recheck must use the owning current grant and selected route/config/host
	// generations, not only Selection.ExpiresAt or the model policy digest.
	Recheck func(context.Context, task.Binding) error
	// RecheckDispatch is immutable trusted Root wiring for mutation effects.
	// It must verify the original Task/journal intent and actual current Parent
	// through the selected owner, without IO inside the owner's gate callback.
	// Called after qualification and transport write-lock acquisition, before
	// the first byte of each thread/start, turn/start or turn/steer. Nil keeps only reads:
	// Supports advertises no effects and mutations become sticky unknown.
	RecheckDispatch func(context.Context, task.Intent) error
}

const maxMessageBytes = 8 * 1024 * 1024
const maxPages = 32
const pageSize = 100
const maxOperations = 8192
const maxResultBytes = 65536
const callBudget = 20 * time.Second

func canonical(s string) bool {
	return task.Text(s, 4096) && filepath.IsAbs(s) && s != string(filepath.Separator) && filepath.Clean(s) == s
}
func digest(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, c := range s {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}
func (s Selection) valid() bool {
	return s.Binding.Valid() && s.Binding.Provider == task.Codex && providerID(s.Binding.ProjectID) &&
		canonical(s.ExecutablePath) && digest(s.ExecutableSHA256) && canonical(s.SocketPath) &&
		canonical(s.ExpectedCodexHome) && canonical(s.ScratchRoot) &&
		canonical(s.Binding.Project.Path) && canonical(s.Binding.Writer.Path) && canonical(s.Binding.Project.GitCommonDirectory) &&
		s.Protocol == "codex-app-server/v2" && digest(s.SchemaSHA256) &&
		(s.Sandbox == "read-only" || s.Sandbox == "workspace-write") &&
		(s.ApprovalPolicy == "never" || s.ApprovalPolicy == "on-request" || s.ApprovalPolicy == "on-failure" || s.ApprovalPolicy == "untrusted") &&
		!s.GrantedAt.IsZero() && s.ExpiresAt.After(s.GrantedAt) && s.ExpiresAt.Sub(s.GrantedAt) <= 12*time.Hour &&
		token(s.Binding.Model, 120) && (s.Binding.Effort == "" || token(s.Binding.Effort, 40))
}
func token(s string, limit int) bool {
	if !task.Text(s, limit) {
		return false
	}
	for _, r := range s {
		if r <= 32 || r == 127 {
			return false
		}
	}
	return true
}
func modelName(s string) bool {
	if !token(s, 120) {
		return false
	}
	return strings.IndexFunc(s, func(r rune) bool {
		return !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune("_./-", r))
	}) < 0
}

var _ port.CodexClient = (*Client)(nil)
var _ port.Provider = (*Client)(nil)

// Existing handoff identifiers use the selected vendor ASCII shape.
func providerID(s string) bool {
	if len(s) == 0 || len(s) > 120 {
		return false
	}
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '-') {
			return false
		}
	}
	return true
}
