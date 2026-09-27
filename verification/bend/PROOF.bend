import Base
import ./LAWS.bend as Laws
import ./model.bend as M

def Laws.completion_apply(previous, facts, seq, evidence):
  match facts:
    case M.Facts{o, l, a, s, epoch, authority, revoked, pending, confirmed, cleanup}:
      match a s:
        case True{} True{}: {==}
        case True{} False{}:
          %evidence : {M.completion_sound(Some{previous}) == _ : Bool}
          {==}
        case False{} True{}:
          %evidence : {M.completion_sound(Some{previous}) == _ : Bool}
          {==}
        case False{} False{}:
          %evidence : {M.completion_sound(Some{previous}) == _ : Bool}
          {==}

def Laws.completion_apply_decision(previous, decision, seq, evidence):
  match decision:
    case M.Keep{}:
      %evidence : {M.completion_sound(Some{previous}) == _ : Bool}
      {==}
    case M.Change{phase, facts}:
      match phase:
        case M.Completed{}:
          Laws.completion_apply(previous, facts, seq, evidence)
        case M.Queued{}: {==}
        case M.Starting{}: {==}
        case M.Running{}: {==}
        case M.Cancelling{}: {==}
        case M.Failed{}: {==}
        case M.Cancelled{}: {==}
        case M.UnknownPhase{}: {==}

def Laws.completion_sequenced(previous, valid, action, evidence):
  match previous:
    case M.State{+phase, +old, +facts}:
      match valid:
        case False{}:
          %evidence : {M.completion_sound(Some{M.State{phase, old, facts}}) == _ : Bool}
          {==}
        case True{}:
          Laws.completion_apply_decision(M.State{phase, old, facts}, M.terminal_gate(phase, M.transition(phase, facts, action)), 1n+old, evidence)

def Laws.completion_step(current, event, evidence):
  match current event:
    case None{} M.Occurrence{seq, action}:
      match seq action:
        case 0n _: {==}
        case 1n+0n M.Requested{}: {==}
        case 1n+0n M.PresentationOwned{}: {==}
        case 1n+0n M.StartingWork{}: {==}
        case 1n+0n M.WorkerLaunched{}: {==}
        case 1n+0n M.StartAcknowledged{}: {==}
        case 1n+0n M.ResultAccepted{}: {==}
        case 1n+0n M.StopConfirmed{}: {==}
        case 1n+0n M.Complete{}: {==}
        case 1n+0n M.MarkFailed{}: {==}
        case 1n+0n M.CancelRequested{_}: {==}
        case 1n+0n M.CancelDispatched{_}: {==}
        case 1n+0n M.CancelAcknowledged{_}: {==}
        case 1n+0n M.Cancel{_}: {==}
        case 1n+0n M.UnknownLiveness{}: {==}
        case 1n+0n M.UnknownCancel{_}: {==}
        case 1n+0n M.AuthorityAcquired{_}: {==}
        case 1n+0n M.AuthorityRevoked{_}: {==}
        case 1n+0n M.GenerationConfirmed{_}: {==}
        case 1n+0n M.CleanupStarted{}: {==}
        case 1n+0n M.CleanupFinished{}: {==}
        case 1n+1n+p _: {==}
    case Some{M.State{phase, +old, facts}} M.Occurrence{+seq, action}:
      Laws.completion_sequenced(M.State{phase, old, facts}, Nat.is_eq(seq, 1n+old), action, evidence)

def Laws.completion_replay_from(xs, current, evidence):
  match xs:
    case Nil{}:
      %evidence : {M.completion_sound(current) == _ : Bool}
      {==}
    case Con{+event, rest}:
      Laws.completion_replay_from(rest, M.step(current, event), Laws.completion_step(current, event, evidence))

def Laws.completion_sound_replay(xs):
  Laws.completion_replay_from(xs, None{}, {==})

def Laws.sequence_apply(previous, decision):
  match previous:
    case M.State{phase, old, facts}:
      match decision:
        case M.Keep{}: Inl{{==}}
        case M.Change{newPhase, newFacts}:
          match newPhase:
            case M.Completed{}:
              match newFacts:
                case M.Facts{o, l, a, s, epoch, auth, revoked, pending, confirmed, cleanup}:
                  match a s:
                    case True{} True{}: Inr{{==}}
                    case True{} False{}: Inl{{==}}
                    case False{} True{}: Inl{{==}}
                    case False{} False{}: Inl{{==}}
            case M.Queued{}: Inr{{==}}
            case M.Starting{}: Inr{{==}}
            case M.Running{}: Inr{{==}}
            case M.Cancelling{}: Inr{{==}}
            case M.Failed{}: Inr{{==}}
            case M.Cancelled{}: Inr{{==}}
            case M.UnknownPhase{}: Inr{{==}}

