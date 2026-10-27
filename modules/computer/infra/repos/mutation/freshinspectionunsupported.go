//go:build !darwin

package mutation

import "context"

func (*Repository) InspectFreshProcesses(context.Context, SettledSelection) (bool, error) {
	return false, unavailable()
}
