package preservedrecovery_test

import (
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/app/services/preservedrecovery"
)

// Synthetic metadata establishes pure selection behavior only. These values
// attest no canonical files, original process closure, custody or live authority.
func fixture() (port.PreservedRecoverySelection, port.PreservedRecoveryObservation) {
	s := port.PreservedRecoverySelection{
		OperationID: "abcdef01-2345-6789-abcd-0123456789ef",
		Current: port.PreservedRecoveryBinding{
			Scope:      port.JournalScope{ProfileID: "profile", BackendGeneration: "current"},
			ParentRoot: port.JournalRoot{Device: 1, Inode: 10, OwnerUID: 501},
			ChatRoot:   port.JournalRoot{Device: 1, Inode: 11, OwnerUID: 501},
		},
		Next:    port.JournalScope{ProfileID: "profile", BackendGeneration: "next"},
		BuildID: "maintenance-build", HostLifetimeID: "maintenance-host", ChildLaunchID: "maintenance-child",
		LifecycleDigest: [32]byte{1}, ResultsDigest: [32]byte{2},
	}
	o := port.PreservedRecoveryObservation{
		Scope: s.Current.Scope, ParentRoot: s.Current.ParentRoot, ChatRoot: s.Current.ChatRoot,
		ResultsRoot: s.Current.ChatRoot, ResultsStorageRoot: port.JournalRoot{Device: 1, Inode: 12, OwnerUID: 501},
		LifecycleDigest: s.LifecycleDigest, ResultsDigest: s.ResultsDigest,
		WriteCount: 1, Incarnations: []string{"z-original", "a-prior", "current"},
	}
	return s, o
}

func requirePlan(t *testing.T, s port.PreservedRecoverySelection, o port.PreservedRecoveryObservation) *port.PreservedRecoveryPlan {
	t.Helper()
	p, err := preservedrecovery.Select(s, o)
	want := port.PreservedRecoveryPlan{Selection: s, ArchiveName: "chat-retired-" + s.OperationID, RetainsUnresolvedResults: o.ResultsUnresolved}
	if err != nil || p == nil {
		t.Fatalf("selection refused: plan=%+v error=%v", p, err)
	}
	if *p != want {
		t.Fatalf("plan=%+v, want %+v", *p, want)
	}
	return p
}

func requireRefusal(t *testing.T, s port.PreservedRecoverySelection, o port.PreservedRecoveryObservation) {
	t.Helper()
	p, err := preservedrecovery.Select(s, o)
	if p != nil || err != preservedrecovery.Refused {
		t.Fatalf("unsafe metadata selected: plan=%+v error=%v", p, err)
	}
	if err.Error() != "CHAT_PRESERVED_RECOVERY_REFUSED" {
		t.Fatalf("unexpected classified error: %v", err)
	}
}

