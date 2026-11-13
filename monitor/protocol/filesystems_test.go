package protocol

import (
	"encoding/json"
	"os"
	"testing"
)

func TestMonitorFilesystem(t *testing.T) {
	data, err := os.ReadFile("testdata/filesystems.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		FsType   string
		Mount    string
		Included bool
	}
	if err = json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		if got := MonitorFilesystem(c.FsType, c.Mount); got != c.Included {
			t.Errorf("%s %s: got %t", c.FsType, c.Mount, got)
		}
	}
}
