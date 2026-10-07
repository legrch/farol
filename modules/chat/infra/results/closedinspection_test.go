package results

import (
	"context"
	"errors"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
)

func TestClosedInspectionPureResultsEmptyIdentity(t *testing.T) {
	root := Root{ProfileID: "profile", Identity: port.JournalRoot{Device: 1, Inode: 2, OwnerUID: 501}}
	store := port.JournalRoot{Device: 1, Inode: 3, OwnerUID: 501}
	scope := port.JournalScope{ProfileID: "profile", BackendGeneration: "backend"}
	digest := [32]byte{1}
	for _, kind := range []string{"empty", "nonempty", "other-profile", "other-scope", "invalid-scope", "device", "same-inode", "owner", "missing-digest"} {
		t.Run(kind, func(t *testing.T) {
			r, s, c, d := root, store, scope, digest
			var keys []string
			switch kind {
			case "nonempty":
				keys = []string{"one-retained-result"}
			case "other-profile":
				r.ProfileID = "other"
			case "other-scope":
				c.ProfileID = "other"
			case "invalid-scope":
				c.BackendGeneration = "bad scope"
			case "device":
				s.Device++
			case "same-inode":
				s.Inode = r.Identity.Inode
			case "owner":
				s.OwnerUID++
			case "missing-digest":
				d = [32]byte{}
			}
			got, err := closedInspectionMetadata(r, c, s, d, keys)
			if kind == "empty" {
				if err != nil || got.Root != root.Identity || got.StorageRoot != store || got.Scope != scope || got.ClaimDigest != digest || got.ResultCount != 0 {
					t.Fatal("empty result metadata differs", got, err)
				}
				if _, ok := any(got).(port.DurableResults); ok {
					t.Fatal("diagnostic supplies result authority")
				}
			} else if !errors.Is(err, Refused) {
				t.Fatal("invalid/nonempty namespace accepted", err)
			}
		})
	}
}

func TestClosedInspectionPureResultsCallbackAndInput(t *testing.T) {
	callbackErr := errors.New("caller stopped")
	for _, kind := range []string{"success", "callback-error", "recheck-error", "cancelled-before", "cancelled-during"} {
		t.Run(kind, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if kind == "cancelled-before" {
				cancel()
			}
			order := ""
			err := closedInspectionCallback(ctx, ClosedInspection{}, func() error {
				order += "recheck"
				if kind == "recheck-error" {
					return Refused
				}
				return nil
			}, func(ClosedInspection) error {
				order += "callback/"
				if kind == "cancelled-during" {
					cancel()
				}
				if kind == "callback-error" || kind == "recheck-error" {
					return callbackErr
				}
				return nil
			})
			var want error
			switch kind {
			case "callback-error":
				want = callbackErr
			case "recheck-error":
				want = Refused
			case "cancelled-before", "cancelled-during":
				want = Unavailable
			}
			if !errors.Is(err, want) || kind == "cancelled-before" && order != "" || kind != "cancelled-before" && order != "callback/recheck" {
				t.Fatal("callback/recheck contract differs", order, err)
			}
		})
	}
	if err := WithClosedInspection(nil, Root{}, port.JournalScope{}, nil); !errors.Is(err, Invalid) {
		t.Fatal("invalid input accepted", err)
	}
}
