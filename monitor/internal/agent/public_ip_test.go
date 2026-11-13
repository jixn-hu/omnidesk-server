package agent

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPublicIPProbeValidatesFamilyStatusAndResponse(t *testing.T) {
	response := "8.8.8.8"
	status := 200
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(status); _, _ = w.Write([]byte(response)) }))
	defer server.Close()
	ip, e := probePublicIP(context.Background(), "tcp4", server.URL)
	if e != nil || ip != "8.8.8.8" {
		t.Fatal(ip, e)
	}
	for _, body := range []string{"127.0.0.1", "192.168.1.2", "2001:4860:4860::8888", strings.Repeat("x", 130)} {
		response = body
		if _, e = probePublicIP(context.Background(), "tcp4", server.URL); e == nil {
			t.Fatal("accepted invalid IP", body)
		}
	}
	response = "8.8.8.8"
	status = 503
	if _, e = probePublicIP(context.Background(), "tcp4", server.URL); e == nil {
		t.Fatal("accepted unsuccessful service")
	}
}
func TestConfigDefaultAndLongIntervals(t *testing.T) {
	c := Config{ServerURL: "https://cloud.example.com/v1/monitor", Token: "synthetic-node-token-for-testing"}
	if e := ValidateConfig(&c); e != nil || c.IntervalSeconds != 60 {
		t.Fatal(c, e)
	}
	for _, seconds := range []int{5, 600, 3600, 86400} {
		c.IntervalSeconds = seconds
		if e := ValidateConfig(&c); e != nil {
			t.Fatal(seconds, e)
		}
	}
	for _, seconds := range []int{4, -1, 86401} {
		c.IntervalSeconds = seconds
		if ValidateConfig(&c) == nil {
			t.Fatal("accepted invalid interval", seconds)
		}
	}
}
