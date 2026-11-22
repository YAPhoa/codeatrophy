package ai

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
)

func TestEgressRefusal(t *testing.T) {
	compile := func(p EgressPolicy) *egress {
		t.Helper()
		e, err := p.compile()
		if err != nil {
			t.Fatal(err)
		}
		return e
	}
	open := compile(EgressPolicy{})
	strict := compile(EgressPolicy{BlockPrivate: true})
	allowing := compile(EgressPolicy{BlockPrivate: true, Allow: []string{"10.1.0.0/16", "192.168.1.20", "[::1]", "169.254.169.254"}})

	for _, c := range []struct {
		addr                   string
		open, strict, allowing string // "" when allowed, else the reason
	}{
		// Refused by default: metadata and link-local, in any spelling.
		{"169.254.169.254", "a cloud metadata address", "a cloud metadata address", ""},
		{"::ffff:169.254.169.254", "a cloud metadata address", "a cloud metadata address", ""},
		{"64:ff9b::a9fe:a9fe", "a cloud metadata address", "a cloud metadata address", ""},
		{"fd00:ec2::254", "a cloud metadata address", "a cloud metadata address", "a cloud metadata address"},
		{"100.100.100.200", "a cloud metadata address", "a cloud metadata address", "a cloud metadata address"},
		{"169.254.10.1", "a link-local address", "a link-local address", "a link-local address"},
		{"fe80::1%eth0", "a link-local address", "a link-local address", "a link-local address"},
		// Reachable by default (a local model server), refused when strict.
		{"127.0.0.1", "", "a loopback address", "a loopback address"},
		{"::1", "", "a loopback address", ""},
		{"10.1.2.3", "", "a private address", ""},
		{"10.2.0.1", "", "a private address", "a private address"},
		{"172.16.0.9", "", "a private address", "a private address"},
		{"192.168.1.20", "", "a private address", ""},
		{"fd12::1", "", "a private address", "a private address"},
		{"100.64.0.1", "", "a shared (carrier-grade NAT) address", "a shared (carrier-grade NAT) address"},
		{"0.0.0.0", "", "an unspecified address", "an unspecified address"},
		{"0.1.2.3", "", "an unspecified address", "an unspecified address"},
		{"::", "", "an unspecified address", "an unspecified address"},
		{"239.1.1.1", "", "a multicast address", "a multicast address"},
		// Public addresses are always reachable.
		{"8.8.8.8", "", "", ""},
		{"2001:4860:4860::8888", "", "", ""},
		{"64:ff9b::808:808", "", "", ""},
	} {
		ip := netip.MustParseAddr(c.addr)
		for _, p := range []struct {
			name string
			e    *egress
			want string
		}{{"open", open, c.open}, {"strict", strict, c.strict}, {"allowing", allowing, c.allowing}} {
			if got := p.e.refusal(ip); got != p.want {
				t.Errorf("%s, %s policy: %q, want %q", c.addr, p.name, got, p.want)
			}
		}
	}
}

