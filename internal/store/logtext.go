package store

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"io"
)

// CompressText is how stores keep AI log bodies: gzip at the default level.
func CompressText(s string) []byte {
	var b bytes.Buffer
	w := gzip.NewWriter(&b)
	_, _ = io.WriteString(w, s)
	_ = w.Close()
	return b.Bytes()
}

// DecompressText reverses CompressText.
func DecompressText(b []byte) (string, error) {
	r, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		return "", err
	}
	defer r.Close()
	out, err := io.ReadAll(r)
	return string(out), err
}

// TextHash is the key a system text is stored under.
func TextHash(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}
