package apptree

import (
	"context"
	"strings"
)

// links resolves raw inventory keys only. A component must be a directory before
// another component (including dot or dotdot) can be processed. In particular,
// lexical cleaning before inspecting a symlink would hide escapes.
func (s *inventory) links(ctx context.Context) error {
	for name, rec := range s.entries {
		if e := canceled(ctx); e != nil {
			return e
		}
		if rec.stat.kind() != 'l' {
			continue
		}
		pieces := strings.Split(name, "/")
		stack := append([]string(nil), pieces[:len(pieces)-1]...)
		pending := strings.Split(rec.link, "/")
		hops := 1
		for len(pending) > 0 {
			if e := canceled(ctx); e != nil {
				return e
			}
			part := pending[0]
			pending = pending[1:]
			if part == "" || part == "." {
				continue
			}
			if part == ".." {
				if len(stack) == 0 {
					return refuse(CodeLink)
				}
				stack = stack[:len(stack)-1]
				continue
			}
			key := part
			if len(stack) > 0 {
				key = strings.Join(stack, "/") + "/" + part
			}
			target, ok := s.entries[key]
			if !ok {
				return refuse(CodeLink)
			}
			if target.stat.kind() == 'l' {
				hops++
				if hops > 40 {
					return refuse(CodeLink)
				}
				// Expansion is bounded by link length and the 40 substitution limit.
				pending = append(strings.Split(target.link, "/"), pending...)
				continue
			}
			if len(pending) > 0 && target.stat.kind() != 'd' {
				return refuse(CodeLink)
			}
			stack = append(stack, part)
		}
		if len(stack) == 0 {
			return refuse(CodeLink)
		}
	}
	return canceled(ctx)
}