def Laws.sequence_sequenced(previous, valid, action):
  match previous:
    case M.State{+phase, +old, +facts}:
      match valid:
        case False{}: Inl{{==}}
        case True{}:
          Laws.sequence_apply(M.State{phase, old, facts}, M.terminal_gate(phase, M.transition(phase, facts, action)))

def Laws.sequence_step_all(current, event):
  match current event:
    case None{} M.Occurrence{seq, action}:
      match seq action:
        case 0n _: Unit{}
        case 1n+0n M.Requested{}: {==}
        case 1n+0n M.PresentationOwned{}: Unit{}
        case 1n+0n M.StartingWork{}: Unit{}
        case 1n+0n M.WorkerLaunched{}: Unit{}
        case 1n+0n M.StartAcknowledged{}: Unit{}
        case 1n+0n M.ResultAccepted{}: Unit{}
        case 1n+0n M.StopConfirmed{}: Unit{}
        case 1n+0n M.Complete{}: Unit{}
        case 1n+0n M.MarkFailed{}: Unit{}
        case 1n+0n M.CancelRequested{_}: Unit{}
        case 1n+0n M.CancelDispatched{_}: Unit{}
        case 1n+0n M.CancelAcknowledged{_}: Unit{}
        case 1n+0n M.Cancel{_}: Unit{}
        case 1n+0n M.UnknownLiveness{}: Unit{}
        case 1n+0n M.UnknownCancel{_}: Unit{}
        case 1n+0n M.AuthorityAcquired{_}: Unit{}
        case 1n+0n M.AuthorityRevoked{_}: Unit{}
        case 1n+0n M.GenerationConfirmed{_}: Unit{}
        case 1n+0n M.CleanupStarted{}: Unit{}
        case 1n+0n M.CleanupFinished{}: Unit{}
        case 1n+1n+p _: Unit{}
    case Some{M.State{phase, +old, facts}} M.Occurrence{seq, action}:
      Laws.sequence_sequenced(M.State{phase, old, facts}, Nat.is_eq(seq, 1n+old), action)

def Laws.sequence_step(prefix, event):
  Laws.sequence_step_all(M.replay(prefix, None{}), event)

def Laws.replay_split(xs, ys, current):
  match xs:
    case Nil{}: {==}
    case Con{event, rest}:
      %Laws.replay_split(rest, ys, M.step(current, event)) : {M.replay(List.append(&2, M.Occurrence, rest, ys), M.step(current, event)) == _ : Maybe<&2, M.State>}
      {==}


def Laws.revoked_cannot_confirm(facts, n, evidence):
  %Equal.sym(Bool, M.matches(M.revoked(facts), n), True{}, evidence) : {M.both(Bool.not(_), M.both(M.matches(M.pending(facts), n), Bool.not(M.matches(M.confirmed(facts), n)))) == False{} : Bool}
  {==}

def Laws.revoked_transition(phase, facts, n, evidence):
  match phase:
    case M.Starting{}:
      %Equal.sym(Bool, M.can_confirm(facts, n), False{}, Laws.revoked_cannot_confirm(facts, n, evidence)) : {M.choose(_, M.Starting{}, M.with_confirmation(facts, n)) == M.Keep{} : M.Decision}
      {==}
    case M.Running{}:
      %Equal.sym(Bool, M.can_confirm(facts, n), False{}, Laws.revoked_cannot_confirm(facts, n, evidence)) : {M.choose(_, M.Running{}, M.with_confirmation(facts, n)) == M.Keep{} : M.Decision}
      {==}
    case M.Queued{}: {==}
    case M.Cancelling{}: {==}
    case M.Completed{}: {==}
    case M.Failed{}: {==}
    case M.Cancelled{}: {==}
    case M.UnknownPhase{}: {==}

def Laws.terminal_gate_keep(phase):
  match phase:
    case M.Queued{}: {==}
    case M.Starting{}: {==}
    case M.Running{}: {==}
    case M.Cancelling{}: {==}
    case M.Completed{}: {==}
    case M.Failed{}: {==}
    case M.Cancelled{}: {==}
    case M.UnknownPhase{}: {==}

