//go:build !darwin

package mutation

func openNative(Root) (storage, error) {
	return nil, failure("WORKSPACE_MUTATION_STORE_UNSUPPORTED")
}
