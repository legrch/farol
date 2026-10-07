//go:build darwin

package boot

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"

	wire "github.com/legrch/farol/gen/desktop/v1"
	chatport "github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/app/services/handoff"
	handoffrepo "github.com/legrch/farol/modules/chat/infra/repos/handoff"
	lifecyclerepo "github.com/legrch/farol/modules/chat/infra/repos/lifecycle"
	"github.com/legrch/farol/modules/chat/infra/results"
	accessrepo "github.com/legrch/farol/modules/computer/infra/repos/access"
	mutationrepo "github.com/legrch/farol/modules/computer/infra/repos/mutation"
	"github.com/legrch/farol/pkg/ipc"
	"golang.org/x/sys/unix"
)

type preparedEmptyInspectionInput struct {
	Original      emptyRecoveryInspectionInput
	PendingSHA    [32]byte
	OriginalSteps int
}

// All fields are private-command diagnostics. Acknowledgement formats the
// current canonical ACK head only; it cannot replace the initiating host's
// separately pinned original acknowledgement, child terminal or drain witness.
type preparedEmptyInspection struct {
	Schema          string                          `json:"schema"`
	ObserverBuildID string                          `json:"observerBuildId"`
	ProfileID       string                          `json:"profileId"`
	Publication     chatport.HandoffPublication     `json:"publication"`
	Acknowledgement wire.CoreRetirementAcknowledged `json:"acknowledgement"`
	LifecycleSHA    string                          `json:"lifecycleSHA"`
	ArchiveDigest   string                          `json:"archiveInventoryDigest"`
	NewChatRoot     chatport.JournalRoot            `json:"newChatRoot"`
}

func preparedEmptyInputValid(in preparedEmptyInspectionInput) bool {
	o, s := in.Original, in.Original.Selection
	b := s.Current
	id := s.OperationID
	if len(id) != 36 || id[8] != '-' || id[13] != '-' || id[18] != '-' || id[23] != '-' {
		return false
	}
	compact := strings.ReplaceAll(id, "-", "")
	decoded, err := hex.DecodeString(compact)
	if err != nil || len(decoded) != 16 || hex.EncodeToString(decoded) != compact {
		return false
	}
	for _, id := range []string{o.OwnerID, o.ComputerID, b.ProfileID, b.BackendGeneration, b.BuildID, b.HostLifetimeID, b.ChildLaunchID, s.Next.ProfileID, s.Next.BackendGeneration, s.BuildID, s.HostLifetimeID, s.ChildLaunchID} {
		if !validIngressID(id) {
			return false
		}
	}
	return validProfileBinding(o.Profile) && in.PendingSHA != ([32]byte{}) && in.OriginalSteps >= 1 && in.OriginalSteps <= 1024 && len(o.Mutations) == 2 && o.AccessDigest != ([32]byte{}) && s.HeadDigest != ([32]byte{}) && s.LifecycleDigest != ([32]byte{}) && b.ProfileID == o.Profile.ProfileID && b.ParentRoot.Device == o.Profile.Device && b.ParentRoot.Inode == o.Profile.Inode && b.ChatRoot.Device == b.ParentRoot.Device && b.ChatRoot.Inode != 0 && b.ChatRoot != b.ParentRoot && b.ChatRoot.OwnerUID == b.ParentRoot.OwnerUID && s.Next.ProfileID == b.ProfileID && s.Next.BackendGeneration != b.BackendGeneration && s.HostLifetimeID != b.HostLifetimeID && s.ChildLaunchID != b.ChildLaunchID
}

func preparedEmptyPendingMatches(raw []byte, in preparedEmptyInspectionInput) bool {
	if len(raw) < 2 || len(raw) > 65536 || sha256.Sum256(raw) != in.PendingSHA || ipc.ValidateJSON(raw) != nil || !emptyRecoveryCanonicalFields(raw, reflect.TypeFor[emptyRecoveryInspectionInput]()) {
		return false
	}
	var original emptyRecoveryInspectionInput
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(&original) != nil || d.Decode(new(any)) != io.EOF {
		return false
	}
	canonical, err := json.Marshal(original)
	expected, expectedErr := json.Marshal(in.Original)
	return err == nil && expectedErr == nil && bytes.Equal(raw, canonical) && bytes.Equal(raw, expected)
}

