import Base

# A projection of reducer.ts. Invalid events leave the last durable state intact.
# Envelope validation, payload integrity and identity checks remain in TypeScript.
type Phase is Data:
  Queued{}
  Starting{}
  Running{}
  Cancelling{}
  Completed{}
  Failed{}
  Cancelled{}
  UnknownPhase{}

type Action is Data:
  Requested{}
  PresentationOwned{}
  StartingWork{}
  WorkerLaunched{}
  StartAcknowledged{}
  ResultAccepted{}
  StopConfirmed{}
  Complete{}
  MarkFailed{}
  CancelRequested{epoch: Nat}
  CancelDispatched{epoch: Nat}
  CancelAcknowledged{epoch: Nat}
  Cancel{epoch: Nat}
  UnknownLiveness{}
  UnknownCancel{epoch: Nat}
  AuthorityAcquired{generation: Nat}
  AuthorityRevoked{generation: Nat}
  GenerationConfirmed{generation: Nat}
  CleanupStarted{}
  CleanupFinished{}

type Occurrence is Data:
  Occurrence{seq: Nat, action: Action}

type Facts is Data:
  Facts{owned: Bool, launched: Bool, accepted: Bool, stopped: Bool, epoch: Nat,
        authority: Maybe<&2, Nat>, revoked: Maybe<&2, Nat>, pending: Maybe<&2, Nat>, confirmed: Maybe<&2, Nat>, cleanup: Nat}

type State is Data:
  State{phase: Phase, seq: Nat, facts: Facts}

type Decision is Data:
  Keep{}
  Change{phase: Phase, facts: Facts}

def initial() -> Facts:
  Facts{False{}, False{}, False{}, False{}, 0n, None{}, None{}, None{}, None{}, 0n}

def owned(f: Facts) -> Bool:
  match f:
    case Facts{owned, _, _, _, _, _, _, _, _, _}: owned

def launched(f: Facts) -> Bool:
  match f:
    case Facts{_, launched, _, _, _, _, _, _, _, _}: launched

def accepted(f: Facts) -> Bool:
  match f:
    case Facts{_, _, accepted, _, _, _, _, _, _, _}: accepted

def stopped(f: Facts) -> Bool:
  match f:
    case Facts{_, _, _, stopped, _, _, _, _, _, _}: stopped

def epoch(f: Facts) -> Nat:
  match f:
    case Facts{_, _, _, _, epoch, _, _, _, _, _}: epoch

def authority(f: Facts) -> Maybe<&2, Nat>:
  match f:
    case Facts{_, _, _, _, _, authority, _, _, _, _}: authority

def revoked(f: Facts) -> Maybe<&2, Nat>:
  match f:
    case Facts{_, _, _, _, _, _, revoked, _, _, _}: revoked

def pending(f: Facts) -> Maybe<&2, Nat>:
  match f:
    case Facts{_, _, _, _, _, _, _, pending, _, _}: pending

def confirmed(f: Facts) -> Maybe<&2, Nat>:
  match f:
    case Facts{_, _, _, _, _, _, _, _, confirmed, _}: confirmed

def cleanup(f: Facts) -> Nat:
  match f:
    case Facts{_, _, _, _, _, _, _, _, _, cleanup}: cleanup

def with_owned(f: Facts) -> Facts:
  match f:
    case Facts{_, l, a, s, e, auth, r, p, c, clean}: Facts{True{}, l, a, s, e, auth, r, p, c, clean}

def with_launched(f: Facts) -> Facts:
  match f:
    case Facts{o, _, a, s, e, auth, r, p, c, clean}: Facts{o, True{}, a, s, e, auth, r, p, c, clean}

def with_accepted(f: Facts) -> Facts:
  match f:
    case Facts{o, l, _, s, e, auth, r, p, c, clean}: Facts{o, l, True{}, s, e, auth, r, p, c, clean}

def with_stopped(f: Facts) -> Facts:
  match f:
    case Facts{o, l, a, _, e, auth, r, p, c, clean}: Facts{o, l, a, True{}, e, auth, r, p, c, clean}

def with_epoch(f: Facts, n: Nat) -> Facts:
  match f:
    case Facts{o, l, a, s, _, auth, r, p, c, clean}: Facts{o, l, a, s, n, auth, r, p, c, clean}

def with_authority(f: Facts, n: Nat) -> Facts:
  match f:
    case Facts{o, l, a, s, e, _, r, _, c, clean}: Facts{o, l, a, s, e, Some{n}, r, None{}, c, clean}

def with_confirmation(f: Facts, n: Nat) -> Facts:
  match f:
    case Facts{o, l, a, s, e, auth, r, p, _, clean}: Facts{o, l, a, s, e, auth, r, p, Some{n}, clean}

def with_cleanup(f: Facts, n: Nat) -> Facts:
  match f:
    case Facts{o, l, a, s, e, auth, r, p, c, _}: Facts{o, l, a, s, e, auth, r, p, c, n}

