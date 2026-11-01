// Package helperinput validates the meaning of existing installed-helper input.
// It performs no observations or effects and grants no update admission.
package helperinput

import (
	"context"
	"strings"
	"unicode/utf8"

	"github.com/legrch/farol/modules/release/app/port"
)

const maxInputBytes = 8192

type Service struct{ decoder port.HelperInputDecoder }

func New(decoder port.HelperInputDecoder) *Service { return &Service{decoder: decoder} }

// Failure exposes only a stable refusal code, never input or adapter details.
type Failure struct{ Code string }

func (f *Failure) Error() string { return f.Code }

func (s *Service) Parse(ctx context.Context, input []byte) (port.HelperRequest, error) {
	refuse := func(code string) (port.HelperRequest, error) {
		return port.HelperRequest{}, &Failure{Code: code}
	}
	if ctx == nil {
		return refuse("unavailable")
	}
	if ctx.Err() != nil {
		return refuse("canceled")
	}
	if s == nil || s.decoder == nil {
		return refuse("unavailable")
	}
	if len(input) < 1 || len(input) > maxInputBytes {
		return refuse("input")
	}
	r, err := s.decoder.Decode(input)
	if ctx.Err() != nil {
		return refuse("canceled")
	}
	if err != nil {
		return refuse("input")
	}
	// The decoder may retain its own DTOs. Each result owns its optional values.
	if r.RelaunchPresentation != nil {
		v := *r.RelaunchPresentation
		r.RelaunchPresentation = &v
		if v != "sidecar-only" || !r.Relaunch || r.Predecessor != nil {
			return refuse("input")
		}
	}
	if r.InstallLocation != nil {
		v := *r.InstallLocation
		r.InstallLocation = &v
	}
	if r.Predecessor != nil {
		v := *r.Predecessor
		r.Predecessor = &v
	}
	if r.LeaseIdentity != nil {
		v := *r.LeaseIdentity
		r.LeaseIdentity = &v
	}
	// Preserve the old parser's semantic ordering: optional proof, envelope and
	// builds precede acceptance, which precedes process and home validation.
	if r.InstallLocation != nil && *r.InstallLocation != "shared" && *r.InstallLocation != "legacy" {
		return refuse("input")
	}
	if r.Predecessor != nil {
		p := r.Predecessor
		if (r.Action != "apply" && r.Action != "rollback") || (r.Action == "rollback" && r.Relaunch) ||
			p.Kind != "confirmed_closed" || !text(p.StartedAt, 64) || !hex(p.LastQuitSHA256, 64) ||
			!identity(p.StateIdentity) || r.LeaseIdentity == nil || !identity(*r.LeaseIdentity) {
			return refuse("input")
		}
	} else if r.LeaseIdentity != nil {
		return refuse("input")
	}
	if r.Schema != "farol.installed-update/1" || (r.Action != "apply" && r.Action != "recover" && r.Action != "rollback") ||
		!hex(r.OperationID, 32) || !build(r.Source) || !build(r.Target) {
		return refuse("input")
	}
	if r.Source == r.Target || r.Drain.Status != "reconciled" || r.Drain.AcceptedSource != r.Source.BuildID || r.Drain.AcceptedTarget != r.Target.BuildID {
		return refuse("acceptance")
	}
	if r.PID < 2 || r.PID > 2147483647 || !text(r.ProcessStart, 128) || r.WaitSeconds < 1 || r.WaitSeconds > 120 || !home(r.Home) {
		return refuse("input")
	}
	return r, nil
}

func text(s string, max int) bool {
	return utf8.ValidString(s) && utf8.RuneCountInString(s) >= 1 && utf8.RuneCountInString(s) <= max
}

func hex(s string, size int) bool {
	if len(s) != size {
		return false
	}
	for _, c := range s {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

func build(b port.HelperBuild) bool {
	return hex(b.Digest, 64) && text(b.Version, 128) && hex(b.BuildID, 64)
}

func identity(v port.HelperIdentity) bool { return decimal(v.Device) && decimal(v.Inode) }

func decimal(s string) bool {
	if len(s) < 1 || len(s) > 30 || (len(s) > 1 && s[0] == '0') {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

func home(s string) bool {
	if !utf8.ValidString(s) || !strings.HasPrefix(s, "/") || strings.ContainsRune(s, 0) {
		return false
	}
	for _, part := range strings.Split(s[1:], "/") {
		if part == "" || part == "." || part == ".." || len(part) > 255 {
			return false
		}
	}
	return true
}