func TestNonemptySelection(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(*port.PreservedRecoverySelection, *port.PreservedRecoveryObservation)
	}{
		{"initial handoff", func(_ *port.PreservedRecoverySelection, _ *port.PreservedRecoveryObservation) {}},
		{"one handoff step", func(s *port.PreservedRecoverySelection, o *port.PreservedRecoveryObservation) {
			s.HandoffDigest = [32]byte{3}
			o.HandoffDigest = s.HandoffDigest
			o.HandoffSteps = 1
		}},
		{"handoff step bound", func(s *port.PreservedRecoverySelection, o *port.PreservedRecoveryObservation) {
			s.HandoffDigest = [32]byte{3}
			o.HandoffDigest = s.HandoffDigest
			o.HandoffSteps = 1024
		}},
		{"turn only", func(_ *port.PreservedRecoverySelection, o *port.PreservedRecoveryObservation) {
			o.WriteCount = 0
			o.TurnCount = 1
		}},
		{"plan only", func(_ *port.PreservedRecoverySelection, o *port.PreservedRecoveryObservation) {
			o.WriteCount = 0
			o.PlanCount = 1
		}},
		{"result only", func(_ *port.PreservedRecoverySelection, o *port.PreservedRecoveryObservation) {
			o.WriteCount = 0
			o.ResultCount = 1
		}},
		{"unresolved only", func(_ *port.PreservedRecoverySelection, o *port.PreservedRecoveryObservation) {
			o.WriteCount = 0
			o.ResultsUnresolved = true
		}},
		{"recorded retirement", func(_ *port.PreservedRecoverySelection, o *port.PreservedRecoveryObservation) {
			o.RetirementPresent = true
		}},
		{"retirement with unresolved only", func(_ *port.PreservedRecoverySelection, o *port.PreservedRecoveryObservation) {
			o.WriteCount = 0
			o.RetirementPresent = true
			o.ResultsUnresolved = true
		}},
		{"all count bounds", func(_ *port.PreservedRecoverySelection, o *port.PreservedRecoveryObservation) {
			o.WriteCount = 4096
			o.TurnCount = 4096
			o.PlanCount = 4096
			o.ResultCount = 4096
		}},
		{"single incarnation", func(_ *port.PreservedRecoverySelection, o *port.PreservedRecoveryObservation) {
			o.Incarnations = []string{"current"}
		}},
		{"incarnation bound", func(_ *port.PreservedRecoverySelection, o *port.PreservedRecoveryObservation) {
			o.Incarnations = history(4096)
		}},
		{"results storage equals parent", func(s *port.PreservedRecoverySelection, o *port.PreservedRecoveryObservation) {
			o.ResultsStorageRoot = s.Current.ParentRoot
		}},
		{"root uid zero", func(s *port.PreservedRecoverySelection, o *port.PreservedRecoveryObservation) {
			s.Current.ParentRoot.OwnerUID = 0
			s.Current.ChatRoot.OwnerUID = 0
			o.ParentRoot = s.Current.ParentRoot
			o.ChatRoot = s.Current.ChatRoot
			o.ResultsRoot = s.Current.ChatRoot
			o.ResultsStorageRoot.OwnerUID = 0
		}},
		{"uuid spelling without version restriction", func(s *port.PreservedRecoverySelection, _ *port.PreservedRecoveryObservation) {
			s.OperationID = "00000000-0000-0000-0000-000000000000"
		}},
		{"future lifetimes are only identifiers", func(s *port.PreservedRecoverySelection, _ *port.PreservedRecoveryObservation) {
			s.BuildID = "current"
			s.HostLifetimeID = "current"
			s.ChildLaunchID = "current"
		}},
	} {
		t.Run(tc.name, func(t *testing.T) { s, o := fixture(); tc.change(&s, &o); requirePlan(t, s, o) })
	}
}

func history(n int) []string {
	ids := make([]string, n)
	for i := range ids {
		ids[i] = fmt.Sprintf("generation-%d", i)
	}
	ids[n-1] = "current"
	return ids
}

