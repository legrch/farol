package mutation

import (
	"bytes"
	"context"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	domain "github.com/legrch/farol/modules/computer/domain/mutation"
)

func terminalFixture(t *testing.T, out, errout []byte) (*Repository, *memory, processsvc.TerminalResult, domain.Identity, string) {
	t.Helper()
	r, m, scope, intent := processFixture()
	v := terminalValue(out, errout)
	v.Scope, v.Intent = scope, intent
	processReceipt(t, processAdapter(t, r, scope), intent, processsvc.Reserved)
	id := processIdentity(scope, intent.OperationID)
	key, err := recordKey(id)
	if err != nil {
		t.Fatal(err)
	}
	return r, m, v, id, key
}
func publishTerminal(t *testing.T, r *Repository, v processsvc.TerminalResult) string {
	t.Helper()
	digest, err := r.PublishProcessTerminal(context.Background(), v)
	if err != nil || !domain.SHA256(digest) {
		t.Fatal("publish terminal", digest, err)
	}
	return digest
}
func sameTerminal(t *testing.T, a, b *processsvc.TerminalResult) {
	t.Helper()
	if a == nil || b == nil || a.Scope != b.Scope || a.Intent.Binding != b.Intent.Binding || a.Intent.Seal != b.Intent.Seal ||
		a.Intent.OperationID != b.Intent.OperationID || !a.Intent.Deadline.Equal(b.Intent.Deadline) || !reflect.DeepEqual(terminalMetadata(a.Observation), terminalMetadata(b.Observation)) ||
		!bytes.Equal(a.Observation.Stdout, b.Observation.Stdout) || !bytes.Equal(a.Observation.Stderr, b.Observation.Stderr) {
		t.Fatal("terminal result differs")
	}
}
func TestProcessTerminalFullOutputRoundTripAndNoop(t *testing.T) {
	for _, test := range []struct {
		name           string
		stdout, stderr int
	}{
		{"empty", 0, 0}, {"one-byte", 1, 0}, {"chunk-boundary", processOutputChunkBytes, 0},
		{"above-64-KiB", 70001, 39001}, {"four-MiB-stdout", processsvc.MaximumOutput, 0},
		{"four-MiB-stderr", 0, processsvc.MaximumOutput}, {"four-MiB-129-chunks", processsvc.MaximumOutput - 1, 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			size := test.stdout + test.stderr
			out := make([]byte, size)
			for n := range out {
				out[n] = byte(n)
			}
			r, m, v, id, key := terminalFixture(t, out[:test.stdout], out[test.stdout:])
			original := v.Clone()
			digest := publishTerminal(t, r, v)
			if digest != processSHA256(m.files[key]) {
				t.Fatal("digest is not exact manifest hash")
			}
			creates, replaces := m.creates, m.replaces
			for _, raw := range m.files {
				if len(raw) > maxRecordBytes {
					t.Fatal("per-record limit widened")
				}
			}
			wantChunks := (len(v.Observation.Stdout)+processOutputChunkBytes-1)/processOutputChunkBytes + (len(v.Observation.Stderr)+processOutputChunkBytes-1)/processOutputChunkBytes
			if creates != wantChunks+1 || replaces != 1 {
				t.Fatal("unexpected publications", creates, replaces)
			}
			if publishTerminal(t, r, original) != digest || m.creates != creates || m.replaces != replaces {
				t.Fatal("identical result wrote")
			}
			if len(v.Observation.Stdout) > 0 {
				v.Observation.Stdout[0] ^= 1
			}
			if len(v.Observation.Stderr) > 0 {
				v.Observation.Stderr[0] ^= 1
			}
			*v.Observation.ExitCode = 99
			got, err := r.LoadProcessTerminal(context.Background(), id)
			if err != nil {
				t.Fatal(err)
			}
			sameTerminal(t, &original, got)
			if len(got.Observation.Stdout) > 0 {
				got.Observation.Stdout[0] ^= 1
			}
			if len(got.Observation.Stderr) > 0 {
				got.Observation.Stderr[0] ^= 1
			}
			*got.Observation.ExitCode = 22
			again, err := r.LoadProcessTerminal(context.Background(), id)
			if err != nil {
				t.Fatal(err)
			}
			sameTerminal(t, &original, again)
			if m.creates != creates || m.replaces != replaces {
				t.Fatal("load wrote")
			}
			if err := r.Close(); err != nil {
				t.Fatal(err)
			}
			// Independent memory lifetime proves the format only, not native reopen.
			got, err = newRepository(m).LoadProcessTerminal(context.Background(), id)
			if err != nil {
				t.Fatal(err)
			}
			sameTerminal(t, &original, got)
		})
	}
}
func TestProcessTerminalSignalAndAllMetadataBinding(t *testing.T) {
	r, m, v, id, _ := terminalFixture(t, []byte("out"), []byte("err"))
	v.Observation.ExitCode, v.Observation.ExitSignal = nil, 9
	v.Observation.OutputLimitReached, v.Observation.CancelRequested, v.Observation.TimedOut, v.Observation.AuthorityLost = true, true, true, true
	publishTerminal(t, r, v)
	got, err := r.LoadProcessTerminal(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	sameTerminal(t, &v, got)
	if m.creates != 3 || m.replaces != 1 {
		t.Fatal("unexpected signal publications")
	}
}
func TestProcessTerminalRequiresOriginalExactReservation(t *testing.T) {
	for name, change := range processChanges() {
		for _, terminal := range []bool{false, true} {
			t.Run(name+map[bool]string{true: "-terminal", false: "-reserved"}[terminal], func(t *testing.T) {
				r, m, v, _, key := terminalFixture(t, []byte("out"), []byte("err"))
				if terminal {
					publishTerminal(t, r, v)
				}
				before := bytes.Clone(m.files[key])
				creates, replaces := m.creates, m.replaces
				change(&v.Scope, &v.Intent)
				digest, err := r.PublishProcessTerminal(context.Background(), v)
				code(t, err, "WORKSPACE_MUTATION_BINDING_MISMATCH")
				if digest != "" || m.creates != creates || m.replaces != replaces || !bytes.Equal(before, m.files[key]) || r.fenced {
					t.Fatal("binding conflict wrote or fenced")
				}
			})
		}
	}
	for _, name := range []string{"missing", "malformed", "cross-kind"} {
		t.Run(name, func(t *testing.T) {
			r, m, v, _, key := terminalFixture(t, []byte("out"), nil)
			want := "WORKSPACE_MUTATION_STATE_CORRUPT"
			switch name {
			case "missing":
				delete(m.files, key)
				want = "WORKSPACE_MUTATION_STATE_MISSING"
			case "malformed":
				m.files[key] = []byte("bad")
			case "cross-kind":
				_, _, state := connectorV3Fixture(t)
				raw, _ := encode(state)
				m.files[key] = raw
			}
			creates, replaces := m.creates, m.replaces
			digest, err := r.PublishProcessTerminal(context.Background(), v)
			code(t, err, want)
			if digest != "" || m.creates != creates || m.replaces != replaces {
				t.Fatal("unbound output published")
			}
		})
	}
}
func TestProcessTerminalChangedResultImmutableAndConcurrentDuplicates(t *testing.T) {
	changes := map[string]func(*processsvc.TerminalResult){
		"handle":    func(v *processsvc.TerminalResult) { v.Observation.Handle += "2" },
		"exit":      func(v *processsvc.TerminalResult) { *v.Observation.ExitCode = 9 },
		"signal":    func(v *processsvc.TerminalResult) { v.Observation.ExitCode = nil; v.Observation.ExitSignal = 9 },
		"stdout":    func(v *processsvc.TerminalResult) { v.Observation.Stdout[0] ^= 1 },
		"stderr":    func(v *processsvc.TerminalResult) { v.Observation.Stderr[0] ^= 1 },
		"limit":     func(v *processsvc.TerminalResult) { v.Observation.OutputLimitReached = true },
		"cancel":    func(v *processsvc.TerminalResult) { v.Observation.CancelRequested = true },
		"timeout":   func(v *processsvc.TerminalResult) { v.Observation.TimedOut = true },
		"authority": func(v *processsvc.TerminalResult) { v.Observation.AuthorityLost = true },
	}
	for name, change := range changes {
		t.Run(name, func(t *testing.T) {
			r, m, v, _, key := terminalFixture(t, []byte("out"), []byte("err"))
			publishTerminal(t, r, v)
			before := bytes.Clone(m.files[key])
			creates, replaces := m.creates, m.replaces
			change(&v)
			digest, err := r.PublishProcessTerminal(context.Background(), v)
			code(t, err, "WORKSPACE_MUTATION_TERMINAL_IMMUTABLE")
			if digest != "" || m.creates != creates || m.replaces != replaces || !bytes.Equal(before, m.files[key]) || r.fenced {
				t.Fatal("immutable result changed")
			}
		})
	}
	r, m, v, _, _ := terminalFixture(t, []byte("out"), []byte("err"))
	var wg sync.WaitGroup
	errs := make(chan error, 16)
	digests := make(chan string, 16)
	for range 16 {
		wg.Go(func() { d, err := r.PublishProcessTerminal(context.Background(), v); errs <- err; digests <- d })
	}
	wg.Wait()
	close(errs)
	close(digests)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	var first string
	for d := range digests {
		if first == "" {
			first = d
		}
		if d != first || !domain.SHA256(d) {
			t.Fatal("concurrent digest mismatch")
		}
	}
	if m.creates != 3 || m.replaces != 1 {
		t.Fatal("concurrent duplicate wrote")
	}
}
func TestProcessTerminalReadOnlyAbsenceCorruptionAndCrossKind(t *testing.T) {
	r, m, v, id, key := terminalFixture(t, []byte("out"), []byte("err"))
	reserved := bytes.Clone(m.files[key])
	got, err := r.LoadProcessTerminal(context.Background(), id)
	if err != nil || got != nil || !bytes.Equal(reserved, m.files[key]) {
		t.Fatal("reserved became terminal")
	}
	delete(m.files, key)
	got, err = r.LoadProcessTerminal(context.Background(), id)
	if err != nil || got != nil {
		t.Fatal("missing result misclassified")
	}
	m.files[key] = reserved
	publishTerminal(t, r, v)
	_, e, _ := decodeProcessTerminal(m.files[key])
	chunkKey := processOutputKey(key, "stdout", e.Record.Stdout[0])
	stderrKey := processOutputKey(key, "stderr", e.Record.Stderr[0])
	baseline := make(map[string][]byte)
	for key, raw := range m.files {
		baseline[key] = bytes.Clone(raw)
	}
	for _, name := range []string{"missing-chunk", "malformed-chunk", "swapped-stream", "hash", "chunk-as-manifest", "malformed-manifest", "cross-kind", "swapped-operation", "read-error", "host-fence", "cancel"} {
		t.Run(name, func(t *testing.T) {
			files := make(map[string][]byte)
			for k, raw := range baseline {
				files[k] = bytes.Clone(raw)
			}
			store := &memory{files: files}
			reader := newRepository(store)
			want := "WORKSPACE_MUTATION_STATE_CORRUPT"
			ctx := context.Background()
			switch name {
			case "missing-chunk":
				delete(files, chunkKey)
			case "malformed-chunk":
				files[chunkKey] = []byte("bad")
			case "swapped-stream":
				files[chunkKey] = files[stderrKey]
			case "hash":
				files[chunkKey] = bytes.Replace(files[chunkKey], []byte(`"data":"b3V0"`), []byte(`"data":"YmFk"`), 1)
			case "chunk-as-manifest":
				files[key] = files[chunkKey]
			case "malformed-manifest":
				files[key] = []byte("bad")
			case "cross-kind":
				_, _, state := connectorV3Fixture(t)
				files[key], _ = encode(state)
			case "swapped-operation":
				other := v.Clone()
				other.Intent.OperationID = "other"
				files[key], _, _ = encodeProcessTerminal(other)
				want = "WORKSPACE_MUTATION_BINDING_MISMATCH"
			case "read-error":
				store.readErr = errors.New("read lost")
				want = "COMPUTER_MUTATION_STORE_UNAVAILABLE"
			case "host-fence":
				store.checkErr = errors.New("host fence")
				want = "COMPUTER_MUTATION_STORE_UNAVAILABLE"
			case "cancel":
				cancelled, cancel := context.WithCancel(ctx)
				cancel()
				ctx = cancelled
				want = "WORKSPACE_MUTATION_CANCELLED"
			}
			got, err := reader.LoadProcessTerminal(ctx, id)
			code(t, err, want)
			if got != nil || store.creates != 0 || store.replaces != 0 || reader.fenced {
				t.Fatal("load repaired or mutated")
			}
		})
	}
	// Ordinary mutation methods cannot reinterpret a process manifest.
	_, _, state := connectorV3Fixture(t)
	_, err = r.Load(context.Background(), id)
	code(t, err, "WORKSPACE_MUTATION_STATE_CORRUPT")
	_, err = r.Admit(context.Background(), state)
	code(t, err, "WORKSPACE_MUTATION_STATE_CORRUPT")
	err = r.Save(context.Background(), state)
	code(t, err, "WORKSPACE_MUTATION_STATE_CORRUPT")
	_, err = processAdapter(t, r, v.Scope).Reserve(context.Background(), v.Intent)
	code(t, err, "WORKSPACE_MUTATION_STATE_CORRUPT")
	if m.creates != 3 || m.replaces != 1 {
		t.Fatal("cross-kind methods wrote")
	}
}

// terminalFaultStore injects boundary losses at exact memory IO positions. It
// owns no second registry/journal and never exercises native storage or effects.
type terminalFaultStore struct {
	*memory
	afterChunkCreate   func(string) error
	afterRecordReplace func(string) error
	afterRecordRead    func(string, []byte) ([]byte, error)
	beforeCheck        func() error
}

func (s *terminalFaultStore) create(key string, raw []byte) error {
	err := s.memory.create(key, raw)
	if err == nil && s.afterChunkCreate != nil {
		err = s.afterChunkCreate(key)
	}
	return err
}
func (s *terminalFaultStore) replace(key string, raw, previous []byte) error {
	err := s.memory.replace(key, raw, previous)
	if err == nil && s.afterRecordReplace != nil {
		err = s.afterRecordReplace(key)
	}
	return err
}
func (s *terminalFaultStore) read(key string) ([]byte, error) {
	raw, err := s.memory.read(key)
	if err == nil && s.afterRecordRead != nil {
		return s.afterRecordRead(key, raw)
	}
	return raw, err
}
func (s *terminalFaultStore) check() error {
	if s.beforeCheck != nil {
		if err := s.beforeCheck(); err != nil {
			return err
		}
	}
	return s.memory.check()
}
func TestProcessTerminalPublicationLossPermanentlyFencesOriginalWriter(t *testing.T) {
	for _, name := range []string{"chunk-create-before-visible", "chunk-create-after-visible", "chunk-read-error", "chunk-missing", "chunk-crossed", "chunk-cancel", "chunk-host-fence", "next-chunk-check", "pre-CAS-loss", "CAS-before-visible", "CAS-after-visible", "CAS-cancel", "CAS-host-fence", "manifest-read-error", "manifest-missing", "manifest-crossed", "manifest-cancel", "manifest-host-fence", "final-chunk-loss", "late-check"} {
		t.Run(name, func(t *testing.T) {
			r, m, v, id, key := terminalFixture(t, bytes.Repeat([]byte("o"), 70000), []byte("err"))
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			s := &terminalFaultStore{memory: m}
			r.disk = s
			lost := errors.New("injected loss")
			chunkCreated, replaced := false, false
			s.afterChunkCreate = func(k string) error {
				chunkCreated = true
				if name == "chunk-create-after-visible" {
					return lost
				}
				if name == "chunk-cancel" {
					cancel()
				}
				if name == "chunk-host-fence" {
					m.checkErr = lost
				}
				return nil
			}
			s.afterRecordReplace = func(k string) error {
				replaced = true
				if name == "CAS-after-visible" {
					return lost
				}
				if name == "CAS-cancel" {
					cancel()
				}
				if name == "CAS-host-fence" {
					m.checkErr = lost
				}
				return nil
			}
			chunkRead := false
			s.afterRecordRead = func(k string, raw []byte) ([]byte, error) {
				if chunkCreated && k != key && !replaced {
					chunkRead = true
					switch name {
					case "chunk-read-error":
						return nil, lost
					case "chunk-missing":
						return nil, nil
					case "chunk-crossed":
						return []byte("crossed"), nil
					case "pre-CAS-loss":
						m.files[key] = []byte("crossed reservation")
					}
				}
				if replaced && k == key {
					switch name {
					case "manifest-read-error":
						return nil, lost
					case "manifest-missing":
						return nil, nil
					case "manifest-crossed":
						return []byte("crossed"), nil
					case "manifest-cancel":
						cancel()
					case "manifest-host-fence":
						m.checkErr = lost
					}
				}
				if replaced && k != key && name == "final-chunk-loss" {
					return nil, lost
				}
				return raw, nil
			}
			checksAfterChunkRead, checksAfterReplace := 0, 0
			s.beforeCheck = func() error {
				if chunkRead && !replaced {
					checksAfterChunkRead++
					if name == "next-chunk-check" && checksAfterChunkRead == 2 {
						return lost
					}
				}
				if replaced {
					checksAfterReplace++
					if name == "late-check" && checksAfterReplace == 7 {
						return lost
					}
				}
				return nil
			}
			if name == "chunk-create-before-visible" {
				m.createErr = lost
			}
			if name == "CAS-before-visible" {
				m.replaceErr = lost
			}
			digest, err := r.PublishProcessTerminal(ctx, v)
			code(t, err, "WORKSPACE_MUTATION_OUTCOME_UNKNOWN")
			if digest != "" || !r.fenced {
				t.Fatal("lost outcome not fenced")
			}
			reads, creates, replaces, checks := m.reads, m.creates, m.replaces, m.checks
			files := make(map[string][]byte)
			for k, raw := range m.files {
				files[k] = bytes.Clone(raw)
			}
			// Faults disappearing is never recovery authority; no retry/reload IO.
			s.afterChunkCreate, s.afterRecordReplace, s.afterRecordRead, s.beforeCheck = nil, nil, nil, nil
			m.createErr, m.replaceErr, m.readErr, m.checkErr = nil, nil, nil, nil
			_, err = r.PublishProcessTerminal(context.Background(), v)
			code(t, err, "WORKSPACE_MUTATION_OUTCOME_UNKNOWN")
			_, err = r.LoadProcessTerminal(context.Background(), id)
			code(t, err, "WORKSPACE_MUTATION_OUTCOME_UNKNOWN")
			_, err = processAdapter(t, r, v.Scope).Reserve(context.Background(), v.Intent)
			code(t, err, "WORKSPACE_MUTATION_OUTCOME_UNKNOWN")
			_, _, ordinary := fixture()
			_, err = r.Admit(context.Background(), ordinary)
			code(t, err, "WORKSPACE_MUTATION_OUTCOME_UNKNOWN")
			err = r.Save(context.Background(), ordinary)
			code(t, err, "WORKSPACE_MUTATION_OUTCOME_UNKNOWN")
			_, err = r.Load(context.Background(), ordinary.Binding().Identity)
			code(t, err, "WORKSPACE_MUTATION_OUTCOME_UNKNOWN")
			if m.reads != reads || m.creates != creates || m.replaces != replaces || m.checks != checks || !reflect.DeepEqual(files, m.files) {
				t.Fatal("fenced writer retried or repaired")
			}
		})
	}
}
func TestProcessTerminalOrphanAndDuplicateConfirmationLossNeverRepair(t *testing.T) {
	for _, name := range []string{"orphan-identical", "orphan-crossed", "duplicate-missing-chunk", "duplicate-read-error", "duplicate-cancel"} {
		t.Run(name, func(t *testing.T) {
			r, m, v, id, _ := terminalFixture(t, []byte("out"), nil)
			_, chunks, _ := encodeProcessTerminal(v)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if strings.HasPrefix(name, "orphan") {
				m.files[chunks[0].key] = bytes.Clone(chunks[0].raw)
				if name == "orphan-crossed" {
					m.files[chunks[0].key] = []byte("bad")
				}
			} else {
				publishTerminal(t, r, v)
				if name == "duplicate-missing-chunk" {
					delete(m.files, chunks[0].key)
				}
				if name == "duplicate-read-error" || name == "duplicate-cancel" {
					s := &terminalFaultStore{memory: m}
					r.disk = s
					s.afterRecordRead = func(k string, raw []byte) ([]byte, error) {
						if k == chunks[0].key {
							if name == "duplicate-read-error" {
								return nil, errors.New("lost read")
							}
							cancel()
						}
						return raw, nil
					}
				}
			}
			creates, replaces := m.creates, m.replaces
			digest, err := r.PublishProcessTerminal(ctx, v)
			code(t, err, "WORKSPACE_MUTATION_OUTCOME_UNKNOWN")
			if digest != "" || !r.fenced || m.replaces != replaces || m.creates != creates+map[bool]int{true: 1, false: 0}[strings.HasPrefix(name, "orphan")] {
				t.Fatal("repair or duplicate write")
			}
			_, err = r.LoadProcessTerminal(context.Background(), id)
			code(t, err, "WORKSPACE_MUTATION_OUTCOME_UNKNOWN")
		})
	}
}
func TestProcessTerminalInvalidAndEarlyRefusalZeroOutputIO(t *testing.T) {
	for name, change := range terminalInvalidChanges() {
		t.Run(name, func(t *testing.T) {
			r, m, _ := fixture()
			v := terminalValue([]byte("out"), []byte("err"))
			change(&v)
			_, err := r.PublishProcessTerminal(context.Background(), v)
			code(t, err, "WORKSPACE_MUTATION_STATE_INVALID")
			if m.reads+m.creates+m.replaces+m.checks != 0 {
				t.Fatal("invalid value reached store")
			}
		})
	}
	for _, name := range []string{"nil-context", "cancel", "host-fence", "closed", "read-error", "ordinary-fence"} {
		t.Run(name, func(t *testing.T) {
			r, m, v, _, _ := terminalFixture(t, nil, nil)
			ctx := context.Background()
			want := "COMPUTER_MUTATION_STORE_UNAVAILABLE"
			switch name {
			case "nil-context":
				ctx = nil
				want = "WORKSPACE_MUTATION_CANCELLED"
			case "cancel":
				c, cancel := context.WithCancel(ctx)
				cancel()
				ctx = c
				want = "WORKSPACE_MUTATION_CANCELLED"
			case "host-fence":
				m.checkErr = errors.New("fence")
			case "closed":
				if err := r.Close(); err != nil {
					t.Fatal(err)
				}
			case "read-error":
				m.readErr = errors.New("lost read")
			case "ordinary-fence":
				r.fenced = true
				want = "WORKSPACE_MUTATION_OUTCOME_UNKNOWN"
			}
			creates, replaces := m.creates, m.replaces
			_, err := r.PublishProcessTerminal(ctx, v)
			code(t, err, want)
			if m.creates != creates || m.replaces != replaces {
				t.Fatal("early refusal wrote")
			}
		})
	}
	var r *Repository
	_, err := r.PublishProcessTerminal(context.Background(), terminalValue(nil, nil))
	code(t, err, "COMPUTER_MUTATION_STORE_UNAVAILABLE")
	_, err = r.LoadProcessTerminal(context.Background(), processIdentity(terminalValue(nil, nil).Scope, "op"))
	code(t, err, "COMPUTER_MUTATION_STORE_UNAVAILABLE")
	r, m, _ := fixture()
	_, err = r.LoadProcessTerminal(context.Background(), domain.Identity{})
	code(t, err, "WORKSPACE_MUTATION_STATE_INVALID")
	if m.reads+m.creates+m.replaces+m.checks != 0 {
		t.Fatal("invalid read identity IO")
	}
}
