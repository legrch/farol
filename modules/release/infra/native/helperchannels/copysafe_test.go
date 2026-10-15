package helperchannels

import (
	"bytes"
	"context"
	"io"
	"sync"
	"testing"
	"time"
)

func TestCopiedWrappersShareConsumptionAndClose(t *testing.T) {
	ar, aw := pipe(t)
	cr, cw := pipe(t)
	c := take(t, aw, cr)
	const callers = 16
	wrappers := make([]Channels, callers)
	for i := range wrappers {
		wrappers[i] = *c
	}
	ctx, until := context.Background(), time.Now().Add(time.Second)
	ack := []byte("exactly one ACK")
	ackResults := make(chan error, callers)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := range wrappers {
		wg.Go(func() { <-start; ackResults <- wrappers[i].Emit(ctx, until, ack) })
	}
	close(start)
	wg.Wait()
	close(ackResults)
	success := 0
	for err := range ackResults {
		if err == nil {
			success++
		} else {
			outcome(t, err, "ack_used", true)
		}
	}
	if success != 1 {
		t.Fatalf("successful ACK attempts: %d", success)
	}
	got, err := io.ReadAll(ar)
	if err != nil || !bytes.Equal(got, ack) {
		t.Fatalf("ACK bytes %q %v", got, err)
	}
	outcome(t, c.Emit(ctx, until, ack), "ack_used", true)

	cont := []byte("exactly one continuation")
	if _, err := cw.Write(cont); err != nil {
		t.Fatal(err)
	}
	_ = cw.Close()
	type result struct {
		frame []byte
		err   error
	}
	contResults := make(chan result, callers)
	start = make(chan struct{})
	for i := range wrappers {
		wg.Go(func() {
			<-start
			frame, err := wrappers[i].AwaitContinue(ctx, until)
			contResults <- result{frame, err}
		})
	}
	close(start)
	wg.Wait()
	close(contResults)
	success = 0
	for r := range contResults {
		if r.err == nil {
			success++
			if !bytes.Equal(r.frame, cont) {
				t.Fatalf("continuation %q", r.frame)
			}
		} else {
			outcome(t, r.err, "continue_used", false)
			if r.frame != nil {
				t.Fatal("duplicate continuation returned bytes")
			}
		}
	}
	if success != 1 {
		t.Fatalf("successful continuation attempts: %d", success)
	}
	_, err = c.AwaitContinue(ctx, until)
	outcome(t, err, "continue_used", false)
	for i := range wrappers {
		wg.Go(func() {
			if err := wrappers[i].Close(); err != nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
	for i := range wrappers {
		if err := wrappers[i].Close(); err != nil {
			t.Fatal(err)
		}
		outcome(t, wrappers[i].Emit(ctx, until, ack), "closed", true)
		frame, err := wrappers[i].AwaitContinue(ctx, until)
		outcome(t, err, "closed", false)
		if frame != nil {
			t.Fatal("closed wrapper returned bytes")
		}
	}
	closed(t, aw)
	closed(t, cr)
}

func TestCopiedCloseCancelsAndJoinsSharedOperations(t *testing.T) {
	_, aw := pipe(t)
	cr, _ := pipe(t)
	fill(t, aw)
	c := take(t, aw, cr)
	emitter, reader, closer := *c, *c, *c
	until := time.Now().Add(time.Second)
	ackResult, contResult := make(chan error, 1), make(chan error, 1)
	go func() { ackResult <- emitter.Emit(context.Background(), until, []byte("ack")) }()
	go func() { _, err := reader.AwaitContinue(context.Background(), until); contResult <- err }()
	waitActive(t, c)
	var wg sync.WaitGroup
	for _, wrapper := range []*Channels{c, &emitter, &reader, &closer} {
		wg.Go(func() {
			if err := wrapper.Close(); err != nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
	outcome(t, <-ackResult, "closed", false)
	outcome(t, <-contResult, "closed", false)
	closed(t, aw)
	closed(t, cr)
}

func TestNilAndZeroWrappersFailClosed(t *testing.T) {
	var nilChannels *Channels
	var zero Channels
	zeroCopy := zero
	for _, c := range []*Channels{nilChannels, &zero, &zeroCopy} {
		until := time.Now().Add(time.Second)
		outcome(t, c.Emit(context.Background(), until, []byte("ack")), "closed", false)
		frame, err := c.AwaitContinue(context.Background(), until)
		outcome(t, err, "closed", false)
		if frame != nil {
			t.Fatal("uninitialized wrapper returned bytes")
		}
		outcome(t, c.Close(), "closed", false)
	}
}
