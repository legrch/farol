package turn

import "math"

const Slots = 5
const MaxPending = 256
const MaxRequests = 1024

// Queue is a pure, single-owner scheduler. It performs no native calls or writes.
// Application composition must serialize it and durably commit changes before IO.
type Queue struct {
	profile     string
	backend     string
	entries     map[string]Turn
	waiting     []string
	slots       [Slots]string
	generations [Slots]uint64
}

func NewQueue(profile, backend string) (*Queue, error) {
	if !id(profile) || !id(backend) {
		return nil, Invalid
	}
	return &Queue{profile: profile, backend: backend, entries: make(map[string]Turn)}, nil
}

// Clone is a private candidate for journal-before-publication application writes.
// Turn values (including fixed call history), slots and generations are copied;
// map and waiting-slice storage are independent of the committed queue.
func (q *Queue) Clone() *Queue {
	copy := *q
	copy.entries = make(map[string]Turn, len(q.entries))
	for key, value := range q.entries {
		copy.entries[key] = value
	}
	copy.waiting = append([]string(nil), q.waiting...)
	return &copy
}

func (q *Queue) Admit(identity Identity, digest string) (Snapshot, error) {
	t, err := New(identity, digest)
	if err != nil {
		return Snapshot{}, err
	}
	if identity.ProfileID != q.profile {
		return Snapshot{}, Correlation
	}
	if existing, found := q.entries[identity.OperationID]; found {
		if existing.identity != identity || existing.digest != digest {
			return Snapshot{}, Conflict
		}
		return existing.Snapshot(), nil
	}
	for _, existing := range q.entries {
		if existing.identity.OwnerID == identity.OwnerID && existing.identity.SessionID == identity.SessionID && existing.identity.TaskID == identity.TaskID && existing.identity.TurnID == identity.TurnID && existing.identity.Generation == identity.Generation {
			return Snapshot{}, Conflict
		}
	}
	if len(q.entries) >= MaxRequests {
		return Snapshot{}, Capacity
	}
	q.entries[identity.OperationID] = t
	return t.Snapshot(), nil
}

func (q *Queue) Enqueue(identity Identity) (Snapshot, error) {
	t, err := q.get(identity)
	if err != nil {
		return Snapshot{}, err
	}
	if t.phase == Pending {
		return t.Snapshot(), nil
	}
	if len(q.waiting) >= MaxPending {
		return Snapshot{}, Capacity
	}
	t, err = t.wait()
	if err != nil {
		return Snapshot{}, err
	}
	q.entries[identity.OperationID] = t
	q.waiting = append(q.waiting, identity.OperationID)
	return t.Snapshot(), nil
}

// Reserve chooses an idle ordinal, preserving FIFO among eligible requests.
// A later turn of a task cannot reserve another view while that task owns one.
func (q *Queue) Reserve() (Reservation, error) {
	slot := -1
	for n, key := range q.slots {
		if key == "" && q.generations[n] < math.MaxUint64 {
			slot = n
			break
		}
	}
	if slot == -1 {
		return Reservation{}, Capacity
	}
	for n, key := range q.waiting {
		t := q.entries[key]
		busy := false
		for _, occupied := range q.slots {
			active, found := q.entries[occupied]
			if found && active.identity.OwnerID == t.identity.OwnerID && active.identity.SessionID == t.identity.SessionID && active.identity.TaskID == t.identity.TaskID {
				busy = true
				break
			}
		}
		if busy {
			continue
		}
		reservation := Reservation{BackendGeneration: q.backend, Identity: t.identity, Ordinal: uint8(slot + 1), Generation: q.generations[slot] + 1}
		changed, err := t.reserve(reservation)
		if err != nil {
			return Reservation{}, err
		}
		q.entries[key] = changed
		q.slots[slot], q.generations[slot] = key, reservation.Generation
		q.waiting = append(q.waiting[:n], q.waiting[n+1:]...)
		return reservation, nil
	}
	return Reservation{}, NotFound
}

func (q *Queue) Snapshot(identity Identity) (Snapshot, error) {
	t, err := q.get(identity)
	if err != nil {
		return Snapshot{}, err
	}
	return t.Snapshot(), nil
}

