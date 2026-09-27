import Base
import ./LAWS.bend as Laws
import ./model.bend as M

def safe_choice(previous: M.State, valid: Bool, phase: M.Phase, facts: M.Facts, seq: Nat, evidence: {M.completion_sound(Some{previous}) == True{} : Bool}, target: {M.completion_sound(Some{M.State{phase, seq, facts}}) == True{} : Bool}) -> {M.completion_sound(Some{M.apply(previous, M.choose(valid, phase, facts), seq)}) == True{} : Bool}:
  match valid:
    case True{}: target
    case False{}:
      %evidence : {M.completion_sound(Some{previous}) == _ : Bool}
      {==}

def cancelled_choice(old: Nat, original: M.Facts, valid: Bool, facts: M.Facts, seq: Nat) -> {M.completion_sound(Some{M.apply(M.State{M.Cancelled{}, old, original}, M.terminal_gate(M.Cancelled{}, M.choose(valid, M.Cancelled{}, facts)), seq)}) == True{} : Bool}:
  match valid:
    case True{}: {==}
    case False{}: {==}

def completed_cleanup(old: Nat, o: Bool, l: Bool, a: Bool, s: Bool, e: Nat, auth: Maybe<&2, Nat>, r: Maybe<&2, Nat>, p: Maybe<&2, Nat>, c: Maybe<&2, Nat>, clean: Nat, valid: Bool, next: Nat, evidence: {M.completion_sound(Some{M.State{M.Completed{}, old, M.Facts{o, l, a, s, e, auth, r, p, c, clean}}}) == True{} : Bool}) -> {M.completion_sound(Some{M.apply(M.State{M.Completed{}, old, M.Facts{o, l, a, s, e, auth, r, p, c, clean}}, M.terminal_gate(M.Completed{}, M.choose(valid, M.Completed{}, M.with_cleanup(M.Facts{o, l, a, s, e, auth, r, p, c, clean}, next))), 1n+old)}) == True{} : Bool}:
  match valid:
    case True{}:
      %evidence : {M.completion_sound(Some{M.State{M.Completed{}, 1n+old, M.Facts{o, l, a, s, e, auth, r, p, c, next}}}) == _ : Bool}
      {==}
    case False{}:
      %evidence : {M.completion_sound(Some{M.State{M.Completed{}, old, M.Facts{o, l, a, s, e, auth, r, p, c, clean}}}) == _ : Bool}
      {==}

def running_complete_sound(old: Nat, facts: M.Facts) -> {M.completion_sound(Some{M.sequenced(True{}, M.State{M.Running{}, old, facts}, M.Complete{})}) == True{} : Bool}:
  match facts:
    case M.Facts{_, _, True{}, True{}, _, _, _, _, _, _}: {==}
    case M.Facts{_, _, True{}, False{}, _, _, _, _, _, _}: {==}
    case M.Facts{_, _, False{}, True{}, _, _, _, _, _, _}: {==}
    case M.Facts{_, _, False{}, False{}, _, _, _, _, _, _}: {==}

