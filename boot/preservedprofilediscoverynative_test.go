//go:build darwin

package boot

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// These retain the shared fixture's -preserved-profile-native guard and every
// fixture directory, including failures. Native library repositories and physical
// custody are exercised; browser and Settings/consent remain controlled doubles.
// No app, child transport, old ACK/terminal, process closure or recovery authority
// is established. Each discovery attempt receives a fresh retained fixture.

// Existing canonical claim names and the same nonblocking read-only flock probe
// used by TestPreservedProfileNativeCompositeRetainsClaimsAndBytes.
var preservedProfileDiscoveryClaims = []string{
	"computer/computer-access.lock",
	"chat/chat-handoff.claim",
	"chat/chat-lifecycle.claim",
	"chat/chat-results/chat-results.claim",
	"computer/.mutation-writer.lock",
}

func snapshotPreservedProfileDiscoveryCustody(t *testing.T, in preservedProfileInspectionInput, workspace string) {
	t.Helper()
	profileBefore := snapshotPreservedObservationTree(t, in.Profile.Root)
	workBefore := snapshotPreservedObservationTree(t, workspace)
	// Separate cleanups retain both checks even if one detects a regression.
	t.Cleanup(func() { unchangedPreservedObservationTree(t, workspace, workBefore) })
	t.Cleanup(func() { unchangedPreservedObservationTree(t, in.Profile.Root, profileBefore) })
	t.Cleanup(func() {
		for _, path := range []string{emptyRecoveryPendingPath(in.Profile.Root), filepath.Join(in.Profile.Root, "chat-retired-"+in.Selection.OperationID)} {
			if _, err := os.Lstat(path); !os.IsNotExist(err) {
				t.Error("read-only discovery created pending intent or selected archive", path, err)
			}
		}
	})
}

func TestPreservedProfileDiscoveryNativeCanonicalScopeAndMetadata(t *testing.T) {
	for _, withFile := range []bool{false, true} {
		name := "empty-mutations"
		if withFile {
			name = "completed-file-mutation"
		}
		t.Run(name, func(t *testing.T) {
			in, workspace := preservedProfileFixture(t, true, withFile)
			snapshotPreservedProfileDiscoveryCustody(t, in, workspace)
			request := preservedProfileDiscoveryRequest(in)
			wantInput := request
			wantInput.Mutations = append(request.Mutations[:0:0], request.Mutations...)
			original := &preservedProfileLagContext{Context: context.Background(), until: time.Now().Add(5 * time.Second)}
			calls := 0
			err := discoverPreservedProfile(original, request, func(v preservedProfileInspection) error {
				calls++
				if v.Plan.Selection != in.Selection || v.Lifecycle.Scope != in.Selection.Current.Scope || v.Handoff.Scope != in.Selection.Current.Scope || v.Results.Scope != in.Selection.Current.Scope {
					t.Error("discovery did not join the original canonical scope and selected future identities")
				}
				if v.Handoff.HeadDigest != in.Selection.HandoffDigest || v.Lifecycle.SnapshotDigest != in.Selection.LifecycleDigest || v.Results.SnapshotDigest != in.Selection.ResultsDigest || v.Access.Digest != in.AccessDigest {
					t.Error("discovery changed canonical digests or independent access selection")
				}
				if in.Selection.Current.Scope.BackendGeneration != "original-generation" || v.Lifecycle.TurnCount != 2 || v.Results.ResultCount != 2 || !v.Results.Unresolved || !v.Plan.RetainsUnresolvedResults || v.Lifecycle.Retirement != nil {
					t.Error("discovery lost original nonempty/UNKNOWN state or invented retirement")
				}
				if v.Chat.Path != filepath.Join(in.Profile.Root, "chat") || v.Computer.Path != filepath.Join(in.Profile.Root, "computer") || v.Task.Path != filepath.Join(in.Profile.Root, "task") || v.Chat.ProfileID != in.Profile.ProfileID || v.Computer.ProfileID != in.Profile.ProfileID || v.Task.ProfileID != in.Profile.ProfileID || v.Lifecycle.Root != in.Selection.Current.ChatRoot || v.Results.Root != in.Selection.Current.ChatRoot || v.Handoff.ParentRoot != in.Selection.Current.ParentRoot || v.Handoff.ChatRoot != in.Selection.Current.ChatRoot {
					t.Error("discovery crossed the independently selected physical profile roots")
				}
				if v.Access.Binding.ProfileID != in.Profile.ProfileID || v.Access.Binding.OwnerID != in.OwnerID || v.Access.Binding.ComputerID != in.ComputerID {
					t.Error("discovery changed independent access owner binding")
				}
				if withFile {
					if len(in.Mutations) != 1 || v.Mutations == nil || v.EmptyMutations != nil {
						t.Error("discovery lost the selected completed owner mutation set")
					} else if len(v.Mutations.Retained) != len(in.Mutations) {
						t.Error("discovery expanded or dropped selected completed mutations")
					} else {
						for n, expected := range in.Mutations {
							got := v.Mutations.Retained[n]
							if got.Key != expected.Key || got.SHA256 != expected.SHA256 || got.Identity != expected.Binding.Identity {
								t.Error("discovery changed a selected completed mutation")
							}
						}
					}
				} else if len(in.Mutations) != 0 || v.Mutations != nil || v.EmptyMutations == nil {
					t.Error("discovery did not retain the empty mutation claim")
				}
				for _, name := range preservedProfileDiscoveryClaims {
					fd, err := unix.Open(filepath.Join(in.Profile.Root, name), unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
					if err != nil {
						t.Fatal(err)
					}
					lockErr := unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB)
					closeErr := unix.Close(fd)
					if lockErr != unix.EWOULDBLOCK || closeErr != nil {
						t.Error("discovery visitor lost an existing composite claim", name, lockErr, closeErr)
					}
				}
				return nil
			})
			if err != nil || calls != 1 {
				t.Fatal("canonical scope discovery refused", err, calls)
			}
			if original.reads != 1 {
				t.Error("discovery renewed the original budget between qualification and observation", original.reads)
			}
			if !reflect.DeepEqual(request, wantInput) || !reflect.DeepEqual(in.Mutations, wantInput.Mutations) {
				t.Error("discovery mutated caller input or selected mutation backing storage")
			}
		})
	}
}

