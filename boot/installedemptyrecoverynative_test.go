//go:build darwin

package boot

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	mutationrepo "github.com/legrch/farol/modules/computer/infra/repos/mutation"
)

// Disposable native consumed-empty chain. Removing exact fixture-owned records
// models a journal that was always empty; this is never a recovery action.
func installedEmptyRecoveryFixture(t *testing.T) emptyRecoveryInspectionInput {
	t.Helper()
	in := emptyRecoveryFixtureNamed(t, true, false, "io.github.legrch.farol")
	for _, expected := range in.Mutations {
		if err := os.Remove(filepath.Join(in.Profile.Root, "computer", "mutations", expected.Key)); err != nil {
			t.Fatal(err)
		}
	}
	in.Mutations = []mutationrepo.ExpectedSettledRecord{}
	in.InstalledEmpty = true
	return in
}

func TestNativeInstalledEmptyRecoveryRetainsAllClaimsAndOriginalBytes(t *testing.T) {
	in := installedEmptyRecoveryFixture(t)
	original := filepath.Join(in.Profile.Root, "chat", "chat-lifecycle.json")
	before, err := os.ReadFile(original)
	if err != nil {
		t.Fatal(err)
	}
	sentinel := errors.New("visitor sentinel")
	visits := 0
	err = inspectEmptyRecovery(context.Background(), in, func(v emptyRecoveryInspection) error {
		visits++
		if v.EmptyRetained == nil || v.InterruptedRetained != nil || v.Retained != (mutationrepo.SettledInspection{}) || v.HandoffSteps != 4 {
			t.Fatal("wrong inspection scope", v.EmptyRetained != nil, v.InterruptedRetained != nil, len(v.Retained.Retained), v.HandoffSteps)
		}
		if writer, err := mutationrepo.New(context.Background(), mutationrepo.Root{Path: v.Computer.Path, Device: v.Computer.Device, Inode: v.Computer.Inode, OwnerUID: v.Computer.OwnerUID}); err == nil {
			writer.Close()
			t.Fatal("mutation claim not retained")
		}
		return sentinel
	})
	if visits != 1 || err == nil || err.Error() != "COMPUTER_ACCESS_INSPECTION_CALLBACK_REFUSED" {
		t.Fatal(visits, err)
	}
	after, err := os.ReadFile(original)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("original lifecycle changed", err)
	}
}

func TestNativeInstalledEmptyRecoveryRefusesScopeStateAndLateChanges(t *testing.T) {
	for _, fault := range []string{"dev-mode", "unacknowledged", "interrupted", "mutation-selection", "mutation-entry", "task-entry", "stale-head", "stale-lifecycle", "reused-generation", "late-mutation"} {
		t.Run(fault, func(t *testing.T) {
			in := installedEmptyRecoveryFixture(t)
			switch fault {
			case "dev-mode":
				in.InstalledEmpty = false
			case "unacknowledged":
				in.UnacknowledgedDev = true
			case "interrupted":
				in.Interrupted = &interruptedRetirementInput{}
			case "mutation-selection":
				in.Mutations = []mutationrepo.ExpectedSettledRecord{{Key: "unqualified"}}
			case "mutation-entry":
				if err := os.WriteFile(filepath.Join(in.Profile.Root, "computer", "mutations", "unexpected"), []byte("retained"), 0600); err != nil {
					t.Fatal(err)
				}
			case "task-entry":
				if err := os.WriteFile(filepath.Join(in.Profile.Root, "task", "unexpected"), []byte("retained"), 0600); err != nil {
					t.Fatal(err)
				}
			case "stale-head":
				in.Selection.HeadDigest[0]++
			case "stale-lifecycle":
				in.Selection.LifecycleDigest[0]++
			case "reused-generation":
				in.Selection.Next.BackendGeneration = "generation-1"
			}
			calls := 0
			err := inspectEmptyRecovery(context.Background(), in, func(v emptyRecoveryInspection) error {
				calls++
				if fault == "late-mutation" {
					entry := filepath.Join(v.Computer.Path, "mutations", "late")
					if err := os.WriteFile(entry, []byte("retained"), 0600); err != nil {
						t.Fatal(err)
					}
					if err := os.Remove(entry); err != nil {
						t.Fatal(err)
					}
				}
				return nil
			})
			if err == nil || fault != "late-mutation" && calls != 0 {
				t.Fatal("unsafe state admitted", calls, err)
			}
		})
	}
}

func TestNativeInstalledEmptyPreparationRequiresItsOwnModeAndOriginalACK(t *testing.T) {
	for _, wrong := range []bool{false, true} {
		t.Run(strconv.FormatBool(wrong), func(t *testing.T) {
			in := installedEmptyRecoveryFixture(t)
			profile := in.Profile
			in.Profile = ProfileBinding{}
			raw, err := json.Marshal(in)
			if err != nil {
				t.Fatal(err)
			}
			args := []string{"--profile", profile.ProfileID, "--profile-root", profile.Root, "--profile-device", strconv.FormatUint(profile.Device, 10), "--profile-inode", strconv.FormatUint(profile.Inode, 10), "--expected-build", BuildID}
			var diagnostics bytes.Buffer
			dev := &emptyRecoveryCommandPeer{input: bytes.NewReader(append(raw, '\n'))}
			if code := runEmptyRecoveryPreparation(args, dev, dev, &diagnostics); code != 2 || dev.publications != 0 {
				t.Fatal("Dev mode crossed installed boundary", code)
			}
			peer := &emptyRecoveryCommandPeer{input: bytes.NewReader(append(raw, '\n')), wrong: wrong}
			code := runInstalledEmptyRecoveryPreparation(args, peer, peer, &diagnostics)
			if peer.publications != 1 || !wrong && code != 0 || wrong && code != 1 {
				t.Fatal(code, peer.publications, diagnostics.String())
			}
			if err := refusePendingEmptyRecovery(profile); err == nil {
				t.Fatal("child result cleared host fence")
			}
		})
	}
}
