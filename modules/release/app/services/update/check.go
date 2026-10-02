package update

import (
	"context"

	release "github.com/legrch/farol/modules/release/domain"
)

type InitializeRequest struct{}
type InitializeResponse struct{}

func (s *Service) Initialize(ctx context.Context, _ InitializeRequest) (*InitializeResponse, error) {
	if !s.begin(s.state.BeginInitialize) {
		return &InitializeResponse{}, nil
	}
	r, err := s.runtime.Reconcile(ctx)
	var restored release.Restored
	var failure *release.Failure
	if err != nil || r == nil {
		f := classified(err, "UPDATE_RECOVERY_UNAVAILABLE", true)
		failure = &f
	} else if (r.Archive != nil && !validArchive(r.Archive)) || len(r.RollbackVersion) > 128 || len(r.RecoveryVersion) > 128 {
		f := release.Failure{Code: "UPDATE_RECOVERY_UNAVAILABLE", RecoveryRequired: true}
		failure = &f
	} else {
		restored.RollbackVersion, restored.RecoveryVersion = r.RollbackVersion, r.RecoveryVersion
		if r.Archive != nil {
			a := archive(*r.Archive)
			restored.Archive = &a
		}
	}
	s.finish(func() { s.state.Reconciled(restored, failure) })
	return &InitializeResponse{}, nil
}

type CheckRequest struct{ Manual bool }
type CheckResponse struct{}

func (s *Service) Check(ctx context.Context, req CheckRequest) (*CheckResponse, error) {
	now := s.clock.NowMilliseconds()
	if !s.begin(func() bool { return s.state.BeginCheck(req.Manual, now) }) {
		return &CheckResponse{}, nil
	}
	found, err := s.runtime.Discover(ctx)
	if err != nil || found == nil {
		s.finish(func() { s.state.DiscoveryFailed(classified(err, "UPDATE_CHECK_FAILED", false)) })
		return &CheckResponse{}, nil
	}
	if !found.Available {
		s.finish(s.state.NoUpdate)
		return &CheckResponse{}, nil
	}
	s.mu.Lock()
	proceed := s.state.BeginDownload()
	if !proceed {
		close(s.drained)
	}
	s.mu.Unlock()
	if !proceed {
		return &CheckResponse{}, nil
	}
	a, err := s.runtime.Download(ctx)
	if err != nil || !validArchive(a) {
		s.finish(func() { s.state.DownloadFailed(classified(err, "UPDATE_CHECK_FAILED", true)) })
		return &CheckResponse{}, nil
	}
	// Caller cancellation/Close cannot skip the issued durable obligation.
	err = s.runtime.Retain(*a)
	if err != nil {
		s.finish(func() { s.state.DownloadFailed(classified(err, "UPDATE_CHECK_FAILED", true)) })
	} else {
		s.finish(func() { s.state.Retained(archive(*a)) })
	}
	return &CheckResponse{}, nil
}
