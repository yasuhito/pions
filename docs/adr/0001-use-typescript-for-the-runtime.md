---
status: accepted
---

# Use TypeScript for the Pions runtime

Pions will implement its runtime, state model, and Pi/Herdr adapters in TypeScript on Node rather than introducing a Python supervisor. This reduces cross-language dependencies and aligns the implementation with Pi's native extension/session interfaces. `nicobailon/pi-subagents` is a primary reference implementation, but Pions will not copy its parent-first completion or unacknowledged subtree-stop semantics and will not adopt it as a dependency without a separate decision.