func inspectPreparedEmptyPending(in preparedEmptyInspectionInput) (value emptyRecoveryFile, resultErr error) {
	before, err := emptyRecoveryPendingFile(in.Original.Profile.Root)
	if err != nil || before.SHA256 != in.PendingSHA {
		return value, handoff.Refused
	}
	path := emptyRecoveryPendingPath(in.Original.Profile.Root)
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return value, handoff.Refused
	}
	f := os.NewFile(uintptr(fd), "prepared-empty-intent-inspection")
	defer func() { resultErr = errors.Join(resultErr, f.Close()) }()
	var a, b, named unix.Stat_t
	if unix.Fstat(fd, &a) != nil || uint32(a.Mode)&unix.S_IFMT != unix.S_IFREG || uint32(a.Mode) != before.Mode || uint64(a.Dev) != before.Device || a.Ino != before.Inode || a.Uid != before.OwnerUID || a.Nlink != 1 || a.Size < 2 || a.Size > 65536 {
		return value, handoff.Refused
	}
	raw, err := io.ReadAll(io.LimitReader(f, 65537))
	if err != nil || int64(len(raw)) != a.Size || unix.Fstat(fd, &b) != nil || unix.Lstat(path, &named) != nil || !sameEmptyRecoveryStat(a, b) || !sameEmptyRecoveryStat(b, named) || !preparedEmptyPendingMatches(raw, in) {
		return value, handoff.Refused
	}
	after, err := emptyRecoveryPendingFile(in.Original.Profile.Root)
	if err != nil || before != after {
		return value, handoff.Refused
	}
	return after, nil
}

func preparedEmptyChatNames(steps int) map[string]uint32 {
	names := map[string]uint32{"chat-lifecycle.claim": unix.S_IFREG, "chat-lifecycle.json": unix.S_IFREG, "chat-handoff.claim": unix.S_IFREG, "chat-results": unix.S_IFDIR}
	for n := 1; n <= steps; n++ {
		names[fmt.Sprintf("chat-handoff-%04d.attempt", n)] = unix.S_IFREG
		names[fmt.Sprintf("chat-handoff-%04d.commit", n)] = unix.S_IFREG
	}
	return names
}

func inspectPreparedEmptyArchive(ctx context.Context, in preparedEmptyInspectionInput, archive NativeRoot) (map[string]emptyRecoveryFile, error) {
	if err := inspectExactRecoveryDirectory(ctx, archive, preparedEmptyChatNames(in.OriginalSteps)); err != nil {
		return nil, err
	}
	files, err := emptyRecoveryArchiveFiles(ctx, archive)
	if err != nil {
		return nil, err
	}
	last := fmt.Sprintf("chat-handoff-%04d", in.OriginalSteps)
	selected := in.Original.Selection
	commit := hex.EncodeToString(selected.HeadDigest[:])
	if files[last+".attempt"].SHA256 != selected.HeadDigest || files[last+".commit"].SHA256 != sha256.Sum256([]byte(commit)) || files["chat-lifecycle.json"].SHA256 != selected.LifecycleDigest {
		return nil, handoff.Refused
	}
	records := make([]handoffrepo.ArchivedRecord, in.OriginalSteps)
	for index := 1; index <= in.OriginalSteps; index++ {
		name := fmt.Sprintf("chat-handoff-%04d", index)
		attempt, err := readPreparedEmptyArchiveRecord(filepath.Join(archive.Path, name+".attempt"), files[name+".attempt"])
		if err != nil {
			return nil, err
		}
		committed, err := readPreparedEmptyArchiveRecord(filepath.Join(archive.Path, name+".commit"), files[name+".commit"])
		if err != nil {
			return nil, err
		}
		records[index-1] = handoffrepo.ArchivedRecord{Attempt: attempt, Commit: string(committed)}
	}
	roots := handoffrepo.Roots{ProfileID: in.Original.Profile.ProfileID, Parent: handoffrepo.Root{Path: in.Original.Profile.Root, Identity: selected.Current.ParentRoot}, Chat: handoffrepo.Root{Path: archive.Path, Identity: selected.Current.ChatRoot}}
	if err := handoffrepo.ValidateArchivedEmptyRecords(ctx, roots, selected.Current, selected.HeadDigest, records); err != nil {
		return nil, err
	}
	// The archive's results namespace must still contain only its original claim.
	resultDir, ok := files["chat-results"]
	if !ok {
		return nil, handoff.Refused
	}
	root := NativeRoot{Path: filepath.Join(archive.Path, "chat-results"), Device: resultDir.Device, Inode: resultDir.Inode, OwnerUID: resultDir.OwnerUID, Mode: 0700}
	if err := inspectExactRecoveryDirectory(ctx, root, map[string]uint32{"chat-results.claim": unix.S_IFREG}); err != nil {
		return nil, err
	}
	return files, nil
}

