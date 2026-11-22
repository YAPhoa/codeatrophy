package ai

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"syscall"
	"time"
)

// EgressPolicy decides which network addresses AI providers may connect to.
// A provider's base URL is chosen by whoever can edit the AI settings, and
// the connection test and model listing show part of the answer, so without
// a policy the server could be made to fetch from addresses only it can
// reach (server-side request forgery).
//
// The zero value suits a self-hosted instance: cloud metadata and other
// link-local addresses are refused, while loopback and private networks,
// where a local model server usually runs, stay reachable.
type EgressPolicy struct {
	// BlockPrivate also refuses loopback, private, shared (carrier-grade
	// NAT), unspecified and multicast addresses, for instances whose users
	// should not reach the server's own network.
	BlockPrivate bool
	// Allow lists host names, IP addresses and CIDR prefixes that may be
	// connected to whatever the rules above say, such as a local model
	// server when BlockPrivate is set. A name matches the host of a base
	// URL exactly (case-insensitively); it is not resolved in advance.
	Allow []string
}

// Validate reports an Allow entry that is not a host name, an IP address
// or a CIDR prefix.
func (p EgressPolicy) Validate() error {
	_, err := p.compile()
	return err
}

// AddressError is the failure to connect to an address the egress policy
// refuses. Its message is safe to show to users.
type AddressError struct {
	Addr   netip.Addr
	Reason string // such as "a link-local address"
}

func (e *AddressError) Error() string {
	return fmt.Sprintf("%s is %s, which AI providers may not connect to", e.Addr, e.Reason)
}

// Addresses that cloud platforms serve instance metadata (and credentials)
// on, refused even though some fall outside the link-local ranges.
var metadataAddrs = []netip.Addr{
	netip.MustParseAddr("169.254.169.254"), // AWS, Azure, GCP, Oracle, DigitalOcean, ...
	netip.MustParseAddr("fd00:ec2::254"),   // AWS over IPv6
	netip.MustParseAddr("100.100.100.200"), // Alibaba Cloud
}

var (
	sharedPrefix = netip.MustParsePrefix("100.64.0.0/10") // carrier-grade NAT
	thisNetwork  = netip.MustParsePrefix("0.0.0.0/8")
	nat64Prefix  = netip.MustParsePrefix("64:ff9b::/96")
)

// egress is a compiled EgressPolicy.
type egress struct {
	blockPrivate bool
	names        map[string]bool
	prefixes     []netip.Prefix
}

func (p EgressPolicy) compile() (*egress, error) {
	e := &egress{blockPrivate: p.BlockPrivate, names: map[string]bool{}}
	for _, raw := range p.Allow {
		s := strings.TrimSpace(raw)
		if s == "" {
			continue
		}
		if pfx, err := netip.ParsePrefix(s); err == nil {
			e.prefixes = append(e.prefixes, pfx.Masked())
			continue
		}
		if ip, err := netip.ParseAddr(strings.TrimSuffix(strings.TrimPrefix(s, "["), "]")); err == nil {
			ip = ip.Unmap().WithZone("")
			e.prefixes = append(e.prefixes, netip.PrefixFrom(ip, ip.BitLen()))
			continue
		}
		if strings.ContainsAny(s, ":/[]@ ") {
			return nil, fmt.Errorf("%q is not a host name, an IP address or a CIDR prefix (leave out the scheme and the port)", s)
		}
		e.names[normalizeHost(s)] = true
	}
	return e, nil
}

func normalizeHost(h string) string { return strings.TrimSuffix(strings.ToLower(h), ".") }

// refusal says why ip may not be connected to, or "" when it may.
func (e *egress) refusal(ip netip.Addr) string {
	ip = ip.Unmap().WithZone("")
	for _, p := range e.prefixes {
		if p.Contains(ip) {
			return ""
		}
	}
	if nat64Prefix.Contains(ip) {
		// A NAT64 gateway forwards to the IPv4 address in the last 32 bits.
		b := ip.As16()
		if why := e.refusal(netip.AddrFrom4([4]byte{b[12], b[13], b[14], b[15]})); why != "" {
			return why
		}
	}
	for _, m := range metadataAddrs {
		if ip == m {
			return "a cloud metadata address"
		}
	}
	if ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
		return "a link-local address"
	}
	if !e.blockPrivate {
		return ""
	}
	switch {
	case ip.IsLoopback():
		return "a loopback address"
	case ip.IsPrivate():
		return "a private address"
	case sharedPrefix.Contains(ip):
		return "a shared (carrier-grade NAT) address"
	case ip.IsUnspecified() || thisNetwork.Contains(ip):
		return "an unspecified address"
	case ip.IsMulticast():
		return "a multicast address"
	}
	return ""
}

