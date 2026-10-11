package process

import "strings"

const dataVolumePath = "/System/Volumes/Data"

// platformNestedMount compares native mount names with a selected APFS root.
// It inspects no filesystem and grants no additional path authority.
func platformNestedMount(root, rootMount, mounted string) bool {
	alternate := root
	if rootMount == dataVolumePath {
		if insidePolicy(dataVolumePath, root) {
			alternate = strings.TrimPrefix(root, dataVolumePath)
			if alternate == "" {
				alternate = "/"
			}
		} else {
			alternate = dataVolumePath + root
		}
	}
	if mounted == root || mounted == alternate {
		return false // The selected root itself, not a nested mount.
	}
	// Some Data paths have no logical firmlink. Considering their possible alias
	// is conservative: it may refuse an unsupported layout, never admit one.
	return insidePolicy(root, mounted) || alternate == "/" || insidePolicy(alternate, mounted)
}
