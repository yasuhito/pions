# Pions domain glossary

## Operation

A durable, uniquely identified request for one worker execution. An operation owns its lifecycle evidence, result, lineage, effective policy, and presentation identity.

## Worker

The executor assigned to one operation. A worker's process or visible terminal state is liveness evidence, not proof of semantic completion.

## Result

The durable semantic output accepted from one worker. An operation refers to its result by location, byte count, and digest; reconstruction returns the output only after its integrity is verified.

## Runtime

The caller-facing module that starts operations, returns their results, and cancels operation subtrees. Callers do not coordinate backend, persistence, child-channel, or presentation details directly.

## Self-settlement

The point at which a worker has produced its own success or failure outcome. Self-settlement is distinct from terminal completion when descendants or result handoffs remain outstanding.

## Terminal completion

The immutable end of an operation after its own outcome is durable and every required descendant and result handoff has settled.

## Presentation

A projection of operation state for humans or external observers. Presentation can report liveness and attention, but cannot create or override semantic operation state.