func TestSelectionRefusesCrossedMetadata(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(*port.PreservedRecoverySelection, *port.PreservedRecoveryObservation)
	}{
		{"next profile", func(s *port.PreservedRecoverySelection, _ *port.PreservedRecoveryObservation) {
			s.Next.ProfileID = "other"
		}},
		{"observed profile", func(_ *port.PreservedRecoverySelection, o *port.PreservedRecoveryObservation) {
			o.Scope.ProfileID = "other"
		}},
		{"observed generation", func(_ *port.PreservedRecoverySelection, o *port.PreservedRecoveryObservation) {
			o.Scope.BackendGeneration = "other"
		}},
		{"current reused", func(s *port.PreservedRecoverySelection, _ *port.PreservedRecoveryObservation) {
			s.Next.BackendGeneration = "current"
		}},
		{"earliest generation reused", func(s *port.PreservedRecoverySelection, _ *port.PreservedRecoveryObservation) {
			s.Next.BackendGeneration = "z-original"
		}},
		{"middle generation reused", func(s *port.PreservedRecoverySelection, _ *port.PreservedRecoveryObservation) {
			s.Next.BackendGeneration = "a-prior"
		}},
		{"nil incarnations", func(_ *port.PreservedRecoverySelection, o *port.PreservedRecoveryObservation) { o.Incarnations = nil }},
		{"empty incarnations", func(_ *port.PreservedRecoverySelection, o *port.PreservedRecoveryObservation) {
			o.Incarnations = []string{}
		}},
		{"too many incarnations", func(_ *port.PreservedRecoverySelection, o *port.PreservedRecoveryObservation) {
			o.Incarnations = history(4097)
		}},
		{"duplicate prior generation", func(_ *port.PreservedRecoverySelection, o *port.PreservedRecoveryObservation) {
			o.Incarnations = []string{"prior", "prior", "current"}
		}},
		{"duplicate current", func(_ *port.PreservedRecoverySelection, o *port.PreservedRecoveryObservation) {
			o.Incarnations = []string{"current", "current"}
		}},
		{"missing current", func(_ *port.PreservedRecoverySelection, o *port.PreservedRecoveryObservation) {
			o.Incarnations = []string{"prior"}
		}},
		{"current not last", func(_ *port.PreservedRecoverySelection, o *port.PreservedRecoveryObservation) {
			o.Incarnations = []string{"current", "prior"}
		}},
		{"zero lifecycle digest", func(s *port.PreservedRecoverySelection, o *port.PreservedRecoveryObservation) {
			s.LifecycleDigest = [32]byte{}
			o.LifecycleDigest = [32]byte{}
		}},
		{"zero results digest", func(s *port.PreservedRecoverySelection, o *port.PreservedRecoveryObservation) {
			s.ResultsDigest = [32]byte{}
			o.ResultsDigest = [32]byte{}
		}},
		{"changed lifecycle observation", func(_ *port.PreservedRecoverySelection, o *port.PreservedRecoveryObservation) {
			o.LifecycleDigest[31]++
		}},
		{"changed lifecycle selection", func(s *port.PreservedRecoverySelection, _ *port.PreservedRecoveryObservation) {
			s.LifecycleDigest[31]++
		}},
		{"changed results observation", func(_ *port.PreservedRecoverySelection, o *port.PreservedRecoveryObservation) { o.ResultsDigest[31]++ }},
		{"changed results selection", func(s *port.PreservedRecoverySelection, _ *port.PreservedRecoveryObservation) { s.ResultsDigest[31]++ }},
		{"changed initial handoff observation", func(_ *port.PreservedRecoverySelection, o *port.PreservedRecoveryObservation) { o.HandoffDigest[31]++ }},
		{"changed handoff selection", func(s *port.PreservedRecoverySelection, _ *port.PreservedRecoveryObservation) { s.HandoffDigest[31]++ }},
		{"changed nonempty handoff", func(s *port.PreservedRecoverySelection, o *port.PreservedRecoveryObservation) {
			s.HandoffDigest[0] = 3
			o.HandoffDigest[0] = 4
			o.HandoffSteps = 1
		}},
		{"initial handoff with digest", func(s *port.PreservedRecoverySelection, o *port.PreservedRecoveryObservation) {
			s.HandoffDigest[0] = 3
			o.HandoffDigest = s.HandoffDigest
		}},
		{"nonempty handoff without digest", func(_ *port.PreservedRecoverySelection, o *port.PreservedRecoveryObservation) { o.HandoffSteps = 1 }},
		{"negative handoff steps", func(_ *port.PreservedRecoverySelection, o *port.PreservedRecoveryObservation) { o.HandoffSteps = -1 }},
		{"too many handoff steps", func(s *port.PreservedRecoverySelection, o *port.PreservedRecoveryObservation) {
			s.HandoffDigest[0] = 3
			o.HandoffDigest = s.HandoffDigest
			o.HandoffSteps = 1025
		}},
	} {
		t.Run(tc.name, func(t *testing.T) { s, o := fixture(); tc.change(&s, &o); requireRefusal(t, s, o) })
	}
}

