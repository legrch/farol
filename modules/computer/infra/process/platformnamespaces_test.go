package process

import "testing"

func TestRootScopedPlatformNestedMountAliases(t *testing.T) {
	for _, tc := range []struct {
		name, root, mount, nested string
		want                      bool
	}{
		{"logical-physical", "/Users/owner", dataVolumePath, dataVolumePath + "/Users/owner/volume", true},
		{"physical-logical", dataVolumePath + "/Users/owner", dataVolumePath, "/Users/owner/volume", true},
		{"physical-physical", dataVolumePath + "/Users/owner", dataVolumePath, dataVolumePath + "/Users/owner/volume", true},
		{"logical-logical", "/Users/owner", dataVolumePath, "/Users/owner/volume", true},
		{"logical-same", "/Users/owner", dataVolumePath, "/Users/owner", false},
		{"physical-same-alias", dataVolumePath + "/Users/owner", dataVolumePath, "/Users/owner", false},
		{"prefix-neighbor", dataVolumePath + "/Users/owner", dataVolumePath, "/Users/owner-else/volume", false},
		{"foreign-volume-no-alias", "/Volumes/work/Users/owner", "/Volumes/work", "/Users/owner/volume", false},
		{"foreign-volume-nested", "/Volumes/work/project", "/Volumes/work", "/Volumes/work/project/volume", true},
		{"data-root-logical-child", dataVolumePath, dataVolumePath, "/Users/owner/volume", true},
		{"data-root-self", dataVolumePath, dataVolumePath, dataVolumePath, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := platformNestedMount(tc.root, tc.mount, tc.nested); got != tc.want {
				t.Fatalf("nested mount classification got %v want %v", got, tc.want)
			}
		})
	}
}
