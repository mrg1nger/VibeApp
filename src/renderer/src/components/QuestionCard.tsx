import { useState } from 'react'
import type { QuestionAnswers, UserQuestion } from '@shared/types'

interface QuestionCardProps {
  questions: UserQuestion[]
  onAnswer: (answers: QuestionAnswers) => void
  onSkip: () => void
}

/** Claude's multiple-choice questions, with an "Other" box for anything the options miss. */
function QuestionCard({ questions, onAnswer, onSkip }: QuestionCardProps) {
  const [picked, setPicked] = useState<Record<number, string[]>>({})
  const [other, setOther] = useState<Record<number, string>>({})

  const toggle = (qi: number, label: string, multi: boolean): void => {
    setPicked((prev) => {
      const current = prev[qi] ?? []
      const next = multi
        ? current.includes(label)
          ? current.filter((l) => l !== label)
          : [...current, label]
        : [label]
      return { ...prev, [qi]: next }
    })
    if (!multi) setOther((prev) => ({ ...prev, [qi]: '' }))
  }

  const answerFor = (qi: number): string => {
    const typed = other[qi]?.trim()
    const chosen = picked[qi] ?? []
    return [...chosen, ...(typed ? [typed] : [])].join(', ')
  }

  const complete = questions.every((_, qi) => answerFor(qi))

  return (
    <div className="question-card">
      <div className="question-card-title">❓ Claude has {questions.length === 1 ? 'a question' : 'some questions'}</div>
      {questions.map((q, qi) => (
        <div key={qi} className="question">
          {q.header && <span className="question-header">{q.header}</span>}
          <p className="question-text">{q.question}</p>
          {q.multiSelect && <p className="question-hint">Pick any that apply.</p>}
          <div className="question-options">
            {q.options.map((option) => {
              const selected = (picked[qi] ?? []).includes(option.label)
              return (
                <button
                  key={option.label}
                  className={`question-option${selected ? ' selected' : ''}`}
                  onClick={() => toggle(qi, option.label, q.multiSelect)}
                >
                  <strong>{option.label}</strong>
                  {option.description && <span>{option.description}</span>}
                </button>
              )
            })}
          </div>
          <input
            className="question-other"
            value={other[qi] ?? ''}
            onChange={(e) => {
              const value = e.target.value
              setOther((prev) => ({ ...prev, [qi]: value }))
              // Typing your own answer replaces a single-choice pick.
              if (!q.multiSelect && value) setPicked((prev) => ({ ...prev, [qi]: [] }))
            }}
            placeholder="Other: type your own answer"
          />
        </div>
      ))}
      <div className="question-actions">
        <button onClick={onSkip}>Skip</button>
        <button
          className="question-submit"
          disabled={!complete}
          onClick={() =>
            onAnswer(Object.fromEntries(questions.map((q, qi) => [q.question, answerFor(qi)])))
          }
        >
          Send answer{questions.length === 1 ? '' : 's'}
        </button>
      </div>
    </div>
  )
}

export default QuestionCard