func TestExactRootComparisons(t *testing.T) {
	// Every projected component must match, even if another component identifies
	// the same object. Native identity qualification is outside this pure test.
	for _, projected := range []struct {
		name string
		root func(*port.PreservedRecoveryObservation) *port.JournalRoot
	}{
		{"parent", func(o *port.PreservedRecoveryObservation) *port.JournalRoot { return &o.ParentRoot }},
		{"chat", func(o *port.PreservedRecoveryObservation) *port.JournalRoot { return &o.ChatRoot }},
		{"results", func(o *port.PreservedRecoveryObservation) *port.JournalRoot { return &o.ResultsRoot }},
	} {
		for _, component := range []string{"device", "inode", "owner"} {
			t.Run(projected.name+"/"+component, func(t *testing.T) {
				s, o := fixture()
				r := projected.root(&o)
				switch component {
				case "device":
					r.Device++
				case "inode":
					r.Inode++
				case "owner":
					r.OwnerUID++
				}
				requireRefusal(t, s, o)
			})
		}
	}
	for _, tc := range []struct {
		name   string
		change func(*port.PreservedRecoverySelection, *port.PreservedRecoveryObservation)
	}{
		{"parent zero device", func(s *port.PreservedRecoverySelection, o *port.PreservedRecoveryObservation) {
			s.Current.ParentRoot.Device = 0
			o.ParentRoot = s.Current.ParentRoot
		}},
		{"parent zero inode", func(s *port.PreservedRecoverySelection, o *port.PreservedRecoveryObservation) {
			s.Current.ParentRoot.Inode = 0
			o.ParentRoot = s.Current.ParentRoot
		}},
		{"chat zero device", func(s *port.PreservedRecoverySelection, o *port.PreservedRecoveryObservation) {
			s.Current.ChatRoot.Device = 0
			o.ChatRoot = s.Current.ChatRoot
			o.ResultsRoot = s.Current.ChatRoot
		}},
		{"chat zero inode", func(s *port.PreservedRecoverySelection, o *port.PreservedRecoveryObservation) {
			s.Current.ChatRoot.Inode = 0
			o.ChatRoot = s.Current.ChatRoot
			o.ResultsRoot = s.Current.ChatRoot
		}},
		{"parent chat same object", func(s *port.PreservedRecoverySelection, o *port.PreservedRecoveryObservation) {
			s.Current.ParentRoot = s.Current.ChatRoot
			o.ParentRoot = s.Current.ParentRoot
		}},
		{"parent chat devices", func(s *port.PreservedRecoverySelection, o *port.PreservedRecoveryObservation) {
			s.Current.ParentRoot.Device++
			o.ParentRoot = s.Current.ParentRoot
		}},
		{"parent chat owners", func(s *port.PreservedRecoverySelection, o *port.PreservedRecoveryObservation) {
			s.Current.ParentRoot.OwnerUID++
			o.ParentRoot = s.Current.ParentRoot
		}},
		{"same parent chat object crossed owner", func(s *port.PreservedRecoverySelection, o *port.PreservedRecoveryObservation) {
			s.Current.ParentRoot = s.Current.ChatRoot
			s.Current.ParentRoot.OwnerUID++
			o.ParentRoot = s.Current.ParentRoot
		}},
		{"storage zero device", func(_ *port.PreservedRecoverySelection, o *port.PreservedRecoveryObservation) {
			o.ResultsStorageRoot.Device = 0
		}},
		{"storage zero inode", func(_ *port.PreservedRecoverySelection, o *port.PreservedRecoveryObservation) {
			o.ResultsStorageRoot.Inode = 0
		}},
		{"storage device", func(_ *port.PreservedRecoverySelection, o *port.PreservedRecoveryObservation) {
			o.ResultsStorageRoot.Device++
		}},
		{"storage owner", func(_ *port.PreservedRecoverySelection, o *port.PreservedRecoveryObservation) {
			o.ResultsStorageRoot.OwnerUID++
		}},
		{"storage aliases chat", func(_ *port.PreservedRecoverySelection, o *port.PreservedRecoveryObservation) {
			o.ResultsStorageRoot = o.ChatRoot
		}},
		{"storage aliases chat crossed owner", func(_ *port.PreservedRecoverySelection, o *port.PreservedRecoveryObservation) {
			o.ResultsStorageRoot = o.ChatRoot
			o.ResultsStorageRoot.OwnerUID++
		}},
	} {
		t.Run(tc.name, func(t *testing.T) { s, o := fixture(); tc.change(&s, &o); requireRefusal(t, s, o) })
	}
}

