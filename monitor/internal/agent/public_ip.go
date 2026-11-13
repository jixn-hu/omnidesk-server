package agent

import (
	"context"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

type PublicIP struct {
	RefreshID   string `json:"refreshId,omitempty"`
	IPv4        string `json:"ipv4,omitempty"`
	IPv6        string `json:"ipv6,omitempty"`
	IPv4At      int64  `json:"ipv4At,omitempty"`
	IPv6At      int64  `json:"ipv6At,omitempty"`
	AttemptedAt int64  `json:"attemptedAt"`
	IPv4Failed  bool   `json:"ipv4Failed"`
	IPv6Failed  bool   `json:"ipv6Failed"`
}

func probePublicIP(ctx context.Context, network, url string) (string, error) {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	dialer := &net.Dialer{Timeout: 5 * time.Second}
	transport.DialContext = func(ctx context.Context, _ string, address string) (net.Conn, error) {
		return dialer.DialContext(ctx, network, address)
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{Timeout: 6 * time.Second, Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	request, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return "", err
	}
	response, err := client.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 129))
	if err != nil {
		return "", err
	}
	ip := strings.TrimSpace(string(body))
	if response.StatusCode != 200 || len(body) > 128 || !publicDiscoveryIP(ip) || (network == "tcp4") != strings.Contains(ip, ".") {
		return "", &net.AddrError{Err: "invalid public IP", Addr: ""}
	}
	return ip, nil
}
func lookupPublicIPs(ctx context.Context, previous *PublicIP) *PublicIP {
	result := PublicIP{}
	if previous != nil {
		result = *previous
	}
	result.AttemptedAt = time.Now().UnixMilli()
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		ip, err := probePublicIP(ctx, "tcp4", "https://api.ipify.org")
		result.IPv4Failed = err != nil
		if err == nil {
			result.IPv4 = ip
			result.IPv4At = time.Now().UnixMilli()
		}
	}()
	go func() {
		defer wg.Done()
		ip, err := probePublicIP(ctx, "tcp6", "https://api6.ipify.org")
		result.IPv6Failed = err != nil
		if err == nil {
			result.IPv6 = ip
			result.IPv6At = time.Now().UnixMilli()
		}
	}()
	wg.Wait()
	return &result
}
