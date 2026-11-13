# Third-party notices

OmniDesk's own backend and collector code is licensed under MIT. Third-party code retains its own license. Dependency versions are recorded in `package-lock.json`, `monitor/go.mod` and `monitor/go.sum`.

The Node.js service uses Express (MIT), ssh2 (MIT) and ws (MIT), plus their transitive dependencies. The monitor uses gopsutil and modernc.org/sqlite and their transitive dependencies. Go, Node.js and container base images retain their respective runtime and component licenses. Review and retain the license files supplied with the exact dependencies and images when redistributing.

The PC client builds collector binaries with dependency license manifests in its packaged `resources/monitor-agent/licenses/` directory. Client source and notices: https://github.com/jixn-hu/omnidesk.