func TestCountBoundsAndEmptyRefusal(t *testing.T) {
	maxInt := int(^uint(0) >> 1)
	for _, field := range []struct {
		name string
		set  func(*port.PreservedRecoveryObservation, int)
	}{
		{"writes", func(o *port.PreservedRecoveryObservation, n int) { o.WriteCount = n }},
		{"turns", func(o *port.PreservedRecoveryObservation, n int) { o.TurnCount = n }},
		{"plans", func(o *port.PreservedRecoveryObservation, n int) { o.PlanCount = n }},
		{"results", func(o *port.PreservedRecoveryObservation, n int) { o.ResultCount = n }},
	} {
		for _, n := range []int{-1, 4097, maxInt, -maxInt - 1} {
			t.Run(fmt.Sprintf("%s/%d", field.name, n), func(t *testing.T) {
				s, o := fixture()
				o.ResultsUnresolved = true
				field.set(&o, n)
				requireRefusal(t, s, o)
			})
		}
	}
	for _, retired := range []bool{false, true} {
		t.Run(fmt.Sprintf("empty/retirement=%v", retired), func(t *testing.T) {
			s, o := fixture()
			o.WriteCount = 0
			o.RetirementPresent = retired
			requireRefusal(t, s, o)
		})
	}
	t.Run("overflowing counts with unresolved results", func(t *testing.T) {
		s, o := fixture()
		o.WriteCount = maxInt
		o.TurnCount = maxInt
		o.PlanCount = maxInt
		o.ResultCount = maxInt
		o.ResultsUnresolved = true
		requireRefusal(t, s, o)
	})
}

func TestIdentifierPolicy(t *testing.T) {
	fields := []struct {
		name string
		set  func(*port.PreservedRecoverySelection, *port.PreservedRecoveryObservation, string)
	}{
		{"current profile", func(s *port.PreservedRecoverySelection, o *port.PreservedRecoveryObservation, v string) {
			s.Current.Scope.ProfileID = v
			s.Next.ProfileID = v
			o.Scope.ProfileID = v
		}},
		{"current generation", func(s *port.PreservedRecoverySelection, o *port.PreservedRecoveryObservation, v string) {
			s.Current.Scope.BackendGeneration = v
			o.Scope.BackendGeneration = v
			o.Incarnations[len(o.Incarnations)-1] = v
		}},
		{"next profile", func(s *port.PreservedRecoverySelection, _ *port.PreservedRecoveryObservation, v string) {
			s.Next.ProfileID = v
		}},
		{"next generation", func(s *port.PreservedRecoverySelection, _ *port.PreservedRecoveryObservation, v string) {
			s.Next.BackendGeneration = v
		}},
		{"build", func(s *port.PreservedRecoverySelection, _ *port.PreservedRecoveryObservation, v string) {
			s.BuildID = v
		}},
		{"host", func(s *port.PreservedRecoverySelection, _ *port.PreservedRecoveryObservation, v string) {
			s.HostLifetimeID = v
		}},
		{"child", func(s *port.PreservedRecoverySelection, _ *port.PreservedRecoveryObservation, v string) {
			s.ChildLaunchID = v
		}},
		{"prior incarnation", func(_ *port.PreservedRecoverySelection, o *port.PreservedRecoveryObservation, v string) {
			o.Incarnations[0] = v
		}},
	}
	invalid := []string{"", "\xff", "a b", "a\x00b", "a\x1fb", "a\x7fb", strings.Repeat("a", 121), strings.Repeat("é", 61)}
	for control := 0; control <= 32; control++ {
		invalid = append(invalid, "a"+string(rune(control))+"b")
	}
	for _, field := range fields {
		for i, value := range invalid {
			t.Run(fmt.Sprintf("%s/refuse-%d", field.name, i), func(t *testing.T) { s, o := fixture(); field.set(&s, &o, value); requireRefusal(t, s, o) })
		}
		if field.name == "next profile" {
			continue
		} // Its valid value must also equal Current.
		for _, value := range []string{strings.Repeat("a", 120), strings.Repeat("é", 60), "世代🚢", "a\u0085b"} {
			t.Run(field.name+"/accept-"+value, func(t *testing.T) { s, o := fixture(); field.set(&s, &o, value); requirePlan(t, s, o) })
		}
	}
}