// check refuses an address given as "ip:port" or "ip".
func (e *egress) check(address string) error {
	host := address
	if h, _, err := net.SplitHostPort(address); err == nil {
		host = h
	}
	ip, err := netip.ParseAddr(host)
	if err != nil {
		return fmt.Errorf("unexpected address %q", address)
	}
	if why := e.refusal(ip); why != "" {
		return &AddressError{Addr: ip.Unmap().WithZone(""), Reason: why}
	}
	return nil
}

// NewHTTPClient returns the HTTP client AI providers use. It connects only
// to addresses the policy allows, checked on the address actually dialled
// (after DNS resolution, so a name cannot be pointed somewhere else between
// a check and the connection), and it does not follow a redirect to another
// origin (RedirectError): providers send API keys in headers such as
// X-Api-Key, which Go would forward there.
//
// Behind an HTTP proxy (HTTP_PROXY, HTTPS_PROXY) the proxy resolves names,
// so only base URLs given as IP addresses are checked against the policy;
// the proxy's own address is checked when it is dialled.
func NewHTTPClient(p EgressPolicy) (*http.Client, error) {
	e, err := p.compile()
	if err != nil {
		return nil, err
	}
	dialer := &net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}
	guarded := *dialer
	guarded.Control = func(_, address string, _ syscall.RawConn) error { return e.check(address) }
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		if host, _, err := net.SplitHostPort(addr); err == nil && e.names[normalizeHost(host)] {
			return dialer.DialContext(ctx, network, addr)
		}
		return guarded.DialContext(ctx, network, addr)
	}
	return &http.Client{
		Transport:     &literalCheck{next: tr, e: e},
		CheckRedirect: sameOriginRedirects,
	}, nil
}

// literalCheck refuses a request whose URL names a refused IP address
// before it reaches a proxy, which would otherwise make the connection.
type literalCheck struct {
	next http.RoundTripper
	e    *egress
}

func (t *literalCheck) RoundTrip(req *http.Request) (*http.Response, error) {
	host := req.URL.Hostname()
	if _, err := netip.ParseAddr(host); err == nil && !t.e.names[normalizeHost(host)] {
		if err := t.e.check(host); err != nil {
			if req.Body != nil {
				req.Body.Close()
			}
			return nil, err
		}
	}
	return t.next.RoundTrip(req)
}

// RedirectError is a redirect to another origin, which the client does not
// follow. Its message is safe to show to users.
type RedirectError struct {
	To string // the origin redirected to
}

func (e *RedirectError) Error() string {
	return "the provider redirected to another origin (" + e.To + "), which is not followed"
}

// sameOriginRedirects follows redirects within the origin of the first
// request, at most 10, and refuses any other.
func sameOriginRedirects(req *http.Request, via []*http.Request) error {
	if len(via) >= 10 {
		return errors.New("stopped after 10 redirects")
	}
	if to := origin(req.URL); to != origin(via[0].URL) {
		return &RedirectError{To: to}
	}
	return nil
}

func origin(u *url.URL) string {
	port := u.Port()
	if port == "" {
		switch u.Scheme {
		case "http":
			port = "80"
		case "https":
			port = "443"
		}
	}
	host := normalizeHost(u.Hostname())
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	return u.Scheme + "://" + host + ":" + port
}

// TransportCause describes why a request got no response, for a message
// shown to users: the egress policy's refusal when that was the reason,
// else the underlying network error without the request's URL.
func TransportCause(err error) string {
	var ae *AddressError
	if errors.As(err, &ae) {
		return ae.Error()
	}
	var re *RedirectError
	if errors.As(err, &re) {
		return re.Error()
	}
	var ue *url.Error
	if errors.As(err, &ue) {
		return ue.Err.Error()
	}
	return err.Error()
}
