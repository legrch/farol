// Package gate supplies per-owner serialization without IO or shared state.
package gate

import "sync"

type Mutex struct{ mu sync.Mutex }

func New() *Mutex        { return &Mutex{} }
func (g *Mutex) Lock()   { g.mu.Lock() }
func (g *Mutex) Unlock() { g.mu.Unlock() }