func TestOperationUUIDSpelling(t *testing.T) {
	for _, value := range []string{
		"", "../chat", "ABCDEF01-2345-6789-abcd-0123456789ef",
		"abcdef0123456789abcd0123456789ef", "abcdef01_2345-6789-abcd-0123456789ef",
		"abcdef01-2345-6789-abcd-0123456789eg", "abcdef01-2345-6789-abcd-0123456789ef/",
		"abcdef01-2345-6789-abcd-0123456789é", "abcdef01-2345-6789-abcd-0123456789e\xff",
		"abcdef01-2345-6789-abcd-0123456789e\n", "-bcdef01-2345-6789-abcd-0123456789ef",
		"abcdef0-12345-6789-abcd-0123456789ef",
	} {
		t.Run(fmt.Sprintf("%q", value), func(t *testing.T) { s, o := fixture(); s.OperationID = value; requireRefusal(t, s, o) })
	}
	for _, position := range []int{8, 13, 18, 23} {
		t.Run(fmt.Sprintf("hyphen-%d", position), func(t *testing.T) {
			s, o := fixture()
			v := []byte(s.OperationID)
			v[position] = 'a'
			s.OperationID = string(v)
			requireRefusal(t, s, o)
		})
	}
}

func TestSelectionOwnsReturnedValuesAndNeverMutatesHistory(t *testing.T) {
	for _, refused := range []bool{false, true} {
		t.Run(fmt.Sprintf("refused=%v", refused), func(t *testing.T) {
			s, o := fixture()
			if refused {
				o.Incarnations = append(o.Incarnations[:2], "a-prior", "current")
			}
			before := append([]string(nil), o.Incarnations...)
			if refused {
				requireRefusal(t, s, o)
			} else {
				requirePlan(t, s, o)
			}
			if !reflect.DeepEqual(o.Incarnations, before) {
				t.Fatalf("caller history changed: %v -> %v", before, o.Incarnations)
			}
		})
	}
	s, o := fixture()
	o.RetirementPresent = true
	o.ResultsUnresolved = true
	original := s
	p := requirePlan(t, s, o)
	want := *p
	s.Current.Scope.ProfileID = "changed-input"
	s.LifecycleDigest[0]++
	o.Incarnations[0] = "changed-history"
	o.ResultsUnresolved = false
	o.RetirementPresent = false
	if *p != want {
		t.Fatalf("input changes reached plan: %+v", p)
	}
	p.Selection.Current.ChatRoot.Inode++
	p.Selection.ResultsDigest[0]++
	p.RetainsUnresolvedResults = false
	p.ArchiveName = "changed-plan"
	freshS, freshO := fixture()
	freshO.ResultsUnresolved = true
	fresh := requirePlan(t, freshS, freshO)
	if fresh.Selection != original || *fresh != want {
		t.Fatalf("returned values shared state: %+v", fresh)
	}
}
