package agent

import (
	"context"
	"io"
	"net/http"
	"omnidesk-monitor/protocol"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const discoveryFixture = `{"success":true,"ip":"8.8.8.8","country":"Japan","region":"Tokyo","city":"Tokyo","connection":{"org":"Synthetic Cloud","isp":"Synthetic Upstream","asn":64500},"timezone":{"id":"Asia/Tokyo"}}`

type discoveryRoundTrip func(*http.Request) (*http.Response, error)

func (f discoveryRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestDiscoveryParsingAndPrivateIPs(t *testing.T) {
	d, err := parseDiscovery([]byte(discoveryFixture))
	if err != nil {
		t.Fatal(err)
	}
	if d.Provider != "Synthetic Cloud" || d.Region != "Japan / Tokyo" || d.Timezone != "Asia/Tokyo" || d.ASN != "AS64500" || d.Source != "ipwho.is" {
		t.Fatalf("unexpected discovery: %+v", d)
	}
	for _, ip := range []string{"127.0.0.1", "10.0.0.1", "100.64.0.1", "169.254.169.254", "172.16.1.1", "192.168.0.1", "192.0.2.1", "198.51.100.1", "203.0.113.1", "224.1.1.1", "240.0.0.1", "::1", "::ffff:8.8.8.8", "fc00::1", "fe80::1", "2001:db8::1"} {
		if publicDiscoveryIP(ip) {
			t.Errorf("private IP accepted: %s", ip)
		}
	}
	if !publicDiscoveryIP("2606:4700:4700::1111") {
		t.Fatal("public IPv6 rejected")
	}
	for _, bad := range []string{`{"success":false}`, strings.Replace(discoveryFixture, "8.8.8.8", "10.1.2.3", 1), "not json"} {
		if _, err = parseDiscovery([]byte(bad)); err == nil {
			t.Fatal("invalid response accepted")
		}
	}
	d, err = parseDiscovery([]byte(strings.Replace(discoveryFixture, `"org":"Synthetic Cloud"`, `"org":""`, 1)))
	if err != nil || d.Provider != "Synthetic Upstream" {
		t.Fatal("ISP fallback", err)
	}
	d, err = parseDiscovery([]byte(strings.Replace(discoveryFixture, "Asia/Tokyo", "Invalid/Zone", 1)))
	if err != nil || d.Timezone != "" {
		t.Fatal("invalid timezone accepted", err)
	}
}
func TestDiscoveryHTTPBoundsAndNoCredentials(t *testing.T) {
	for _, test := range []struct {
		body   string
		status int
		valid  bool
	}{{discoveryFixture, 200, true}, {strings.Repeat("x", 17000), 200, false}, {"not json", 200, false}, {"{}", 429, false}, {"{}", 302, false}} {
		client := &http.Client{Transport: discoveryRoundTrip(func(r *http.Request) (*http.Response, error) {
			if r.URL.Scheme != "https" || r.URL.Host != "ipwho.is" || r.Header.Get("Authorization") != "" {
				t.Fatal("unexpected endpoint or leaked credentials")
			}
			deadline, ok := r.Context().Deadline()
			if !ok || time.Until(deadline) > 5*time.Second {
				t.Fatal("missing lookup deadline")
			}
			return &http.Response{StatusCode: test.status, Body: io.NopCloser(strings.NewReader(test.body)), Header: make(http.Header), Request: r}, nil
		}), CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		value, err := lookupDiscovery(context.Background(), client)
		if test.valid != (err == nil && value != nil) {
			t.Fatalf("status %d validity mismatch: %v", test.status, err)
		}
	}
}
func TestDiscoverySurvivesAgentRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	s, err := LoadState(path)
	if err != nil {
		t.Fatal(err)
	}
	s.Discovered = &protocol.Discovery{IP: "8.8.8.8", Provider: "Synthetic Cloud", Source: "ipwho.is", DetectedAt: time.Now().UnixMilli()}
	s.DiscoveryAttemptAt = time.Now().UnixMilli()
	if err = SaveState(path, s); err != nil {
		t.Fatal(err)
	}
	restored, err := LoadState(path)
	if err != nil {
		t.Fatal(err)
	}
	if restored.Discovered == nil || *restored.Discovered != *s.Discovered || restored.DiscoveryAttemptAt != s.DiscoveryAttemptAt {
		t.Fatal("discovery or retry cache lost")
	}
}
