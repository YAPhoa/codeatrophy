// Package useragent turns a browser's User-Agent header into a short
// description for people, such as "Firefox on Linux". It knows the common
// browsers and systems by the tokens their User-Agent strings carry; it is
// a label, not a way to identify anything.
package useragent

import "strings"

// Unknown describes a User-Agent that names no browser this package knows.
const Unknown = "Unknown browser"

// A token is matched as a substring; the first match wins, so tokens that
// other browsers also carry (Chrome's in Edge's, Safari's in Chrome's) come
// after the more specific ones.
type token struct{ match, name string }

var browsers = []token{
	{"Edg/", "Edge"}, {"EdgA/", "Edge"}, {"EdgiOS/", "Edge"},
	{"OPR/", "Opera"}, {"OPT/", "Opera"}, {"Opera", "Opera"},
	{"SamsungBrowser/", "Samsung Internet"},
	{"Vivaldi/", "Vivaldi"},
	{"YaBrowser/", "Yandex Browser"},
	{"FxiOS/", "Firefox"}, {"Firefox/", "Firefox"},
	{"CriOS/", "Chrome"}, {"Chromium/", "Chromium"}, {"Chrome/", "Chrome"},
	{"Safari/", "Safari"},
	{"curl/", "curl"}, {"Wget/", "Wget"},
}

var systems = []token{
	{"iPhone", "iPhone"}, {"iPad", "iPad"}, {"iPod", "iPod"},
	{"Android", "Android"},
	{"CrOS", "ChromeOS"},
	{"Windows", "Windows"},
	{"Macintosh", "macOS"}, {"Mac OS X", "macOS"},
	{"FreeBSD", "FreeBSD"}, {"OpenBSD", "OpenBSD"},
	// Some distributions' own browser packages name them; a browser from
	// elsewhere (a download, a Flatpak) says only Linux.
	{"Fedora", "Fedora"}, {"Ubuntu", "Ubuntu"},
	{"Linux", "Linux"}, {"X11", "Linux"},
}

func find(ua string, ts []token) string {
	for _, t := range ts {
		if strings.Contains(ua, t.match) {
			return t.name
		}
	}
	return ""
}

// Describe returns "<browser> on <system>", the browser alone when the
// system is unknown, and "Unknown browser" (with " on <system>" when that
// is known) when the browser is not one it knows.
func Describe(ua string) string {
	browser, system := find(ua, browsers), find(ua, systems)
	if browser == "" {
		browser = Unknown
	}
	if system == "" {
		return browser
	}
	return browser + " on " + system
}
