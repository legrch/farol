package access

import "time"

// Clock is the native wall clock for trusted Computer composition. Fixed clocks
// are supplied only by disposable tests; the app depends on its consumer port.
type Clock struct{}

func (Clock) Now() time.Time { return time.Now() }

func (s *Store) now() (time.Time, error) {
	now := s.clock.Now()
	ms := now.UnixMilli()
	if ms <= 0 || ms > 9007199254740991 {
		return time.Time{}, unavailable()
	}
	return now, nil
}