def choose(valid: Bool, phase: Phase, f: Facts) -> Decision:
  match valid:
    case True{}: Change{phase, f}
    case False{}: Keep{}

def both(a: Bool, b: Bool) -> Bool:
  match a b:
    case True{} True{}: True{}
    case _ _: False{}

def completion_sound(state: Maybe<&2, State>) -> Bool:
  match state:
    case None{}: True{}
    case Some{State{phase, _, +facts}}:
      match phase:
        case Completed{}: both(accepted(facts), stopped(facts))
        case _: True{}

def absent(value: Maybe<&2, Nat>) -> Bool:
  match value:
    case None{}: True{}
    case Some{_}: False{}

def matches(value: Maybe<&2, Nat>, n: Nat) -> Bool:
  match value:
    case None{}: False{}
    case Some{stored}: Nat.is_eq(stored, n)

def can_acquire(auth: Maybe<&2, Nat>, confirmed: Maybe<&2, Nat>, n: Nat) -> Bool:
  match auth:
    case None{}: Nat.is_gt(n, 0n)
    case Some{_}: matches(confirmed, n)

def can_revoke(auth: Maybe<&2, Nat>, pending: Maybe<&2, Nat>, successor: Nat) -> Bool:
  match auth:
    case None{}: False{}
    case Some{old}: both(absent(pending), Nat.is_eq(successor, 1n+old))

def revoke(f: Facts, successor: Nat) -> Facts:
  match f:
    case Facts{o, l, a, s, e, Some{+old}, _, _, _, clean}:
      Facts{o, l, a, s, e, Some{old}, Some{old}, Some{successor}, None{}, clean}
    case other: other

def can_confirm(+f: Facts, +n: Nat) -> Bool:
  both(Bool.not(matches(revoked(f), n)), both(matches(pending(f), n), Bool.not(matches(confirmed(f), n))))

def can_cleanup(phase: Phase, +f: Facts) -> Bool:
  match phase:
    case Completed{}: both(owned(f), both(accepted(f), stopped(f)))
    case Cancelled{}: both(owned(f), stopped(f))
    case _: False{}

def transition(phase: Phase, +f: Facts, action: Action) -> Decision:
  match phase action:
    case Queued{} PresentationOwned{}:
      choose(Bool.not(owned(f)), Queued{}, with_owned(f))
    case Queued{} StartingWork{}:
      choose(owned(f), Starting{}, f)
    case Starting{} WorkerLaunched{}:
      choose(Bool.not(launched(f)), Starting{}, with_launched(f))
    # StartAcknowledged stands for a validated worker acknowledgement.
    case Starting{} StartAcknowledged{}:
      choose(launched(f), Running{}, f)
    case Running{} ResultAccepted{}:
      choose(Bool.not(accepted(f)), Running{}, with_accepted(f))
    case Starting{} StopConfirmed{}:
      choose(both(launched(f), Bool.not(stopped(f))), Starting{}, with_stopped(f))
    case Running{} StopConfirmed{}:
      choose(both(launched(f), Bool.not(stopped(f))), Running{}, with_stopped(f))
    case Running{} Complete{}:
      choose(both(accepted(f), stopped(f)), Completed{}, f)
    case Starting{} MarkFailed{}: Change{Failed{}, f}
    case Running{} MarkFailed{}: Change{Failed{}, f}
    case Queued{} CancelRequested{+n}:
      choose(Nat.is_gt(n, epoch(f)), Cancelling{}, with_epoch(f, n))
    case Starting{} CancelRequested{+n}:
      choose(Nat.is_gt(n, epoch(f)), Cancelling{}, with_epoch(f, n))
    case Running{} CancelRequested{+n}:
      choose(Nat.is_gt(n, epoch(f)), Cancelling{}, with_epoch(f, n))
    case Cancelling{} CancelDispatched{n}:
      choose(Nat.is_eq(n, epoch(f)), Cancelling{}, f)
    case Cancelling{} CancelAcknowledged{n}:
      choose(Nat.is_eq(n, epoch(f)), Cancelling{}, with_stopped(f))
    case Cancelling{} Cancel{n}:
      choose(both(Nat.is_eq(n, epoch(f)), stopped(f)), Cancelled{}, f)
    case Queued{} UnknownLiveness{}: Change{UnknownPhase{}, f}
    case Starting{} UnknownLiveness{}: Change{UnknownPhase{}, f}
    case Running{} UnknownLiveness{}: Change{UnknownPhase{}, f}
    case Cancelling{} UnknownCancel{n}:
      choose(Nat.is_eq(n, epoch(f)), UnknownPhase{}, f)
    case Starting{} AuthorityAcquired{+n}:
      choose(both(launched(f), can_acquire(authority(f), confirmed(f), n)), Starting{}, with_authority(f, n))
    case Running{} AuthorityAcquired{+n}:
      choose(both(launched(f), can_acquire(authority(f), confirmed(f), n)), Running{}, with_authority(f, n))
    case Starting{} AuthorityRevoked{+n}:
      choose(can_revoke(authority(f), pending(f), n), Starting{}, revoke(f, n))
    case Running{} AuthorityRevoked{+n}:
      choose(can_revoke(authority(f), pending(f), n), Running{}, revoke(f, n))
    case Starting{} GenerationConfirmed{+n}:
      choose(can_confirm(f, n), Starting{}, with_confirmation(f, n))
    case Running{} GenerationConfirmed{+n}:
      choose(can_confirm(f, n), Running{}, with_confirmation(f, n))
    case Completed{} CleanupStarted{}:
      choose(both(can_cleanup(phase, f), Nat.is_eq(cleanup(f), 0n)), Completed{}, with_cleanup(f, 1n))
    case Cancelled{} CleanupStarted{}:
      choose(both(can_cleanup(phase, f), Nat.is_eq(cleanup(f), 0n)), Cancelled{}, with_cleanup(f, 1n))
    case Completed{} CleanupFinished{}:
      choose(Nat.is_eq(cleanup(f), 1n), Completed{}, with_cleanup(f, 2n))
    case Cancelled{} CleanupFinished{}:
      choose(Nat.is_eq(cleanup(f), 1n), Cancelled{}, with_cleanup(f, 2n))
    case _ _: Keep{}

