---
status: accepted
---

# Use an authenticated local protocol for visible workers

Pions will launch each visible worker through a private per-Operation configuration file and receive lifecycle and Result frames over a Unix domain socket, rather than passing prompts or authority in process arguments or deriving completion from terminal screen state. The wrapper may consume Pi's machine-readable lifecycle event stream directly; rendered terminal contents remain presentation evidence only. The versioned protocol authenticates every child frame with at least 256 bits of Operation authority, enforces monotonic sequence numbers and bounded frames, and acknowledges a Result only after durable acceptance so transport retries cannot manufacture or erase semantic completion.
