package agent

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestPersistentCounterAndReboot(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	s, e := LoadState(path)
	if e != nil {
		t.Fatal(e)
	}
	s.Advance(100, map[string]Counter{"eth0": {Up: 100, Down: 200}})
	up, down, gap := s.Advance(100, map[string]Counter{"eth0": {Up: 130, Down: 250}})
	if up != 30 || down != 50 || gap {
		t.Fatal("bad ordinary delta")
	}
	if e = SaveState(path, s); e != nil {
		t.Fatal(e)
	}
	s, e = LoadState(path)
	if e != nil {
		t.Fatal(e)
	}
	s.Advance(100, map[string]Counter{"eth0": {Up: 150, Down: 270}})
	if s.Upload != 50 || s.Download != 70 {
		t.Fatal("agent restart lost counters")
	}
	up, down, gap = s.Advance(200, map[string]Counter{"eth0": {Up: 5, Down: 10}})
	if up != 5 || down != 10 || !gap || s.Upload != 55 {
		t.Fatal("VPS reboot not handled")
	}
}
func TestCorruptStateIsNotSilentlyReset(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	os.WriteFile(path, []byte("broken"), 0600)
	if _, e := LoadState(path); e == nil {
		t.Fatal("corrupt ledger reset")
	}
	b, _ := os.ReadFile(path)
	if string(b) != "broken" {
		t.Fatal("overwrote corrupt state")
	}
}
func TestNetworkSelectionAndTLS(t *testing.T) {
	if allowedOnOS("docker0", nil, "linux") || allowedOnOS("veth123", nil, "linux") || !Allowed("eth0", nil) || !Allowed("wg0", []string{"wg*"}) {
		t.Fatal("NIC selection")
	}
	c := Config{ServerURL: "http://monitor.example.com/v1/monitor", Token: "123456789012345678901234"}
	if ValidateConfig(&c) == nil {
		t.Fatal("plaintext public service accepted by default")
	}
	c.AllowInsecure = true
	if e := ValidateConfig(&c); e != nil {
		t.Fatal(e)
	}
	c.ServerURL = "https://user:secret@example.com"
	if ValidateConfig(&c) == nil {
		t.Fatal("URL credentials accepted")
	}
}

func TestMissingNetworkPreservesCounters(t *testing.T) {
	s, err := LoadState(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	s.Advance(100, map[string]Counter{"tap-primary": {Up: 100, Down: 200}})
	s.Advance(100, map[string]Counter{"tap-primary": {Up: 150, Down: 270}})
	up, down, gap := s.Advance(100, map[string]Counter{})
	if up != 0 || down != 0 || !gap || s.Sequence != 3 || s.Upload != 50 || s.Download != 70 || s.Previous["tap-primary"].Up != 150 {
		t.Fatalf("missing network must keep the durable baseline and mark incomplete: %+v", s)
	}
	up, down, gap = s.Advance(100, map[string]Counter{"tap-primary": {Up: 190, Down: 330}})
	if up != 40 || down != 60 || gap || s.Upload != 90 || s.Download != 130 {
		t.Fatalf("recovery must count from the last available baseline: up=%d down=%d gap=%v", up, down, gap)
	}
	s.Advance(200, nil)
	up, down, gap = s.Advance(200, map[string]Counter{"tap-primary": {Up: 5, Down: 10}})
	if up != 5 || down != 10 || !gap || s.Upload != 95 || s.Download != 140 {
		t.Fatal("missing network across a reboot lost the old boot baseline")
	}
}

func TestWindowsDefaultIncludesTap(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows default NIC selection")
	}
	for _, name := range []string{"tapbe27fe05-d2", "TAP-Windows Adapter V9", "tun0", "wg0", "Ethernet", "Ethernet 2"} {
		if !Allowed(name, nil) {
			t.Errorf("Windows must retain a usable adapter named %q", name)
		}
	}
}

func TestNetworkSelectionByOS(t *testing.T) {
	for _, tc := range []struct {
		platform, name string
		include        []string
		want           bool
	}{
		{"windows", "tapbe27fe05-d2", nil, true},
		{"windows", "TAP-Windows Adapter V9", nil, true},
		{"windows", "tun0", nil, true},
		{"windows", "wg0", nil, true},
		{"windows", "Local Area Connection", nil, true},
		{"windows", "Loopback Pseudo-Interface 1", nil, false},
		{"windows", "vEthernet (Default Switch)", nil, false},
		{"windows", "vEthernet (Default Switch)", []string{"vEthernet*"}, true},
		{"windows", "tap-primary", []string{"Ethernet*"}, false},
		{"linux", "tap-primary", nil, false},
		{"linux", "tun0", nil, false},
		{"linux", "wg0", nil, false},
		{"linux", "docker0", nil, false},
		{"linux", "veth123", nil, false},
		{"linux", "eth0", nil, true},
		{"linux", "ens3", nil, true},
		{"linux", "tap-primary", []string{"tap*"}, true},
	} {
		if got := allowedOnOS(tc.name, tc.include, tc.platform); got != tc.want {
			t.Errorf("%s %s include=%v got=%v want=%v", tc.platform, tc.name, tc.include, got, tc.want)
		}
	}
}
