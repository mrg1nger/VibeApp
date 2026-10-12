import { BALANCE_HELP, BALANCE_LABELS, BALANCE_STEPS, type AgentBalance } from '@shared/balance'

interface BalanceSliderProps {
  balance: AgentBalance
  /** Where Auto currently points, -2 (Claude) to +2 (Codex). */
  autoLean: number
  onChange: (balance: AgentBalance) => void
}

/**
 * How work leans between Claude and Codex. Sits between their usage meters.
 * On Auto the thumb follows whichever plan has more left; dragging it
 * switches to that position.
 */
function BalanceSlider({ balance, autoLean, onChange }: BalanceSliderProps) {
  const auto = balance === 'auto'
  const index = Math.max(0, Math.min(4, auto ? autoLean + 2 : BALANCE_STEPS.indexOf(balance)))
  const step = BALANCE_STEPS[index]
  const title = [
    `${auto ? 'Auto: ' : ''}${BALANCE_LABELS[step]}`,
    BALANCE_HELP[step],
    '',
    auto
      ? 'Auto follows whichever plan has more left. Drag the slider to choose for yourself.'
      : 'Click Auto to follow whichever plan has more left.'
  ].join('\n')

  return (
    <div className={`balance${auto ? ' balance-auto' : ''}`} title={title}>
      <input
        type="range"
        min={0}
        max={4}
        step={1}
        value={index}
        aria-label="Lean toward Claude or Codex"
        onChange={(e) => onChange(BALANCE_STEPS[Number(e.target.value)])}
      />
      <button className={auto ? 'on' : ''} onClick={() => onChange(auto ? step : 'auto')}>
        {auto ? 'Auto' : BALANCE_LABELS[step]}
      </button>
    </div>
  )
}

export default BalanceSlider