func readPreparedEmptyArchiveRecord(path string, expected emptyRecoveryFile) (raw []byte, resultErr error) {
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, handoff.Refused
	}
	f := os.NewFile(uintptr(fd), "prepared-empty-archive-record")
	defer func() { resultErr = errors.Join(resultErr, f.Close()) }()
	var a, b, n unix.Stat_t
	if unix.Fstat(fd, &a) != nil || uint32(a.Mode)&unix.S_IFMT != unix.S_IFREG || uint32(a.Mode) != expected.Mode || uint64(a.Dev) != expected.Device || a.Ino != expected.Inode || a.Uid != expected.OwnerUID || a.Nlink != 1 || a.Size < 1 || a.Size > 16384 {
		return nil, handoff.Refused
	}
	raw, err = io.ReadAll(io.LimitReader(f, 16385))
	if err != nil || int64(len(raw)) != a.Size || sha256.Sum256(raw) != expected.SHA256 || unix.Fstat(fd, &b) != nil || unix.Lstat(path, &n) != nil || !sameEmptyRecoveryStat(a, b) || !sameEmptyRecoveryStat(b, n) {
		return nil, handoff.Refused
	}
	return raw, nil
}

func preparedEmptyObservation(in preparedEmptyInspectionInput, chat NativeRoot, head *chatport.HandoffHead, life *lifecyclerepo.Inspection, result results.ClosedInspection, files map[string]emptyRecoveryFile) (preparedEmptyInspection, error) {
	s := in.Original.Selection
	root := chatport.JournalRoot{Device: chat.Device, Inode: chat.Inode, OwnerUID: chat.OwnerUID}
	expected := chatport.HandoffBinding{ProfileID: in.Original.Profile.ProfileID, BackendGeneration: s.Next.BackendGeneration, BuildID: s.BuildID, HostLifetimeID: s.HostLifetimeID, ChildLaunchID: s.ChildLaunchID, ParentRoot: s.Current.ParentRoot, ChatRoot: root}
	if root == s.Current.ChatRoot || chat.ProfileID != expected.ProfileID || root.Device != expected.ParentRoot.Device || root.OwnerUID != expected.ParentRoot.OwnerUID || head == nil || head.Record == nil || !head.EmptyRetirementChain || head.Record.Stage != chatport.HandoffAcknowledged || head.Record.Publication.Binding != expected || head.Record.Publication.HandoffID != s.OperationID || handoff.ValidateRecord(*head.Record) != nil || life == nil {
		return preparedEmptyInspection{}, handoff.Refused
	}
	w := head.Record.Receipt.Write
	if life.Scope != s.Next || life.Root != root || life.WriteCount != 0 || life.TurnCount != 0 || len(life.Incarnations) != 1 || life.Incarnations[0] != s.Next.BackendGeneration || life.Retirement == nil || life.Retirement.TurnCount != 0 || life.Retirement.PreviousRevision != w.PreviousRevision || life.Retirement.Revision != w.Revision || life.SnapshotDigest != head.Record.Receipt.PublicationDigest || result.Scope != s.Next || result.Root != root || result.ResultCount != 0 || result.ClaimDigest == ([32]byte{}) || result.StorageRoot.Device != root.Device || result.StorageRoot.Inode == 0 || result.StorageRoot.OwnerUID != root.OwnerUID || result.StorageRoot == root {
		return preparedEmptyInspection{}, handoff.Refused
	}
	canonical, err := json.Marshal(*head.Record)
	if err != nil || sha256.Sum256(canonical) != head.Digest {
		return preparedEmptyInspection{}, handoff.Refused
	}
	raw, err := json.Marshal(files)
	if err != nil {
		return preparedEmptyInspection{}, handoff.Refused
	}
	digest := sha256.Sum256(raw)
	p := head.Record.Publication
	return preparedEmptyInspection{Schema: "farol-prepared-empty-inspection/1", ObserverBuildID: BuildID, ProfileID: expected.ProfileID, Publication: p, Acknowledgement: wire.CoreRetirementAcknowledged{HandoffId: p.HandoffID, ReceiptDigest: hex.EncodeToString(p.ReceiptDigest[:]), AckDigest: hex.EncodeToString(head.Digest[:])}, LifecycleSHA: hex.EncodeToString(life.SnapshotDigest[:]), ArchiveDigest: hex.EncodeToString(digest[:]), NewChatRoot: root}, nil
}