def accepted_step_sound(previous: M.State, action: M.Action, evidence: {M.completion_sound(Some{previous}) == True{} : Bool}) -> {M.completion_sound(Some{M.sequenced(True{}, previous, action)}) == True{} : Bool}:
  match previous:
    case M.State{M.Running{}, +old, +facts}:
      match action:
        case M.Complete{}: running_complete_sound(old, facts)
        case M.ResultAccepted{}:
          safe_choice(M.State{M.Running{}, old, facts}, Bool.not(M.accepted(facts)), M.Running{}, M.with_accepted(facts), 1n+old, evidence, {==})
        case M.StopConfirmed{}:
          safe_choice(M.State{M.Running{}, old, facts}, M.both(M.launched(facts), Bool.not(M.stopped(facts))), M.Running{}, M.with_stopped(facts), 1n+old, evidence, {==})
        case M.CancelRequested{+n}:
          safe_choice(M.State{M.Running{}, old, facts}, Nat.is_gt(n, M.epoch(facts)), M.Cancelling{}, M.with_epoch(facts, n), 1n+old, evidence, {==})
        case M.AuthorityAcquired{+n}:
          safe_choice(M.State{M.Running{}, old, facts}, M.both(M.launched(facts), M.can_acquire(M.authority(facts), M.confirmed(facts), n)), M.Running{}, M.with_authority(facts, n), 1n+old, evidence, {==})
        case M.AuthorityRevoked{+n}:
          safe_choice(M.State{M.Running{}, old, facts}, M.can_revoke(M.authority(facts), M.pending(facts), n), M.Running{}, M.revoke(facts, n), 1n+old, evidence, {==})
        case M.GenerationConfirmed{+n}:
          safe_choice(M.State{M.Running{}, old, facts}, M.can_confirm(facts, n), M.Running{}, M.with_confirmation(facts, n), 1n+old, evidence, {==})
        case M.Requested{}: {==}
        case M.PresentationOwned{}: {==}
        case M.StartingWork{}: {==}
        case M.WorkerLaunched{}: {==}
        case M.StartAcknowledged{}: {==}
        case M.MarkFailed{}: {==}
        case M.CancelDispatched{_}: {==}
        case M.CancelAcknowledged{_}: {==}
        case M.Cancel{_}: {==}
        case M.UnknownLiveness{}: {==}
        case M.UnknownCancel{_}: {==}
        case M.CleanupStarted{}: {==}
        case M.CleanupFinished{}: {==}
    case M.State{M.Completed{}, old, M.Facts{o, l, a, s, e, auth, r, p, c, clean}}:
      match action:
        case M.CleanupStarted{}:
          completed_cleanup(old, o, l, a, s, e, auth, r, p, c, clean, M.both(M.can_cleanup(M.Completed{}, M.Facts{o, l, a, s, e, auth, r, p, c, clean}), Nat.is_eq(clean, 0n)), 1n, evidence)
        case M.CleanupFinished{}:
          completed_cleanup(old, o, l, a, s, e, auth, r, p, c, clean, Nat.is_eq(clean, 1n), 2n, evidence)
        case M.Requested{}:
          %evidence : {M.completion_sound(Some{M.State{M.Completed{}, old, M.Facts{o, l, a, s, e, auth, r, p, c, clean}}}) == _ : Bool}
          {==}
        case M.PresentationOwned{}:
          %evidence : {M.completion_sound(Some{M.State{M.Completed{}, old, M.Facts{o, l, a, s, e, auth, r, p, c, clean}}}) == _ : Bool}
          {==}
        case M.StartingWork{}:
          %evidence : {M.completion_sound(Some{M.State{M.Completed{}, old, M.Facts{o, l, a, s, e, auth, r, p, c, clean}}}) == _ : Bool}
          {==}
        case M.WorkerLaunched{}:
          %evidence : {M.completion_sound(Some{M.State{M.Completed{}, old, M.Facts{o, l, a, s, e, auth, r, p, c, clean}}}) == _ : Bool}
          {==}
        case M.StartAcknowledged{}:
          %evidence : {M.completion_sound(Some{M.State{M.Completed{}, old, M.Facts{o, l, a, s, e, auth, r, p, c, clean}}}) == _ : Bool}
          {==}
        case M.ResultAccepted{}:
          %evidence : {M.completion_sound(Some{M.State{M.Completed{}, old, M.Facts{o, l, a, s, e, auth, r, p, c, clean}}}) == _ : Bool}
          {==}
        case M.StopConfirmed{}:
          %evidence : {M.completion_sound(Some{M.State{M.Completed{}, old, M.Facts{o, l, a, s, e, auth, r, p, c, clean}}}) == _ : Bool}
          {==}
        case M.Complete{}:
          %evidence : {M.completion_sound(Some{M.State{M.Completed{}, old, M.Facts{o, l, a, s, e, auth, r, p, c, clean}}}) == _ : Bool}
          {==}
        case M.MarkFailed{}:
          %evidence : {M.completion_sound(Some{M.State{M.Completed{}, old, M.Facts{o, l, a, s, e, auth, r, p, c, clean}}}) == _ : Bool}
          {==}
        case M.CancelRequested{_}:
          %evidence : {M.completion_sound(Some{M.State{M.Completed{}, old, M.Facts{o, l, a, s, e, auth, r, p, c, clean}}}) == _ : Bool}
          {==}
        case M.CancelDispatched{_}:
          %evidence : {M.completion_sound(Some{M.State{M.Completed{}, old, M.Facts{o, l, a, s, e, auth, r, p, c, clean}}}) == _ : Bool}
          {==}
        case M.CancelAcknowledged{_}:
          %evidence : {M.completion_sound(Some{M.State{M.Completed{}, old, M.Facts{o, l, a, s, e, auth, r, p, c, clean}}}) == _ : Bool}
          {==}
        case M.Cancel{_}:
          %evidence : {M.completion_sound(Some{M.State{M.Completed{}, old, M.Facts{o, l, a, s, e, auth, r, p, c, clean}}}) == _ : Bool}
          {==}
        case M.UnknownLiveness{}:
          %evidence : {M.completion_sound(Some{M.State{M.Completed{}, old, M.Facts{o, l, a, s, e, auth, r, p, c, clean}}}) == _ : Bool}
          {==}
        case M.UnknownCancel{_}:
          %evidence : {M.completion_sound(Some{M.State{M.Completed{}, old, M.Facts{o, l, a, s, e, auth, r, p, c, clean}}}) == _ : Bool}
          {==}
        case M.AuthorityAcquired{_}:
          %evidence : {M.completion_sound(Some{M.State{M.Completed{}, old, M.Facts{o, l, a, s, e, auth, r, p, c, clean}}}) == _ : Bool}
          {==}
        case M.AuthorityRevoked{_}:
          %evidence : {M.completion_sound(Some{M.State{M.Completed{}, old, M.Facts{o, l, a, s, e, auth, r, p, c, clean}}}) == _ : Bool}
          {==}
        case M.GenerationConfirmed{_}:
          %evidence : {M.completion_sound(Some{M.State{M.Completed{}, old, M.Facts{o, l, a, s, e, auth, r, p, c, clean}}}) == _ : Bool}
          {==}
    case M.State{M.Queued{}, old, +facts}:
      match action:
        case M.PresentationOwned{}:
          safe_choice(M.State{M.Queued{}, old, facts}, Bool.not(M.owned(facts)), M.Queued{}, M.with_owned(facts), 1n+old, evidence, {==})
        case M.StartingWork{}:
          safe_choice(M.State{M.Queued{}, old, facts}, M.owned(facts), M.Starting{}, facts, 1n+old, evidence, {==})
        case M.CancelRequested{+n}:
          safe_choice(M.State{M.Queued{}, old, facts}, Nat.is_gt(n, M.epoch(facts)), M.Cancelling{}, M.with_epoch(facts, n), 1n+old, evidence, {==})
        case M.UnknownLiveness{}: {==}
        case M.Requested{}: {==}
        case M.WorkerLaunched{}: {==}
        case M.StartAcknowledged{}: {==}
        case M.ResultAccepted{}: {==}
        case M.StopConfirmed{}: {==}
        case M.Complete{}: {==}
        case M.MarkFailed{}: {==}
        case M.CancelDispatched{_}: {==}
        case M.CancelAcknowledged{_}: {==}
        case M.Cancel{_}: {==}
        case M.UnknownCancel{_}: {==}
        case M.AuthorityAcquired{_}: {==}
        case M.AuthorityRevoked{_}: {==}
        case M.GenerationConfirmed{_}: {==}
        case M.CleanupStarted{}: {==}
        case M.CleanupFinished{}: {==}
    case M.State{M.Starting{}, old, +facts}:
      match action:
        case M.WorkerLaunched{}:
          safe_choice(M.State{M.Starting{}, old, facts}, Bool.not(M.launched(facts)), M.Starting{}, M.with_launched(facts), 1n+old, evidence, {==})
        case M.StartAcknowledged{}:
          safe_choice(M.State{M.Starting{}, old, facts}, M.launched(facts), M.Running{}, facts, 1n+old, evidence, {==})
        case M.StopConfirmed{}:
          safe_choice(M.State{M.Starting{}, old, facts}, M.both(M.launched(facts), Bool.not(M.stopped(facts))), M.Starting{}, M.with_stopped(facts), 1n+old, evidence, {==})
        case M.MarkFailed{}: {==}
        case M.CancelRequested{+n}:
          safe_choice(M.State{M.Starting{}, old, facts}, Nat.is_gt(n, M.epoch(facts)), M.Cancelling{}, M.with_epoch(facts, n), 1n+old, evidence, {==})
        case M.UnknownLiveness{}: {==}
        case M.AuthorityAcquired{+n}:
          safe_choice(M.State{M.Starting{}, old, facts}, M.both(M.launched(facts), M.can_acquire(M.authority(facts), M.confirmed(facts), n)), M.Starting{}, M.with_authority(facts, n), 1n+old, evidence, {==})
        case M.AuthorityRevoked{+n}:
          safe_choice(M.State{M.Starting{}, old, facts}, M.can_revoke(M.authority(facts), M.pending(facts), n), M.Starting{}, M.revoke(facts, n), 1n+old, evidence, {==})
        case M.GenerationConfirmed{+n}:
          safe_choice(M.State{M.Starting{}, old, facts}, M.can_confirm(facts, n), M.Starting{}, M.with_confirmation(facts, n), 1n+old, evidence, {==})
        case M.Requested{}: {==}
        case M.PresentationOwned{}: {==}
        case M.StartingWork{}: {==}
        case M.ResultAccepted{}: {==}
        case M.Complete{}: {==}
        case M.CancelDispatched{_}: {==}
        case M.CancelAcknowledged{_}: {==}
        case M.Cancel{_}: {==}
        case M.UnknownCancel{_}: {==}
        case M.CleanupStarted{}: {==}
        case M.CleanupFinished{}: {==}
    case M.State{M.Cancelling{}, old, +facts}:
      match action:
        case M.CancelDispatched{+n}:
          safe_choice(M.State{M.Cancelling{}, old, facts}, Nat.is_eq(n, M.epoch(facts)), M.Cancelling{}, facts, 1n+old, evidence, {==})
        case M.CancelAcknowledged{+n}:
          safe_choice(M.State{M.Cancelling{}, old, facts}, Nat.is_eq(n, M.epoch(facts)), M.Cancelling{}, M.with_stopped(facts), 1n+old, evidence, {==})
        case M.Cancel{+n}:
          safe_choice(M.State{M.Cancelling{}, old, facts}, M.both(Nat.is_eq(n, M.epoch(facts)), M.stopped(facts)), M.Cancelled{}, facts, 1n+old, evidence, {==})
        case M.UnknownCancel{+n}:
          safe_choice(M.State{M.Cancelling{}, old, facts}, Nat.is_eq(n, M.epoch(facts)), M.UnknownPhase{}, facts, 1n+old, evidence, {==})
        case M.Requested{}: {==}
        case M.PresentationOwned{}: {==}
        case M.StartingWork{}: {==}
        case M.WorkerLaunched{}: {==}
        case M.StartAcknowledged{}: {==}
        case M.ResultAccepted{}: {==}
        case M.StopConfirmed{}: {==}
        case M.Complete{}: {==}
        case M.MarkFailed{}: {==}
        case M.CancelRequested{_}: {==}
        case M.UnknownLiveness{}: {==}
        case M.AuthorityAcquired{_}: {==}
        case M.AuthorityRevoked{_}: {==}
        case M.GenerationConfirmed{_}: {==}
        case M.CleanupStarted{}: {==}
        case M.CleanupFinished{}: {==}
    case M.State{M.Failed{}, _, _}: {==}
    case M.State{M.Cancelled{}, old, +facts}:
      match action:
        case M.CleanupStarted{}:
          cancelled_choice(old, facts, M.both(M.can_cleanup(M.Cancelled{}, facts), Nat.is_eq(M.cleanup(facts), 0n)), M.with_cleanup(facts, 1n), 1n+old)
        case M.CleanupFinished{}:
          cancelled_choice(old, facts, Nat.is_eq(M.cleanup(facts), 1n), M.with_cleanup(facts, 2n), 1n+old)
        case M.Requested{}: {==}
        case M.PresentationOwned{}: {==}
        case M.StartingWork{}: {==}
        case M.WorkerLaunched{}: {==}
        case M.StartAcknowledged{}: {==}
        case M.ResultAccepted{}: {==}
        case M.StopConfirmed{}: {==}
        case M.Complete{}: {==}
        case M.MarkFailed{}: {==}
        case M.CancelRequested{_}: {==}
        case M.CancelDispatched{_}: {==}
        case M.CancelAcknowledged{_}: {==}
        case M.Cancel{_}: {==}
        case M.UnknownLiveness{}: {==}
        case M.UnknownCancel{_}: {==}
        case M.AuthorityAcquired{_}: {==}
        case M.AuthorityRevoked{_}: {==}
        case M.GenerationConfirmed{_}: {==}
    case M.State{M.UnknownPhase{}, _, _}: {==}

def Laws.completion_sequenced(previous, valid, action, evidence):
  match previous:
    case M.State{+phase, +old, +facts}:
      match valid:
        case False{}:
          %evidence : {M.completion_sound(Some{M.State{phase, old, facts}}) == _ : Bool}
          {==}
        case True{}:
          accepted_step_sound(M.State{phase, old, facts}, action, evidence)

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
  match decision:
    case M.Keep{}: Inl{{==}}
    case M.Change{_, _}: Inr{{==}}

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
        case M.Change{M.Completed{}, facts}: {==}
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
