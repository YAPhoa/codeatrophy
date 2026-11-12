package secrets

import (
	"bytes"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEncryptDecrypt(t *testing.T) {
	key := bytes.Repeat([]byte{7}, 32)
	box, err := NewBox(key)
	if err != nil {
		t.Fatal(err)
	}
	ct, err := box.Encrypt("sk-ant-secret-value")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(ct, "secret") {
		t.Fatal("ciphertext contains the plaintext")
	}
	ct2, _ := box.Encrypt("sk-ant-secret-value")
	if ct == ct2 {
		t.Error("encryption must use a fresh nonce")
	}
	pt, err := box.Decrypt(ct)
	if err != nil || pt != "sk-ant-secret-value" {
		t.Fatalf("decrypt: %q, %v", pt, err)
	}
	other, _ := NewBox(bytes.Repeat([]byte{8}, 32))
	if _, err := other.Decrypt(ct); err != ErrDecrypt {
		t.Errorf("decrypting with another key: got %v, want ErrDecrypt", err)
	}
	tampered := ct[:len(ct)-2] + "AA"
	if _, err := box.Decrypt(tampered); err == nil {
		t.Error("tampered ciphertext must not decrypt")
	}
}

func TestParseKey(t *testing.T) {
	raw := bytes.Repeat([]byte{0xab}, 32)
	for _, s := range []string{hex.EncodeToString(raw), "q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s=", "q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s"} {
		k, err := ParseKey(s)
		if err != nil || !bytes.Equal(k, raw) {
			t.Errorf("%s: got %x, %v", s, k, err)
		}
	}
	for _, s := range []string{"", "short", hex.EncodeToString(raw[:16])} {
		if _, err := ParseKey(s); err == nil {
			t.Errorf("%q: expected an error", s)
		}
	}
}

func TestLoadKeyGeneratesFileOnce(t *testing.T) {
	dir := t.TempDir()
	k1, src, err := LoadKey("", dir)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(src, "generated") {
		t.Errorf("source = %q", src)
	}
	st, err := os.Stat(filepath.Join(dir, KeyFileName))
	if err != nil {
		t.Fatal(err)
	}
	if st.Mode().Perm() != 0o600 {
		t.Errorf("key file mode = %v, want 0600", st.Mode().Perm())
	}
	k2, _, err := LoadKey("", dir)
	if err != nil || !bytes.Equal(k1, k2) {
		t.Fatalf("second load returned a different key: %v", err)
	}
	env := hex.EncodeToString(bytes.Repeat([]byte{1}, 32))
	k3, src, err := LoadKey(env, dir)
	if err != nil || src != "environment" || bytes.Equal(k3, k1) {
		t.Errorf("environment key not preferred: %q %v", src, err)
	}
	if _, _, err := LoadKey("not-a-key", dir); err == nil {
		t.Error("invalid environment key accepted")
	}
}
