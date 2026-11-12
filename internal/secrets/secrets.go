// Package secrets encrypts values at rest with AES-256-GCM using a key kept
// outside the database.
package secrets

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// KeyFileName is the name of the generated key file in the data directory.
const KeyFileName = "secret.key"

const prefix = "v1:"

// Box encrypts and decrypts values.
type Box struct {
	aead cipher.AEAD
}

// NewBox returns a box using a 32-byte key.
func NewBox(key []byte) (*Box, error) {
	if len(key) != 32 {
		return nil, errors.New("secret key must be 32 bytes")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &Box{aead: aead}, nil
}

// Encrypt returns a printable ciphertext for plaintext.
func (b *Box) Encrypt(plaintext string) (string, error) {
	nonce := make([]byte, b.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	sealed := b.aead.Seal(nonce, nonce, []byte(plaintext), []byte(prefix))
	return prefix + base64.RawStdEncoding.EncodeToString(sealed), nil
}

// ErrDecrypt is returned when a value cannot be decrypted, typically because
// the secret key changed.
var ErrDecrypt = errors.New("cannot decrypt stored secret (was the secret key changed?)")

// Decrypt reverses Encrypt.
func (b *Box) Decrypt(ciphertext string) (string, error) {
	if !strings.HasPrefix(ciphertext, prefix) {
		return "", ErrDecrypt
	}
	raw, err := base64.RawStdEncoding.DecodeString(strings.TrimPrefix(ciphertext, prefix))
	if err != nil || len(raw) < b.aead.NonceSize() {
		return "", ErrDecrypt
	}
	nonce, sealed := raw[:b.aead.NonceSize()], raw[b.aead.NonceSize():]
	plain, err := b.aead.Open(nil, nonce, sealed, []byte(prefix))
	if err != nil {
		return "", ErrDecrypt
	}
	return string(plain), nil
}

// ParseKey decodes a key given as 64 hex characters or as standard or
// URL-safe base64 of 32 bytes.
func ParseKey(s string) ([]byte, error) {
	s = strings.TrimSpace(s)
	if len(s) == 64 {
		if k, err := hex.DecodeString(s); err == nil {
			return k, nil
		}
	}
	for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
		if k, err := enc.DecodeString(s); err == nil && len(k) == 32 {
			return k, nil
		}
	}
	return nil, errors.New("secret key must be 32 bytes encoded as 64 hex characters or base64")
}

// LoadKey returns the key from envValue if set, otherwise from the key file
// in dataDir, generating that file (mode 0600) on first use. The second
// result describes where the key came from.
func LoadKey(envValue, dataDir string) ([]byte, string, error) {
	if strings.TrimSpace(envValue) != "" {
		k, err := ParseKey(envValue)
		if err != nil {
			return nil, "", fmt.Errorf("CODEATHROPY_SECRET_KEY: %w", err)
		}
		return k, "environment", nil
	}
	path := filepath.Join(dataDir, KeyFileName)
	data, err := os.ReadFile(path)
	if err == nil {
		k, err := ParseKey(string(data))
		if err != nil {
			return nil, "", fmt.Errorf("%s: %w", path, err)
		}
		return k, path, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, "", err
	}
	k := make([]byte, 32)
	if _, err := rand.Read(k); err != nil {
		return nil, "", err
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		if errors.Is(err, os.ErrExist) {
			return LoadKey("", dataDir)
		}
		return nil, "", fmt.Errorf("creating secret key file: %w", err)
	}
	if _, err := f.WriteString(hex.EncodeToString(k) + "\n"); err != nil {
		f.Close()
		return nil, "", err
	}
	if err := f.Close(); err != nil {
		return nil, "", err
	}
	return k, path + " (generated)", nil
}