// Read-only prerequisite for one separately selected original partial operation.
// Lead owns the fixed Dev-root command fence, original SHA pin and host completion.
// Access, ACK, results and mutation claims span the visitor and final rechecks;
// lifecycle uses its existing retired-snapshot inspector with the same SHA before
// and after. No owner, reset, ACK, terminal, Consume or recovery effect is invoked.
func inspectPreparedEmptyRecovery(ctx context.Context, in preparedEmptyInspectionInput, visit func(preparedEmptyInspection) error) (resultErr error) {
	if ctx == nil || ctx.Err() != nil || visit == nil || !preparedEmptyInputValid(in) {
		return handoff.Refused
	}
	in.Original.Mutations = append([]mutationrepo.ExpectedSettledRecord(nil), in.Original.Mutations...)
	o := in.Original
	q, err := QualifyProfile(o.Profile)
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, q.Close()) }()
	computer, chat, err := q.Roots()
	task, taskErr := q.TaskRoot()
	if err != nil || taskErr != nil {
		return errors.Join(err, taskErr)
	}
	newRoot := chatport.JournalRoot{Device: chat.Device, Inode: chat.Inode, OwnerUID: chat.OwnerUID}
	if newRoot == o.Selection.Current.ChatRoot || newRoot.Device != o.Profile.Device || newRoot.OwnerUID != o.Selection.Current.ParentRoot.OwnerUID {
		return handoff.Refused
	}
	old := o.Selection.Current.ChatRoot
	archive := NativeRoot{Path: filepath.Join(o.Profile.Root, "chat-retired-"+o.Selection.OperationID), ProfileID: o.Profile.ProfileID, Device: old.Device, Inode: old.Inode, OwnerUID: old.OwnerUID, Mode: 0700}
	return withEmptyRecoveryTask(ctx, task, func() error {
		return accessrepo.WithClosedInspection(ctx, computer.Path, accessrepo.Binding{ProfileID: o.Profile.ProfileID, OwnerID: o.OwnerID, ComputerID: o.ComputerID}, o.AccessDigest, func(accessrepo.ClosedInspection) (resultErr error) {
			expected := chatport.HandoffBinding{ProfileID: o.Profile.ProfileID, BackendGeneration: o.Selection.Next.BackendGeneration, BuildID: o.Selection.BuildID, HostLifetimeID: o.Selection.HostLifetimeID, ChildLaunchID: o.Selection.ChildLaunchID, ParentRoot: o.Selection.Current.ParentRoot, ChatRoot: newRoot}
			h, err := handoffrepo.AcquireAcknowledgedInspection(ctx, handoffRoots(NativeLaunch{Profile: o.Profile}, chat), expected, o.Selection.OperationID)
			if err != nil {
				return err
			}
			defer func() { resultErr = errors.Join(resultErr, h.Close()) }()
			r, err := results.AcquireClosedInspection(ctx, results.Root{Path: chat.Path, ProfileID: chat.ProfileID, Identity: newRoot}, o.Selection.Next)
			if err != nil {
				return err
			}
			defer func() { resultErr = errors.Join(resultErr, r.Close()) }()
			pending, err := inspectPreparedEmptyPending(in)
			if err != nil {
				return err
			}
			files, err := inspectPreparedEmptyArchive(ctx, in, archive)
			if err != nil {
				return err
			}
			var baseline *lifecyclerepo.Inspection
			var observed preparedEmptyInspection
			verify := func() error {
				if ctx.Err() != nil {
					return handoff.Refused
				}
				c, ch, e := q.Roots()
				t, te := q.TaskRoot()
				if e != nil || te != nil || c != computer || ch != chat || t != task {
					return handoff.Refused
				}
				if err := errors.Join(h.Verify(), r.Verify()); err != nil {
					return err
				}
				if err := inspectEmptyRecoveryNamespaces(ctx, computer, chat, task, 2); err != nil {
					return err
				}
				currentPending, e := inspectPreparedEmptyPending(in)
				if e != nil || currentPending != pending {
					return handoff.Refused
				}
				currentFiles, e := inspectPreparedEmptyArchive(ctx, in, archive)
				if e != nil || !reflect.DeepEqual(files, currentFiles) {
					return handoff.Refused
				}
				life, e := lifecyclerepo.Inspect(ctx, lifecyclerepo.Root{Path: chat.Path, ProfileID: chat.ProfileID, Device: chat.Device, Inode: chat.Inode, OwnerUID: chat.OwnerUID}, lifecyclerepo.Limits{Bytes: 1048576, Records: 4096})
				if e != nil || baseline != nil && life.SnapshotDigest != baseline.SnapshotDigest {
					return handoff.Refused
				}
				rv, e := r.Observation()
				if e != nil {
					return e
				}
				v, e := preparedEmptyObservation(in, chat, h.Observation(), life, rv, files)
				if e != nil {
					return e
				}
				if baseline == nil {
					baseline, observed = life, v
				}
				return nil
			}
			_, err = mutationrepo.InspectSettled(ctx, mutationrepo.Root{Path: computer.Path, Device: computer.Device, Inode: computer.Inode, OwnerUID: computer.OwnerUID}, mutationrepo.SettledSelection{OwnerID: o.OwnerID, ProfileID: o.Profile.ProfileID, ComputerID: o.ComputerID}, o.Mutations, func(mutationrepo.SettledInspection) error {
				if err := verify(); err != nil {
					return err
				}
				callbackErr := visit(observed)
				return errors.Join(callbackErr, verify())
			})
			return err
		})
	})
}