func TestEgressValidate(t *testing.T) {
	for _, ok := range []string{"ollama", "Ollama.", "gpu-box.lan", "10.0.0.0/8", "192.168.1.20", "::1", "[fd00::1]", " lm-studio "} {
		if err := (EgressPolicy{Allow: []string{ok}}).Validate(); err != nil {
			t.Errorf("%q: %v", ok, err)
		}
	}
	for _, bad := range []string{"http://ollama:11434", "ollama:11434", "10.0.0.0/33", "a/b", "user@host"} {
		if err := (EgressPolicy{Allow: []string{bad}}).Validate(); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

func get(t *testing.T, c *http.Client, u string) (string, error) {
	t.Helper()
	resp, err := c.Get(u)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return string(b), nil
}

func TestHTTPClientChecksTheDialledAddress(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "hello") }))
	defer srv.Close()
	u, _ := url.Parse(srv.URL)
	byName := "http://localhost:" + u.Port()

	client := func(p EgressPolicy) *http.Client {
		c, err := NewHTTPClient(p)
		if err != nil {
			t.Fatal(err)
		}
		return c
	}
	// The default policy reaches a server on loopback, by address or name.
	for _, target := range []string{srv.URL, byName} {
		if body, err := get(t, client(EgressPolicy{}), target); err != nil || body != "hello" {
			t.Errorf("%s: %q, %v", target, body, err)
		}
	}
	// A strict policy refuses it, whatever name leads there.
	for _, target := range []string{srv.URL, byName} {
		_, err := get(t, client(EgressPolicy{BlockPrivate: true}), target)
		var ae *AddressError
		if !errors.As(err, &ae) || !ae.Addr.IsLoopback() {
			t.Errorf("%s: got %v, want a refused loopback address", target, err)
		}
		if got := TransportCause(err); !strings.HasSuffix(got, "is a loopback address, which AI providers may not connect to") {
			t.Errorf("%s: cause %q", target, got)
		}
	}
	// The allow list lets it through, by address or by the name in the URL.
	if body, err := get(t, client(EgressPolicy{BlockPrivate: true, Allow: []string{"127.0.0.0/8"}}), srv.URL); err != nil || body != "hello" {
		t.Errorf("allowed prefix: %q, %v", body, err)
	}
	if body, err := get(t, client(EgressPolicy{BlockPrivate: true, Allow: []string{"LOCALHOST"}}), byName); err != nil || body != "hello" {
		t.Errorf("allowed name: %q, %v", body, err)
	}
	if _, err := get(t, client(EgressPolicy{BlockPrivate: true, Allow: []string{"localhost"}}), srv.URL); err == nil {
		t.Error("an allowed name let its address through")
	}
}

// A URL naming a refused address fails before anything is dialled, so a
// proxy (which would make the connection itself) cannot be used to get
// past the policy.
func TestHTTPClientRefusesALiteralAddressBeforeAProxy(t *testing.T) {
	var proxied atomic.Int32
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { proxied.Add(1) }))
	defer proxy.Close()
	c, err := NewHTTPClient(EgressPolicy{})
	if err != nil {
		t.Fatal(err)
	}
	proxyURL, _ := url.Parse(proxy.URL)
	c.Transport.(*literalCheck).next.(*http.Transport).Proxy = http.ProxyURL(proxyURL)
	for _, target := range []string{"http://169.254.169.254/latest/meta-data/", "http://[fd00:ec2::254]/", "http://[::ffff:a9fe:a9fe]/"} {
		_, err := get(t, c, target)
		var ae *AddressError
		if !errors.As(err, &ae) || ae.Reason != "a cloud metadata address" {
			t.Errorf("%s: got %v", target, err)
		}
	}
	if n := proxied.Load(); n != 0 {
		t.Errorf("the proxy got %d requests", n)
	}
	// A name goes to the proxy, which resolves it.
	if _, err := get(t, c, "http://metadata.example/"); err != nil || proxied.Load() != 1 {
		t.Errorf("proxied %d, err %v", proxied.Load(), err)
	}
}

func TestHTTPClientFollowsRedirectsOnlyWithinTheOrigin(t *testing.T) {
	var reached atomic.Int32
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { reached.Add(1) }))
	defer other.Close()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/old":
			http.Redirect(w, r, "/new", http.StatusMovedPermanently)
		case "/new":
			io.WriteString(w, "moved "+r.Header.Get("X-Api-Key"))
		case "/away":
			http.Redirect(w, r, other.URL+"/steal", http.StatusTemporaryRedirect)
		}
	}))
	defer srv.Close()
	c, err := NewHTTPClient(EgressPolicy{})
	if err != nil {
		t.Fatal(err)
	}
	send := func(path string) (*http.Response, error) {
		req, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, srv.URL+path, nil)
		req.Header.Set("X-Api-Key", "sk-secret")
		return c.Do(req)
	}
	resp, err := send("/old")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(body) != "moved sk-secret" {
		t.Errorf("same origin: %q", body)
	}
	_, err = send("/away")
	var re *RedirectError
	if !errors.As(err, &re) || !strings.HasPrefix(re.To, "http://127.0.0.1:") {
		t.Errorf("got %v, want a refused redirect", err)
	}
	if !strings.Contains(TransportCause(err), "redirected to another origin") {
		t.Errorf("cause %q", TransportCause(err))
	}
	if n := reached.Load(); n != 0 {
		t.Errorf("the other origin got %d requests", n)
	}
}
