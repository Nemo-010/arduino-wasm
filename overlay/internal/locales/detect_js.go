//go:build js

package locales

// A browser has no OS locale database to query. The page can override the
// language through the usual ARDUINO_LANGUAGE-style setting if needed.
func getLocaleIdentifier() string {
	return "en"
}