func TestPreservedProfileDiscoveryNativeRefusesChangedIndependentSelections(t *testing.T) {
	for _, changed := range []string{"profile-id", "parent-root", "chat-root", "next-reuses-current", "access-digest", "omitted-mutation", "mutation-digest"} {
		t.Run(changed, func(t *testing.T) {
			in, workspace := preservedProfileFixture(t, true, true)
			snapshotPreservedProfileDiscoveryCustody(t, in, workspace)
			request := preservedProfileDiscoveryRequest(in)
			switch changed {
			case "profile-id":
				// Internally consistent caller relabelling must still disagree with
				// the profile ID in the canonical lifecycle snapshot.
				request.Profile.ProfileID = "another-selected-profile"
				request.Selection.Current.Scope.ProfileID = request.Profile.ProfileID
				request.Selection.Next.ProfileID = request.Profile.ProfileID
			case "parent-root":
				request.Selection.Current.ParentRoot.Inode++
			case "chat-root":
				request.Selection.Current.ChatRoot.Inode++
			case "next-reuses-current":
				request.Selection.Next.BackendGeneration = in.Selection.Current.Scope.BackendGeneration
			case "access-digest":
				request.AccessDigest[0] ^= 1
			case "omitted-mutation":
				request.Mutations = nil
			case "mutation-digest":
				request.Mutations[0].SHA256 = strings.Repeat("0", 64)
			}
			wantInput := request
			wantInput.Mutations = append(request.Mutations[:0:0], request.Mutations...)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			calls := 0
			err := discoverPreservedProfile(ctx, request, func(preservedProfileInspection) error { calls++; return nil })
			if err == nil || calls != 0 {
				t.Fatal("changed independent selection reached the discovery visitor", changed, err, calls)
			}
			if !reflect.DeepEqual(request, wantInput) {
				t.Error("refused discovery changed caller input")
			}
		})
	}
}

func TestPreservedProfileDiscoveryNativeHeldClaimsRefuseWithoutEffects(t *testing.T) {
	for _, name := range preservedProfileDiscoveryClaims {
		t.Run(name, func(t *testing.T) {
			in, workspace := preservedProfileFixture(t, true, true)
			fd, err := unix.Open(filepath.Join(in.Profile.Root, name), unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if err := unix.Close(fd); err != nil {
					t.Error("held fixture claim close unknown", err)
				}
			})
			if err := unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB); err != nil {
				t.Fatal("fixture could not retain its selected claim", err)
			}
			snapshotPreservedProfileDiscoveryCustody(t, in, workspace)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			calls := 0
			err = discoverPreservedProfile(ctx, preservedProfileDiscoveryRequest(in), func(preservedProfileInspection) error { calls++; return nil })
			if err == nil || calls != 0 {
				t.Fatal("held original claim became a partial observation", name, err, calls)
			}
		})
	}
}

func TestPreservedProfileDiscoveryNativeVisitorFailureRetainsPriorArchiveAndUnknown(t *testing.T) {
	in, workspace := preservedProfileFixture(t, true, true)
	prior := filepath.Join(in.Profile.Root, "chat-retired-"+freshEmptyRecoveryFixtureUUID(t))
	if err := os.Mkdir(prior, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(prior, "retained.unknown"), []byte("UNKNOWN"), 0600); err != nil {
		t.Fatal(err)
	}
	snapshotPreservedProfileDiscoveryCustody(t, in, workspace)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	calls := 0
	visitorErr := errors.New("trusted discovery visitor refused")
	err := discoverPreservedProfile(ctx, preservedProfileDiscoveryRequest(in), func(v preservedProfileInspection) error {
		calls++
		if !v.Results.Unresolved || !v.Plan.RetainsUnresolvedResults {
			t.Error("visitor did not observe the original unresolved results")
		}
		return visitorErr
	})
	// The established access boundary classifies callback errors. Preserve its
	// failed outcome without claiming sentinel identity or recovery permission.
	if err == nil || calls != 1 {
		t.Fatal("failed discovery visitor became successful observation", err, calls)
	}
}
