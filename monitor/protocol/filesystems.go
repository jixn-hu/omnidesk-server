package protocol

import "strings"

// MonitorFilesystem excludes image/virtual filesystems, keeping writable loop,
// container root, network and ordinary data filesystems eligible for alarms.
func MonitorFilesystem(fsType, mount string) bool {
	kind := strings.ToLower(strings.TrimSpace(fsType))
	switch kind {
	case "squashfs", "iso9660", "udf", "erofs", "cramfs", "romfs",
		"tmpfs", "devtmpfs", "proc", "sysfs", "cgroup", "cgroup2", "nsfs", "tracefs", "debugfs",
		"securityfs", "configfs", "fusectl", "mqueue", "pstore", "hugetlbfs", "autofs",
		"rpc_pipefs", "binfmt_misc", "ramfs", "bpf":
		return false
	}
	return kind != "" || (!strings.HasPrefix(mount, "/snap/") && !strings.HasPrefix(mount, "/var/lib/snapd/snap/"))
}
