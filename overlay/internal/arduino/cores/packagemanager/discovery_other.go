//go:build !js

package packagemanager

// Discoveries are native executables started as child processes, which every
// real host can do.
func DiscoveriesCanBeSpawned() bool {
	return true
}
