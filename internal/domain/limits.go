package domain

// Fixed bounds on request-level input that are not tied to one record type.
// Item, test case, collection and style preset bounds live next to their
// types. All of them are published by GET /meta.
const (
	// MaxRequestBytes bounds a JSON request body.
	MaxRequestBytes = 32 << 20
	// MaxPageSize is the largest accepted pagination limit.
	MaxPageSize = 200
	// MaxPreviousDraftBytes bounds the previousDraft of a revision request.
	MaxPreviousDraftBytes = 2 * MaxTextBytes
	// MaxModelIDChars and MaxAPIKeyChars bound AI provider settings.
	MaxModelIDChars = 200
	MaxAPIKeyChars  = 1000
	// Bundle metadata on export; the author shares the name's bound.
	MaxBundleNameChars        = 200
	MaxBundleDescriptionChars = 5000
	// Bundle archives: entry count and expanded size relative to the
	// configured upload limit.
	// MaxBundleEntries is high enough that any library this instance can
	// hold fits; the compressed and expanded size limits bound the work.
	MaxBundleEntries      = 1000000
	MaxBundleCollections  = 10000
	BundleExpansionFactor = 4
)
