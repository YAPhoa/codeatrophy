package domain

import (
	"strings"
	"unicode"
)

// Ways a change reaches the library, as ChangeSource.Via.
const (
	ViaHTTP   = "http"
	ViaMCP    = "mcp"
	ViaImport = "import"
)

// MaxChangeSourceChars bounds a ChangeSource's client and model, in code
// points.
const MaxChangeSourceChars = 200

// ChangeSource records who made a change to an item, for tracking only.
// Via is set by the server from the adapter that handled the change;
// Client and Model are reported by the client (or, for the server's own AI
// work, the model it used) and are not verified.
type ChangeSource struct {
	Via    string  `json:"via"`
	Client *string `json:"client"`
	Model  *string `json:"model"`
}

// NewChangeSource returns the record of a change made through via, with
// client and model sanitised (see CleanSourceText).
func NewChangeSource(via, client, model string) *ChangeSource {
	return &ChangeSource{Via: via, Client: CleanSourceText(client), Model: CleanSourceText(model)}
}

// CleanSourceText makes a client-reported name fit to keep: control
// characters become spaces, runs of white space become one space, the ends
// are trimmed and the text is cut to MaxChangeSourceChars code points. It
// returns nil for text that is left empty. It never fails.
func CleanSourceText(s string) *string {
	s = strings.ToValidUTF8(s, "�")
	var b strings.Builder
	n, space := 0, false
	for _, r := range s {
		if unicode.IsControl(r) || unicode.IsSpace(r) || r == ' ' || r == ' ' {
			space = n > 0
			continue
		}
		if n == MaxChangeSourceChars {
			break
		}
		if space {
			if n+1 == MaxChangeSourceChars {
				break
			}
			b.WriteByte(' ')
			n++
			space = false
		}
		b.WriteRune(r)
		n++
	}
	if b.Len() == 0 {
		return nil
	}
	out := b.String()
	return &out
}

// Clone returns a deep copy, or nil for nil.
func (c *ChangeSource) Clone() *ChangeSource {
	if c == nil {
		return nil
	}
	return &ChangeSource{Via: c.Via, Client: clonePtr(c.Client), Model: clonePtr(c.Model)}
}