def Laws.revoked_sequenced(previous, valid, n, evidence):
  match previous:
    case M.State{+phase, +old, +facts}:
      match valid:
        case False{}: {==}
        case True{}:
          %Equal.sym(M.Decision, M.transition(phase, facts, M.GenerationConfirmed{n}), M.Keep{}, Laws.revoked_transition(phase, facts, n, evidence)) : {M.apply(M.State{phase, old, facts}, M.terminal_gate(phase, _), 1n+old) == M.State{phase, old, facts} : M.State}
          %Equal.sym(M.Decision, M.terminal_gate(phase, M.Keep{}), M.Keep{}, Laws.terminal_gate_keep(phase)) : {M.apply(M.State{phase, old, facts}, _, 1n+old) == M.State{phase, old, facts} : M.State}
          {==}

def false_disc(b: Bool) -> Type:
  match b:
    case False{}: Unit
    case True{}: Empty

def impossible_bool(evidence: {False{} == True{} : Bool}) -> Empty:
  %evidence : {false_disc(_) : Type}
  Unit{}

def Laws.revoked_confirmation_step(current, seq, n, evidence):
  match current:
    case None{}:
      Empty.absurd({M.step(None{}, M.Occurrence{seq, M.GenerationConfirmed{n}}) == None{} : Maybe<&2, M.State>}, impossible_bool(evidence))
    case Some{M.State{phase, +old, facts}}:
      Equal.cong(M.State, Maybe<&2, M.State>, x => Some{x}, M.sequenced(Nat.is_eq(seq, 1n+old), M.State{phase, old, facts}, M.GenerationConfirmed{n}), M.State{phase, old, facts}, Laws.revoked_sequenced(M.State{phase, old, facts}, Nat.is_eq(seq, 1n+old), n, evidence))

def Laws.revoked_confirmation_rejected(prefix, seq, n, evidence):
  Laws.revoked_confirmation_step(M.replay(prefix, None{}), seq, n, evidence)

def Laws.terminal_apply(phase, decision, previous, seq, identity, terminal):
  match phase:
    case M.Completed{}:
      match decision:
        case M.Change{M.Completed{}, facts}:
          match facts:
            case M.Facts{o, l, a, s, e, auth, r, p, c, clean}:
              match a s:
                case True{} True{}: {==}
                case True{} False{}:
                  %identity : {M.phase_of(Some{previous}) == _ : Maybe<&2, M.Phase>}
                  {==}
                case False{} True{}:
                  %identity : {M.phase_of(Some{previous}) == _ : Maybe<&2, M.Phase>}
                  {==}
                case False{} False{}:
                  %identity : {M.phase_of(Some{previous}) == _ : Maybe<&2, M.Phase>}
                  {==}
        case M.Keep{}:
          %identity : {M.phase_of(Some{previous}) == _ : Maybe<&2, M.Phase>}
          {==}
        case M.Change{M.Queued{}, _}:
          %identity : {M.phase_of(Some{previous}) == _ : Maybe<&2, M.Phase>}
          {==}
        case M.Change{M.Starting{}, _}:
          %identity : {M.phase_of(Some{previous}) == _ : Maybe<&2, M.Phase>}
          {==}
        case M.Change{M.Running{}, _}:
          %identity : {M.phase_of(Some{previous}) == _ : Maybe<&2, M.Phase>}
          {==}
        case M.Change{M.Cancelling{}, _}:
          %identity : {M.phase_of(Some{previous}) == _ : Maybe<&2, M.Phase>}
          {==}
        case M.Change{M.Failed{}, _}:
          %identity : {M.phase_of(Some{previous}) == _ : Maybe<&2, M.Phase>}
          {==}
        case M.Change{M.Cancelled{}, _}:
          %identity : {M.phase_of(Some{previous}) == _ : Maybe<&2, M.Phase>}
          {==}
        case M.Change{M.UnknownPhase{}, _}:
          %identity : {M.phase_of(Some{previous}) == _ : Maybe<&2, M.Phase>}
          {==}

    case M.Failed{}:
      %identity : {M.phase_of(Some{previous}) == _ : Maybe<&2, M.Phase>}
      {==}
    case M.Cancelled{}:
      match decision:
        case M.Change{M.Cancelled{}, facts}: {==}
        case M.Keep{}:
          %identity : {M.phase_of(Some{previous}) == _ : Maybe<&2, M.Phase>}
          {==}
        case M.Change{M.Queued{}, _}:
          %identity : {M.phase_of(Some{previous}) == _ : Maybe<&2, M.Phase>}
          {==}
        case M.Change{M.Starting{}, _}:
          %identity : {M.phase_of(Some{previous}) == _ : Maybe<&2, M.Phase>}
          {==}
        case M.Change{M.Running{}, _}:
          %identity : {M.phase_of(Some{previous}) == _ : Maybe<&2, M.Phase>}
          {==}
        case M.Change{M.Cancelling{}, _}:
          %identity : {M.phase_of(Some{previous}) == _ : Maybe<&2, M.Phase>}
          {==}
        case M.Change{M.Completed{}, _}:
          %identity : {M.phase_of(Some{previous}) == _ : Maybe<&2, M.Phase>}
          {==}
        case M.Change{M.Failed{}, _}:
          %identity : {M.phase_of(Some{previous}) == _ : Maybe<&2, M.Phase>}
          {==}
        case M.Change{M.UnknownPhase{}, _}:
          %identity : {M.phase_of(Some{previous}) == _ : Maybe<&2, M.Phase>}
          {==}

    case M.UnknownPhase{}:
      %identity : {M.phase_of(Some{previous}) == _ : Maybe<&2, M.Phase>}
      {==}
    case M.Queued{}: match terminal: 
    case M.Starting{}: match terminal:
    case M.Running{}: match terminal:
    case M.Cancelling{}: match terminal:

