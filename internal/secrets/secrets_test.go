package secrets

import (
	"bytes"
	"encoding/base64"
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
	raw, err := base64.RawStdEncoding.DecodeString(strings.TrimPrefix(ct, prefix))
	if err != nil {
		t.Fatal(err)
	}
	raw[len(raw)-1] ^= 0x01
	tampered := prefix + base64.RawStdEncoding.EncodeToString(raw)
	if _, err := box.Decrypt(tampered); err != ErrDecrypt {
		t.Errorf("tampered ciphertext: got %v, want ErrDecrypt", err)
	}
}

// knownKey is bytes 0x00..0x1f; the literals below were sealed with it and
// the nonce a0..ab, so a change to the cipher, the "v1:" prefix, the nonce
// layout or the additional data breaks them.
func knownKey() []byte {
	k := make([]byte, 32)
	for i := range k {
		k[i] = byte(i)
	}
	return k
}

func TestDecryptKnownAnswer(t *testing.T) {
	box, err := NewBox(knownKey())
	if err != nil {
		t.Fatal(err)
	}
	const plain = "v1:oKGio6SlpqeoqaqrlXNRRiukddFPBOmgcB+ya4Os+AihXRnDqdJOQk1aew"
	if pt, err := box.Decrypt(plain); err != nil || pt != "sk-known-answer" {
		t.Errorf("Decrypt: %q, %v", pt, err)
	}
	const bound = "v1:oKGio6SlpqeoqaqrlXNRTyq+bNtPBOmgcB+yNnOi+Qo3ECr+vgWOzH/2gA"
	if pt, err := box.DecryptBound(bound, "anthropic\nhttps://api.anthropic.com"); err != nil || pt != "sk-bound-answer" {
		t.Errorf("DecryptBound: %q, %v", pt, err)
	}
	if _, err := box.Decrypt(bound); err != ErrDecrypt {
		t.Errorf("bound ciphertext without its context: got %v, want ErrDecrypt", err)
	}
}

func TestDecryptRejectsMalformedCiphertext(t *testing.T) {
	box, _ := NewBox(knownKey())
	short := prefix + base64.RawStdEncoding.EncodeToString(make([]byte, 11))
	nonceOnly := prefix + base64.RawStdEncoding.EncodeToString(make([]byte, 12))
	for _, ct := range []string{"", "v1:", "oKGio6SlpqeoqaqrlXNRRiukddFPBOmgcB+ya4Os+AihXRnDqdJOQk1aew", "v2:oKGio6Sl", "v1:not base64!", "v1:oKGio6SlpqeoqaqrlXNRRiukddFPBOmgcB+ya4Os+AihXRnDqdJOQk1aew==", short, nonceOnly} {
		if pt, err := box.Decrypt(ct); err != ErrDecrypt {
			t.Errorf("%q: got %q, %v, want ErrDecrypt", ct, pt, err)
		}
	}
}

func TestNewBoxNeeds32Bytes(t *testing.T) {
	for _, n := range []int{0, 16, 24, 31, 33, 64} {
		if _, err := NewBox(make([]byte, n)); err == nil {
			t.Errorf("%d-byte key accepted", n)
		}
	}
}

func TestLoadKeyRejectsCorruptKeyFile(t *testing.T) {
	for _, content := range []string{"", "not a key\n", hex.EncodeToString(make([]byte, 16)) + "\n"} {
		dir := t.TempDir()
		path := filepath.Join(dir, KeyFileName)
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		if k, _, err := LoadKey("", dir); err == nil || !strings.Contains(err.Error(), path) {
			t.Errorf("%q: got %x, %v; want an error naming the file", content, k, err)
		}
		if got, _ := os.ReadFile(path); string(got) != content {
			t.Errorf("%q: corrupt key file was rewritten to %q", content, got)
		}
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

func TestBoundSecretsOnlyDecryptInTheirContext(t *testing.T) {
	box, _ := NewBox(bytes.Repeat([]byte{5}, 32))
	ct, err := box.EncryptBound("sk-key", "anthropic\nhttps://api.anthropic.com")
	if err != nil {
		t.Fatal(err)
	}
	if pt, err := box.DecryptBound(ct, "anthropic\nhttps://api.anthropic.com"); err != nil || pt != "sk-key" {
		t.Fatalf("same context: %q %v", pt, err)
	}
	for _, other := range []string{"", "anthropic\nhttps://evil.example", "openai_compatible\nhttps://api.anthropic.com"} {
		if _, err := box.DecryptBound(ct, other); err != ErrDecrypt {
			t.Errorf("context %q must not decrypt: %v", other, err)
		}
	}
}
