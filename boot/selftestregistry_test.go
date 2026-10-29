package boot

import (
	"context"
	"sync"
	"testing"
)

func TestSelfTestRegistryRetainsSingleOriginalOwner(t *testing.T) {
	s, _, journal, native, in := connectorMutationFixture(t)
	store := &factoryJournal{chatMutationJournal: journal, durablePlanStore: &durablePlanStore{}}
	s.mutations.dependencies.repository = store
	const id = "00000000-0000-4000-8000-000000000001"
	results := make(chan *durableSelfTestExecution, 12)
	errs := make(chan error, 12)
	var wg sync.WaitGroup
	for range 12 {
		wg.Go(func() {
			out, err := s.selectSelfTest(context.Background(), s.current, "work", id, in.Publication)
			results <- out
			errs <- err
		})
	}
	wg.Wait()
	close(results)
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	var original *durableSelfTestExecution
	for out := range results {
		if original == nil {
			original = out
		}
		if out != original {
			t.Fatal("new owner for same operation")
		}
	}
	if store.durablePlanStore.admits != 0 || journal.admits != 0 || native.calls != 0 {
		t.Fatal("selection caused effect")
	}
	if _, err := s.selectSelfTest(context.Background(), s.current, "other", id, in.Publication); err == nil {
		t.Fatal("original rebound")
	}
}
