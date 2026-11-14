//go:build !js

package configuration

import "net/http"

// gatewayTransport is a js-only mechanism: elsewhere the process reaches the
// network with real sockets, and fetch's CORS rule does not apply.
func gatewayTransport(inner http.RoundTripper) http.RoundTripper {
	return inner
}