func (q *Queue) Bind(r Reservation, d Document) (Snapshot, error) {
	for _, key := range q.slots {
		existing, found := q.entries[key]
		if found && existing.bound && existing.identity != r.Identity && existing.binding.Document.ViewID == d.ViewID {
			return Snapshot{}, Conflict
		}
	}
	return q.change(r.Identity, func(t Turn) (Turn, error) { return t.Bind(r, d) })
}
func (q *Queue) Dispatch(b Binding) (Snapshot, error) {
	return q.change(b.Reservation.Identity, func(t Turn) (Turn, error) { return t.Dispatch(b) })
}
func (q *Queue) AcceptConversation(b Binding, cid string) (Snapshot, error) {
	return q.change(b.Reservation.Identity, func(t Turn) (Turn, error) { return t.AcceptConversation(b, cid) })
}
func (q *Queue) Accept(b Binding) (Snapshot, error) {
	return q.change(b.Reservation.Identity, func(t Turn) (Turn, error) { return t.Accept(b) })
}
func (q *Queue) AwaitOwner(b Binding) (Snapshot, error) {
	return q.change(b.Reservation.Identity, func(t Turn) (Turn, error) { return t.AwaitOwner(b) })
}
func (q *Queue) Resume(b Binding) (Snapshot, error) {
	return q.change(b.Reservation.Identity, func(t Turn) (Turn, error) { return t.Resume(b) })
}
func (q *Queue) Delta(b Binding, sequence uint64) (Snapshot, error) {
	return q.change(b.Reservation.Identity, func(t Turn) (Turn, error) { return t.Delta(b, sequence) })
}
func (q *Queue) RequestComputer(b Binding, callID string) (Snapshot, error) {
	return q.change(b.Reservation.Identity, func(t Turn) (Turn, error) { return t.RequestComputer(b, callID) })
}
func (q *Queue) ResolveComputer(b Binding, callID string) (Snapshot, error) {
	return q.change(b.Reservation.Identity, func(t Turn) (Turn, error) { return t.ResolveComputer(b, callID) })
}
func (q *Queue) Finish(b Binding, result Result) (Snapshot, error) {
	return q.change(b.Reservation.Identity, func(t Turn) (Turn, error) { return t.Finish(b, result) })
}
func (q *Queue) Acknowledge(identity Identity, resultID string) (Snapshot, error) {
	return q.change(identity, func(t Turn) (Turn, error) { return t.Acknowledge(identity, resultID) })
}
func (q *Queue) Settle(evidence QuiescenceEvidence) (Snapshot, error) {
	return q.change(evidence.Binding.Reservation.Identity, func(t Turn) (Turn, error) { return t.Settle(evidence) })
}
func (q *Queue) SettlePrepared(evidence DisposalEvidence) (Snapshot, error) {
	return q.change(evidence.Reservation.Identity, func(t Turn) (Turn, error) { return t.SettlePrepared(evidence) })
}

func (q *Queue) Cancel(identity Identity, resultID string) (Snapshot, error) {
	snapshot, err := q.change(identity, func(t Turn) (Turn, error) { return t.Cancel(resultID) })
	if err != nil {
		return Snapshot{}, err
	}
	for n, key := range q.waiting {
		if key == identity.OperationID {
			q.waiting = append(q.waiting[:n], q.waiting[n+1:]...)
			break
		}
	}
	return snapshot, nil
}

func (q *Queue) Release(r Reservation) error {
	t, err := q.get(r.Identity)
	if err != nil {
		return err
	}
	if !t.reserved || t.reservation != r {
		return Correlation
	}
	if !t.Reusable() {
		return Unsettled
	}
	slot := int(r.Ordinal) - 1
	if q.slots[slot] != r.Identity.OperationID {
		return Correlation
	}
	q.slots[slot] = ""
	// Keep the historical exact binding. ActiveBinding additionally checks ownership.
	return nil
}

// ActiveBinding never opens a reused slot on behalf of its historical turn.
func (q *Queue) ActiveBinding(identity Identity) (Binding, error) {
	t, err := q.get(identity)
	if err != nil {
		return Binding{}, err
	}
	if !t.bound || q.slots[int(t.reservation.Ordinal)-1] != identity.OperationID {
		return Binding{}, NotFound
	}
	return t.binding, nil
}

func (q *Queue) get(identity Identity) (Turn, error) {
	t, found := q.entries[identity.OperationID]
	if !found {
		return Turn{}, NotFound
	}
	if t.identity != identity {
		return Turn{}, Correlation
	}
	return t, nil
}

func (q *Queue) change(identity Identity, operation func(Turn) (Turn, error)) (Snapshot, error) {
	t, err := q.get(identity)
	if err != nil {
		return Snapshot{}, err
	}
	changed, err := operation(t)
	if err != nil {
		return Snapshot{}, err
	}
	q.entries[identity.OperationID] = changed
	return changed.Snapshot(), nil
}
