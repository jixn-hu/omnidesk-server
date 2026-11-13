package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/netip"
	"omnidesk-monitor/protocol"
	"strings"
	"time"
	_ "time/tzdata"
	"unicode"
)

const discoveryURL = "https://ipwho.is/?fields=success,ip,country,region,city,connection,timezone.id"

var excludedDiscoveryIPs = func() []netip.Prefix {
	var result []netip.Prefix
	for _, value := range []string{"0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4", "2001:db8::/32", "2001::/32", "2001:10::/28", "2001:20::/28", "2001:2::/48"} {
		result = append(result, netip.MustParsePrefix(value))
	}
	return result
}()

func publicDiscoveryIP(value string) bool {
	ip, err := netip.ParseAddr(value)
	if err != nil || ip.Zone() != "" || ip.Is4In6() {
		return false
	}
	if ip.Is6() && !netip.MustParsePrefix("2000::/3").Contains(ip) {
		return false
	}
	for _, prefix := range excludedDiscoveryIPs {
		if prefix.Contains(ip) {
			return false
		}
	}
	return true
}
func discoveryText(value string) string {
	value = strings.TrimSpace(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, value))
	chars := []rune(value)
	if len(chars) > 160 {
		return string(chars[:160])
	}
	return value
}
func lookupDiscovery(ctx context.Context, client *http.Client) (*protocol.Discovery, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", discoveryURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("IP discovery HTTP %d", res.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, 16385))
	if err != nil {
		return nil, err
	}
	if len(body) > 16384 {
		return nil, errors.New("IP discovery response too large")
	}
	return parseDiscovery(body)
}
func parseDiscovery(body []byte) (*protocol.Discovery, error) {
	var v struct {
		Success    bool   `json:"success"`
		IP         string `json:"ip"`
		Country    string `json:"country"`
		Region     string `json:"region"`
		City       string `json:"city"`
		Connection struct {
			Org string `json:"org"`
			ISP string `json:"isp"`
			ASN int64  `json:"asn"`
		} `json:"connection"`
		Timezone struct {
			ID string `json:"id"`
		} `json:"timezone"`
	}
	if err := json.Unmarshal(body, &v); err != nil {
		return nil, err
	}
	if !v.Success || !publicDiscoveryIP(v.IP) {
		return nil, errors.New("IP discovery returned no public location")
	}
	d := &protocol.Discovery{IP: v.IP, Provider: discoveryText(v.Connection.Org), Country: discoveryText(v.Country), City: discoveryText(v.City), Source: "ipwho.is", DetectedAt: time.Now().UnixMilli()}
	if d.Provider == "" {
		d.Provider = discoveryText(v.Connection.ISP)
	}
	var parts []string
	for _, value := range []string{d.Country, discoveryText(v.Region), d.City} {
		found := false
		for _, part := range parts {
			if part == value {
				found = true
			}
		}
		if value != "" && !found {
			parts = append(parts, value)
		}
	}
	d.Region = strings.Join(parts, " / ")
	if _, err := time.LoadLocation(v.Timezone.ID); err == nil {
		d.Timezone = discoveryText(v.Timezone.ID)
	}
	if v.Connection.ASN > 0 && v.Connection.ASN <= 9007199254740991 {
		d.ASN = fmt.Sprintf("AS%d", v.Connection.ASN)
	}
	return d, nil
}
