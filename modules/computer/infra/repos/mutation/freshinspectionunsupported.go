//go:build !darwin

package mutation

import "context"

func (*Repository) InspectFreshProcesses(context.Context, SettledSelection) error {
	return unavailable()
}
