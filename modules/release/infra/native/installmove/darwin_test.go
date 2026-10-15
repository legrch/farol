//go:build darwin

package installmove

func disposableMove(l int, ln string, r int, rn string, exchange bool) error {
	return darwinMove(l, ln, r, rn, exchange)
}
