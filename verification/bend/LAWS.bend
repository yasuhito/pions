import Base
import ./model.bend as M

law completion_sequenced:
  for +previous: M.State
  for valid: Bool
  for action: M.Action
  for evidence: {M.completion_sound(Some{previous}) == True{} : Bool}
  {M.completion_sound(Some{M.sequenced(valid, previous, action)}) == True{} : Bool}

law completion_step:
  for +current: Maybe<&2, M.State>
  for event: M.Occurrence
  for evidence: {M.completion_sound(current) == True{} : Bool}
  {M.completion_sound(M.step(current, event)) == True{} : Bool}

law completion_replay_from:
  for xs: List<&2, M.Occurrence>
  for +current: Maybe<&2, M.State>
  for evidence: {M.completion_sound(current) == True{} : Bool}
  {M.completion_sound(M.replay(xs, current)) == True{} : Bool}

# 任意の履歴が完了で終わるなら、結果受理と停止確認の証跡がある。
law completion_sound_replay:
  for xs: List<&2, M.Occurrence>
  {M.completion_sound(M.replay(xs, None{})) == True{} : Bool}

law sequence_apply:
  for previous: M.State
  for decision: M.Decision
  M.SequenceOK(Some{previous}, Some{M.apply(previous, decision, M.next_seq(previous))})

law sequence_sequenced:
  for previous: M.State
  for valid: Bool
  for action: M.Action
  M.SequenceOK(Some{previous}, Some{M.sequenced(valid, previous, action)})

law sequence_step_all:
  for current: Maybe<&2, M.State>
  for event: M.Occurrence
  M.SequenceOK(current, M.step(current, event))

# 任意の履歴の次のイベントは、拒否なら状態を保ち、受理なら連番を 1 増やす。
law sequence_step:
  for +prefix: List<&2, M.Occurrence>
  for event: M.Occurrence
  M.SequenceOK(M.replay(prefix, None{}), M.step(M.replay(prefix, None{}), event))

# どの位置で履歴を分割しても同じ状態になる。
law replay_split:
  for +xs: List<&2, M.Occurrence>
  for +ys: List<&2, M.Occurrence>
  for +current: Maybe<&2, M.State>
  {M.replay(List.append(&2, M.Occurrence, xs, ys), current) == M.replay(ys, M.replay(xs, current)) : Maybe<&2, M.State>}

law revoked_cannot_confirm:
  for +facts: M.Facts
  for +n: Nat
  for evidence: {M.matches(M.revoked(facts), n) == True{} : Bool}
  {M.can_confirm(facts, n) == False{} : Bool}

law revoked_transition:
  for phase: M.Phase
  for +facts: M.Facts
  for +n: Nat
  for evidence: {M.matches(M.revoked(facts), n) == True{} : Bool}
  {M.transition(phase, facts, M.GenerationConfirmed{n}) == M.Keep{} : M.Decision}

law terminal_gate_keep:
  for phase: M.Phase
  {M.terminal_gate(phase, M.Keep{}) == M.Keep{} : M.Decision}

law revoked_sequenced:
  for previous: M.State
  for valid: Bool
  for n: Nat
  for evidence: {M.matches(M.revoked_state(previous), n) == True{} : Bool}
  {M.sequenced(valid, previous, M.GenerationConfirmed{n}) == previous : M.State}

law revoked_confirmation_step:
  for +current: Maybe<&2, M.State>
  for seq: Nat
  for n: Nat
  for evidence: {M.revoked_matches(current, n) == True{} : Bool}
  {M.step(current, M.Occurrence{seq, M.GenerationConfirmed{n}}) == current : Maybe<&2, M.State>}

# 失効後に旧世代の確認を受け付けない。失効前に確認済みだった世代は対象外。
law revoked_confirmation_rejected:
  for prefix: List<&2, M.Occurrence>
  for seq: Nat
  for n: Nat
  for evidence: {M.revoked_matches(M.replay(prefix, None{}), n) == True{} : Bool}
  {M.step(M.replay(prefix, None{}), M.Occurrence{seq, M.GenerationConfirmed{n}}) == M.replay(prefix, None{}) : Maybe<&2, M.State>}

law terminal_apply:
  for phase: M.Phase
  for decision: M.Decision
  for previous: M.State
  for seq: Nat
  for identity: {M.phase_of(Some{previous}) == Some{phase} : Maybe<&2, M.Phase>}
  for terminal: M.Terminal(phase)
  {M.phase_of(Some{M.apply(previous, M.terminal_gate(phase, decision), seq)}) == Some{phase} : Maybe<&2, M.Phase>}

law terminal_sequenced:
  for valid: Bool
  for previous: M.State
  for action: M.Action
  for +phase: M.Phase
  for identity: {M.phase_of(Some{previous}) == Some{phase} : Maybe<&2, M.Phase>}
  for terminal: M.Terminal(phase)
  {M.phase_of(Some{M.sequenced(valid, previous, action)}) == Some{phase} : Maybe<&2, M.Phase>}

law terminal_step:
  for current: Maybe<&2, M.State>
  for event: M.Occurrence
  for phase: M.Phase
  for identity: {M.phase_of(current) == Some{phase} : Maybe<&2, M.Phase>}
  for terminal: M.Terminal(phase)
  {M.phase_of(M.step(current, event)) == Some{phase} : Maybe<&2, M.Phase>}

law terminal_replay_from:
  for phase: M.Phase
  for xs: List<&2, M.Occurrence>
  for +current: Maybe<&2, M.State>
  for identity: {M.phase_of(current) == Some{phase} : Maybe<&2, M.Phase>}
  for terminal: M.Terminal(phase)
  {M.phase_of(M.replay(xs, current)) == Some{phase} : Maybe<&2, M.Phase>}

# 任意の履歴で終端に達したら、任意の続きでもその終端種別を保つ。
law terminal_prefix_suffix:
  for prefix: List<&2, M.Occurrence>
  for suffix: List<&2, M.Occurrence>
  for phase: M.Phase
  for identity: {M.phase_of(M.replay(prefix, None{})) == Some{phase} : Maybe<&2, M.Phase>}
  for terminal: M.Terminal(phase)
  {M.phase_of(M.replay(suffix, M.replay(prefix, None{}))) == Some{phase} : Maybe<&2, M.Phase>}
