package authority

import (
	"strings"
	"unicode/utf8"

	"golang.org/x/text/cases"
	"golang.org/x/text/collate"
	"golang.org/x/text/language"
	"golang.org/x/text/unicode/norm"
)

func CanonicalPath(path string) bool {
	if !utf8.ValidString(path) || !strings.HasPrefix(path, "/") || strings.ContainsRune(path, 0) {
		return false
	}
	if path == "/" {
		return true
	}
	for _, part := range strings.Split(path[1:], "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}

// Within deliberately preserves exact case/normalization for positive grants.
func Within(root, path string) bool {
	return CanonicalPath(root) && CanonicalPath(path) && (root == "/" || root == path || strings.HasPrefix(path, root+"/"))
}

// ComparableWithin is for denials only. It retains Python NFC/casefold aliases
// and the TS en-US base-sensitivity aliases (including diacritics). It never
// broadens a positive grant. Collator/folder state belongs to this call.
func ComparableWithin(root, path string) bool {
	if !CanonicalPath(root) || !CanonicalPath(path) {
		return false
	}
	if root == "/" {
		return true
	}
	roots, paths := strings.Split(root[1:], "/"), strings.Split(path[1:], "/")
	if len(roots) > len(paths) {
		return false
	}
	folder := cases.Fold()
	comparator := collate.New(language.AmericanEnglish, collate.Loose)
	for i, part := range roots {
		if comparator.CompareString(folder.String(norm.NFC.String(part)), folder.String(norm.NFC.String(paths[i]))) != 0 {
			return false
		}
	}
	return true
}
func containsPath(scope Scope, path string) bool {
	if !Within(scope.Root, path) {
		return false
	}
	if scope.Mode == Subtree {
		return true
	}
	if scope.Mode != Exact {
		return false
	}
	for _, allowed := range scope.Paths {
		if path == allowed {
			return true
		}
	}
	return false
}
func accessIncludes(parent, child Access) bool {
	return (parent == ReadAccess || parent == WriteAccess) && (child == ReadAccess || child == WriteAccess) && (parent == WriteAccess || child == ReadAccess)
}
func scopesSubset(parent, child []Scope) bool {
	ids := map[string]bool{}
	for _, scope := range child {
		if ids[scope.WorkspaceID] || !CanonicalPath(scope.Root) {
			return false
		}
		ids[scope.WorkspaceID] = true
		matched := false
		for _, candidate := range parent {
			if candidate.WorkspaceID != scope.WorkspaceID || !accessIncludes(candidate.Access, scope.Access) || !Within(candidate.Root, scope.Root) {
				continue
			}
			if scope.Mode == Subtree {
				matched = candidate.Mode == Subtree
			} else if scope.Mode == Exact && len(scope.Paths) > 0 {
				matched = true
				paths := map[string]bool{}
				for _, path := range scope.Paths {
					if paths[path] || !Within(scope.Root, path) || !containsPath(candidate, path) {
						matched = false
						break
					}
					paths[path] = true
				}
			}
			if matched {
				break
			}
		}
		if !matched {
			return false
		}
	}
	return true
}
func exclusionsValid(scopes []Scope, exclusions []Exclusion) bool {
	if len(exclusions) > 32 {
		return false
	}
	keys := map[[2]string]bool{}
	for _, exclusion := range exclusions {
		key := [2]string{exclusion.WorkspaceID, exclusion.Path}
		if keys[key] || !CanonicalPath(exclusion.Path) {
			return false
		}
		keys[key] = true
		matched := false
		for _, scope := range scopes {
			if scope.WorkspaceID == exclusion.WorkspaceID && containsPath(scope, exclusion.Path) {
				matched = true
				break
			}
		}
		if !matched {
			return false
		}
	}
	return true
}
func affects(exclusion Exclusion, scope Scope) bool {
	if exclusion.WorkspaceID != scope.WorkspaceID {
		return false
	}
	if scope.Mode == Subtree {
		return ComparableWithin(scope.Root, exclusion.Path) || ComparableWithin(exclusion.Path, scope.Root)
	}
	for _, path := range scope.Paths {
		if ComparableWithin(exclusion.Path, path) {
			return true
		}
	}
	return false
}
func relevant(scopes []Scope, exclusions []Exclusion, source Source) []Exclusion {
	var out []Exclusion
	for _, exclusion := range exclusions {
		for _, scope := range scopes {
			if affects(exclusion, scope) {
				exclusion.RestrictionSource = source
				out = append(out, exclusion)
				break
			}
		}
	}
	return out
}
func merge(groups ...[]Exclusion) []Exclusion {
	var out []Exclusion
	indexes := map[[2]string]int{}
	for _, group := range groups {
		for _, exclusion := range group {
			key := [2]string{exclusion.WorkspaceID, exclusion.Path}
			if i, found := indexes[key]; found {
				out[i] = exclusion
			} else {
				indexes[key] = len(out)
				out = append(out, exclusion)
			}
		}
	}
	return out
}
func deniedBy(exclusions []Exclusion, op Operation) (Exclusion, bool) {
	for _, exclusion := range exclusions {
		if exclusion.WorkspaceID == op.WorkspaceID && ComparableWithin(exclusion.Path, op.Path) {
			return exclusion, true
		}
	}
	return Exclusion{}, false
}

// DenialSource reports restriction provenance, including unverified legacy data.
func DenialSource(source Source) string {
	switch source {
	case ComputerApprovalSource, TaskGrantSource, OwnerRestrictionSource:
		return string(source)
	default:
		return "unverified-provenance"
	}
}
