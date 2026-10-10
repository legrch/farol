package catalogue

import (
	selection "github.com/legrch/farol/modules/chat/domain/modelselection"
	"sync"
)

// Cache is per injected consumer lifetime, never a cross-consumer singleton.
// Even A -> B -> A invalidates A's original request. Latest-started refresh wins;
// a failed/partial newer refresh never makes the older pending response current.
type Cache struct {
	mu                                 sync.Mutex
	scope                              selection.Scope
	generation, serial, epoch, settled uint64
	snapshot                           selection.Snapshot
	have                               bool
	failure                            Code
}

type Ticket struct {
	scope                     selection.Scope
	generation, serial, epoch uint64
}

func (t Ticket) Scope() selection.Scope { return t.scope }
func (t Ticket) Epoch() uint64          { return t.epoch }

func (c *Cache) Activate(scope selection.Scope) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.generation++
	c.scope = scope
	c.have = false
	c.failure = Missing
	c.snapshot = selection.Snapshot{}
}
func (c *Cache) Begin() Ticket {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.serial++
	c.epoch++
	return Ticket{c.scope, c.generation, c.serial, c.epoch}
}
func (c *Cache) Complete(t Ticket, snapshot selection.Snapshot, err error) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if t.generation != c.generation || t.serial != c.serial || t.scope != c.scope || t.epoch != c.epoch || t.serial == c.settled {
		return Superseded
	}
	c.settled = t.serial
	if err != nil {
		c.have = false
		c.failure = Unavailable
		c.snapshot = selection.Snapshot{}
		return Unavailable
	}
	if snapshot.Scope != t.scope || snapshot.Epoch != t.epoch {
		c.have = false
		c.failure = ScopeMismatch
		return ScopeMismatch
	}
	if selection.ValidateSnapshot(snapshot) != nil {
		c.have = false
		c.failure = Invalid
		return Invalid
	}
	c.snapshot = clone(snapshot)
	c.have = true
	c.failure = ""
	return nil
}
func (c *Cache) Current() (selection.Snapshot, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.have {
		if c.failure == "" {
			return selection.Snapshot{}, Missing
		}
		return selection.Snapshot{}, c.failure
	}
	return clone(c.snapshot), nil
}
func clone(s selection.Snapshot) selection.Snapshot {
	s.Entries = append([]selection.Entry(nil), s.Entries...)
	for n := range s.Entries {
		s.Entries[n].Efforts = append([]string(nil), s.Entries[n].Efforts...)
	}
	return s
}
