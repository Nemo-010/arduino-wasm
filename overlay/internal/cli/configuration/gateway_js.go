//go:build js

package configuration

import (
	"encoding/base64"
	"net/http"
	"net/url"
	"os"
	"strings"
)

// gatewayTransport routes requests through a CORS gateway when
// ARDUINO_CORS_GATEWAY is set.
//
// On js the HTTP client is fetch(), and fetch is the thing that enforces CORS.
// Some package indices and release assets send no access-control-allow-origin,
// so the browser refuses to read a response that Node, curl and a desktop build
// all accept. A gateway is a single origin that does send the header and fetches
// the real URL itself; rewriting the URL here leaves the rest of arduino-cli
// untouched, including redirects, ranges and progress reporting.
//
// The target URL is carried base64url-encoded so a query string in it cannot be
// confused with the gateway's own, and so no escaping layer has to agree twice
// about what a URL looks like.
func gatewayTransport(inner http.RoundTripper) http.RoundTripper {
	raw := strings.TrimRight(os.Getenv("ARDUINO_CORS_GATEWAY"), "/")
	if raw == "" {
		return inner
	}
	base, err := url.Parse(raw)
	if err != nil || base.Scheme == "" || base.Host == "" {
		// Silently leaving requests unrewritten would surface much later as an
		// opaque CORS failure with no hint that a variable was mistyped.
		panic("ARDUINO_CORS_GATEWAY is not an absolute URL: " + raw)
	}
	return &gatewayRoundTripper{inner: inner, base: base}
}

type gatewayRoundTripper struct {
	inner http.RoundTripper
	base  *url.URL
}

func (g *gatewayRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	encoded := base64.RawURLEncoding.EncodeToString([]byte(req.URL.String()))
	target := *g.base
	target.Path = strings.TrimRight(g.base.Path, "/") + "/u/" + encoded

	rewritten := req.Clone(req.Context())
	rewritten.URL = &target
	return g.inner.RoundTrip(rewritten)
}
