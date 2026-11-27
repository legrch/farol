package filesystem

import (
	"regexp"
	"regexp/syntax"
	"strings"
	"unicode/utf8"
)

// RE2 gives bounded linear matching. Python-only constructs and escapes with
// different Unicode shorthand semantics are refused. This is a conservative
// RE2 subset, not full Python regex equivalence. It includes Unicode literals,
// groups, alternation, classes, anchors, flags and standalone quantifiers. No interpreter or fallback is launched.
func searchExpression(pattern string) (*regexp.Regexp, error) {
	units := 0
	if !utf8.ValidString(pattern) || pattern == "" {
		return nil, refusal("WORKSPACE_INVALID_REQUEST")
	}
	for _, r := range pattern {
		units++
		if r > 0xffff {
			units++
		}
		if r < 32 || r == 127 || units > 4096 {
			return nil, refusal("WORKSPACE_INVALID_REQUEST")
		}
	}
	for i := 0; i < len(pattern); i++ {
		if pattern[i] != '\\' {
			continue
		}
		i++
		if i == len(pattern) {
			return nil, refusal("WORKSPACE_INVALID_REQUEST")
		}
		// Python uses Unicode word/digit/space classes and boundaries; RE2 uses
		// ASCII for these escapes. Refuse until their contract is explicitly mapped.
		if strings.ContainsRune("wWdDsSbBpPzQ", rune(pattern[i])) {
			return nil, refusal("WORKSPACE_INVALID_REQUEST")
		}
	}
	if strings.Contains(pattern, "(?U") || strings.Contains(pattern, `\x{`) || strings.Contains(pattern, "[[:") || strings.Contains(pattern, "(?<") {
		return nil, refusal("WORKSPACE_INVALID_REQUEST")
	}
	tree, err := syntax.Parse(pattern, syntax.Perl)
	if err != nil || !searchSafeRegex(tree, false) {
		return nil, refusal("WORKSPACE_INVALID_REQUEST")
	}
	expression, err := regexp.Compile(pattern)
	if err != nil {
		return nil, refusal("WORKSPACE_INVALID_REQUEST")
	}
	return expression, nil
}

// Preserve the helper's refusal of nested/adjacent repetitions and repeated
// alternatives even though RE2 itself does not backtrack. Parser simplification
// may refuse additional equivalent forms; it never enables a Python-only form.
func searchRepeat(tree *syntax.Regexp) bool {
	return tree.Op == syntax.OpStar || tree.Op == syntax.OpPlus || tree.Op == syntax.OpQuest || tree.Op == syntax.OpRepeat
}
func searchContainsRepeat(tree *syntax.Regexp) bool {
	if searchRepeat(tree) {
		return true
	}
	for _, child := range tree.Sub {
		if searchContainsRepeat(child) {
			return true
		}
	}
	return false
}
func searchSafeRegex(tree *syntax.Regexp, inside bool) bool {
	if searchRepeat(tree) {
		if inside {
			return false
		}
		return searchSafeRegex(tree.Sub[0], true)
	}
	if tree.Op == syntax.OpAlternate {
		if inside {
			return false
		}
		for _, child := range tree.Sub {
			if searchContainsRepeat(child) {
				return false
			}
		}
	}
	previous := false
	for _, child := range tree.Sub {
		if !searchSafeRegex(child, inside) {
			return false
		}
		if tree.Op == syntax.OpConcat {
			repeated := searchRepeat(child)
			if repeated && previous {
				return false
			}
			// Anchors do not separate adjacent repetitions in the active helper.
			if child.Op != syntax.OpBeginLine && child.Op != syntax.OpEndLine && child.Op != syntax.OpBeginText && child.Op != syntax.OpEndText {
				previous = repeated
			}
		}
	}
	return true
}
