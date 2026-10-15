package boot

import "errors"

// These two trusted launcher flags form one optional selection. Counting every
// occurrence distinguishes absence from empty and refuses last-value-wins input.
type codexReadLaunchFlag struct {
	value string
	count int
}

func (f *codexReadLaunchFlag) String() string { return f.value }
func (f *codexReadLaunchFlag) Set(value string) error {
	f.value = value
	f.count++
	return nil
}

func decodeCodexReadLaunch(host, temp codexReadLaunchFlag, native bool) (*NativeCodexReadSelection, error) {
	if host.count == 0 && temp.count == 0 {
		return nil, nil
	}
	selection := NativeCodexReadSelection{HostID: host.value, TrustedTemp: temp.value}
	if !native || host.count != 1 || temp.count != 1 || !selection.valid() {
		return nil, errors.New("CODEX_READ_LAUNCH_INVALID")
	}
	// Values alone do not qualify the native host, schema, account or provider.
	return &selection, nil
}