def Laws.terminal_sequenced(valid, previous, action, phase, identity, terminal):
  match valid:
    case False{}:
      %identity : {M.phase_of(Some{previous}) == _ : Maybe<&2, M.Phase>}
      {==}
    case True{}:
      match previous:
        case M.State{+statePhase, +old, +facts}:
          %Equal.sym(M.Phase, statePhase, phase, Equal.cong(Maybe<&2, M.Phase>, M.Phase, M.unphase, Some{statePhase}, Some{phase}, identity)) : {M.phase_of(Some{M.apply(M.State{_, old, facts}, M.terminal_gate(_, M.transition(_, facts, action)), 1n+old)}) == Some{phase} : Maybe<&2, M.Phase>}
          Laws.terminal_apply(phase, M.transition(phase, facts, action), M.State{phase, old, facts}, 1n+old, {==}, terminal)

def impossible_none(phase: M.Phase, identity: {None{} == Some{phase} : Maybe<&2, M.Phase>}) -> Empty:
  %Equal.sym(Maybe<&2, M.Phase>, None{}, Some{phase}, identity) : {M.present(_) : Type}
  Unit{}

def Laws.terminal_step(current, event, phase, identity, terminal):
  match current:
    case None{}:
      Empty.absurd({M.phase_of(M.step(None{}, event)) == Some{phase} : Maybe<&2, M.Phase>}, impossible_none(phase, identity))
    case Some{M.State{statePhase, +old, facts}}:
      match event:
        case M.Occurrence{seq, action}:
          Laws.terminal_sequenced(Nat.is_eq(seq, 1n+old), M.State{statePhase, old, facts}, action, phase, identity, terminal)

def Laws.terminal_replay_from(phase, xs, current, identity, terminal):
  match phase:
    case M.Completed{}:
      match xs:
        case Nil{}: identity
        case Con{+event, rest}:
          Laws.terminal_replay_from(M.Completed{}, rest, M.step(current, event), Laws.terminal_step(current, event, M.Completed{}, identity, Unit{}), Unit{})
    case M.Failed{}:
      match xs:
        case Nil{}: identity
        case Con{+event, rest}:
          Laws.terminal_replay_from(M.Failed{}, rest, M.step(current, event), Laws.terminal_step(current, event, M.Failed{}, identity, Unit{}), Unit{})
    case M.Cancelled{}:
      match xs:
        case Nil{}: identity
        case Con{+event, rest}:
          Laws.terminal_replay_from(M.Cancelled{}, rest, M.step(current, event), Laws.terminal_step(current, event, M.Cancelled{}, identity, Unit{}), Unit{})
    case M.UnknownPhase{}:
      match xs:
        case Nil{}: identity
        case Con{+event, rest}:
          Laws.terminal_replay_from(M.UnknownPhase{}, rest, M.step(current, event), Laws.terminal_step(current, event, M.UnknownPhase{}, identity, Unit{}), Unit{})
    case M.Queued{}: match terminal:
    case M.Starting{}: match terminal:
    case M.Running{}: match terminal:
    case M.Cancelling{}: match terminal:

def Laws.terminal_prefix_suffix(prefix, suffix, phase, identity, terminal):
  Laws.terminal_replay_from(phase, suffix, M.replay(prefix, None{}), identity, terminal)