def apply(previous: State, decision: Decision, seq: Nat) -> State:
  match decision:
    case Keep{}: previous
    case Change{phase, facts}: State{phase, seq, facts}

# Match the reducer's terminal guard: only cleanup decisions retain a terminal phase.
def terminal_gate(phase: Phase, decision: Decision) -> Decision:
  match phase decision:
    case Completed{} Change{Completed{}, facts}: Change{Completed{}, facts}
    case Completed{} _: Keep{}
    case Cancelled{} Change{Cancelled{}, facts}: Change{Cancelled{}, facts}
    case Cancelled{} _: Keep{}
    case Failed{} _: Keep{}
    case UnknownPhase{} _: Keep{}
    case _ next: next

def sequenced(valid: Bool, previous: State, action: Action) -> State:
  match valid:
    case False{}: previous
    case True{}:
      match previous:
        case State{+phase, +old, +facts}:
          apply(State{phase, old, facts}, terminal_gate(phase, transition(phase, facts, action)), 1n+old)

def step(current: Maybe<&2, State>, event: Occurrence) -> Maybe<&2, State>:
  match current event:
    case None{} Occurrence{seq, action}:
      match seq action:
        case 1n+0n Requested{}: Some{State{Queued{}, 1n, initial()}}
        case _ _: None{}
    case Some{State{phase, +old, facts}} Occurrence{+seq, action}:
      Some{sequenced(Nat.is_eq(seq, 1n+old), State{phase, old, facts}, action)}

def state_seq(state: State) -> Nat:
  match state:
    case State{_, seq, _}: seq

def next_seq(state: State) -> Nat:
  1n+state_seq(state)

# A rejected step keeps its previous number; an accepted step increments it.
def SequenceOK(previous: Maybe<&2, State>, next: Maybe<&2, State>) -> Type:
  match previous next:
    case None{} None{}: Unit
    case None{} Some{State{_, seq, _}}: {seq == 1n : Nat}
    case Some{previous} Some{after}:
      {after == previous : State} | {state_seq(after) == next_seq(previous) : Nat}
    case Some{_} None{}: Empty

# Observe the result after each attempted append, including rejections.
def trace(events: List<&2, Occurrence>, current: Maybe<&2, State>) -> List<&2, Maybe<&2, State>>:
  match events:
    case Nil{}: Nil{}
    case Con{event, rest}:
      +next = step(current, event)
      next <> trace(rest, next)

def replay(events: List<&2, Occurrence>, current: Maybe<&2, State>) -> Maybe<&2, State>:
  match events:
    case Nil{}: current
    case Con{event, rest}: replay(rest, step(current, event))

def revoked_state(state: State) -> Maybe<&2, Nat>:
  match state:
    case State{_, _, facts}: revoked(facts)

def revoked_matches(current: Maybe<&2, State>, n: Nat) -> Bool:
  match current:
    case None{}: False{}
    case Some{State{_, _, facts}}: matches(revoked(facts), n)

# Terminal phases retain their identity even while cleanup changes facts.
def Terminal(phase: Phase) -> Type:
  match phase:
    case Completed{}: Unit
    case Failed{}: Unit
    case Cancelled{}: Unit
    case UnknownPhase{}: Unit
    case _: Empty

def phase_of(state: Maybe<&2, State>) -> Maybe<&2, Phase>:
  match state:
    case None{}: None{}
    case Some{State{phase, _, _}}: Some{phase}

def unphase(m: Maybe<&2, Phase>) -> Phase:
  match m:
    case None{}: Queued{}
    case Some{phase}: phase

def present(m: Maybe<&2, Phase>) -> Type:
  match m:
    case None{}: Empty
    case Some{_}: Unit
