package domain

import "strings"

// Hard limits for saved AI providers. They are deliberately not
// configurable.
const (
	MaxAIProviders         = 20
	MaxAIProviderNameChars = 60
	// MinAITimeoutSeconds and MaxAITimeoutSeconds bound the saved request
	// timeout. The environment's default is not held to them.
	MinAITimeoutSeconds = 10
	MaxAITimeoutSeconds = 300
)

// ValidateAIProviderName trims a provider name and checks it: 1 to
// MaxAIProviderNameChars characters on a single line. It returns the trimmed
// name and a validation message, "" when valid.
func ValidateAIProviderName(name string) (string, string) {
	name, msg := checkText(name, 1, MaxAIProviderNameChars)
	if msg == "" && !IsSingleLine(name) {
		msg = SingleLineMessage
	}
	return name, msg
}

// AIProviderNameKey is the case-insensitive comparison key for provider
// names.
func AIProviderNameKey(name string) string {
	return strings.ToLower(strings.TrimSpace(name))
}
