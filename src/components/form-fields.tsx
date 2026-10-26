/**
 * The questions, rendered once for both the person answering and the operator
 * previewing. Two renderers would drift, and the preview's whole job is to show
 * what the person will actually see.
 *
 * Controlled: the parent owns the answers so the answer page can submit them and
 * the preview can pass an empty object and ignore changes.
 */

import { FORM_LIMITS, FORM_SCALE_VALUES } from '#/lib/forms/validation.ts'
import type { FormQuestionView } from '#/lib/forms/validation.ts'

export type FormAnswerState = {
  text?: string
  number?: number | null
  choices?: string[]
}

export type FormAnswers = Record<string, FormAnswerState>

export function FormFields({
  questions,
  answers,
  onChange,
  disabled = false,
  idPrefix = 'form',
}: {
  questions: FormQuestionView[]
  answers: FormAnswers
  onChange?: (questionId: string, next: FormAnswerState) => void
  disabled?: boolean
  idPrefix?: string
}) {
  const update = (questionId: string, next: FormAnswerState) => {
    onChange?.(questionId, next)
  }

  const inputClass =
    'mt-2 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground disabled:opacity-60'

  return (
    <ol className="mt-6 space-y-6">
      {questions.map((question, index) => {
        const answer = answers[question.id] ?? {}
        const group = `${idPrefix}-${question.id}`

        return (
          <li key={question.id}>
            <fieldset disabled={disabled}>
              <legend className="text-sm font-medium">
                <span className="mr-2 text-xs text-muted-foreground">
                  {index + 1}.
                </span>
                {question.prompt}
                {question.required ? (
                  <span className="ml-1 text-destructive" aria-hidden="true">
                    *
                  </span>
                ) : null}
              </legend>

              {question.help ? (
                <p className="mt-1 text-xs text-muted-foreground">{question.help}</p>
              ) : null}

              {question.type === 'short-text' ? (
                <input
                  type="text"
                  value={answer.text ?? ''}
                  onChange={(event) =>
                    update(question.id, {
                      ...answer,
                      text: event.target.value,
                    })
                  }
                  maxLength={FORM_LIMITS.shortText}
                  required={question.required}
                  className={inputClass}
                />
              ) : null}

              {question.type === 'long-text' ? (
                <textarea
                  value={answer.text ?? ''}
                  onChange={(event) =>
                    update(question.id, {
                      ...answer,
                      text: event.target.value,
                    })
                  }
                  maxLength={FORM_LIMITS.longText}
                  required={question.required}
                  rows={4}
                  className={inputClass}
                />
              ) : null}

              {question.type === 'choice' ? (
                <div className="mt-2 space-y-1.5">
                  {question.options.map((option, optionIndex) => (
                    <label
                      key={option}
                      className="flex items-center gap-2 text-sm"
                    >
                      <input
                        type="radio"
                        name={group}
                        checked={answer.text === option}
                        onChange={() => update(question.id, { text: option })}
                        required={question.required && optionIndex === 0}
                      />
                      {option}
                    </label>
                  ))}
                </div>
              ) : null}

              {question.type === 'multi-choice' ? (
                <div className="mt-2 space-y-1.5">
                  {question.options.map((option) => {
                    const selected = answer.choices ?? []
                    return (
                      <label
                        key={option}
                        className="flex items-center gap-2 text-sm"
                      >
                        <input
                          type="checkbox"
                          checked={selected.includes(option)}
                          onChange={(event) => {
                            const next = event.target.checked
                              ? [...selected, option]
                              : selected.filter((choice) => choice !== option)
                            update(question.id, { choices: next })
                          }}
                        />
                        {option}
                      </label>
                    )
                  })}
                </div>
              ) : null}

              {question.type === 'scale' ? (
                <div className="mt-2">
                  <div className="flex flex-wrap items-center gap-2">
                    {FORM_SCALE_VALUES.map((value, valueIndex) => (
                      <label
                        key={value}
                        className="flex size-9 items-center justify-center rounded-md border border-border text-sm has-checked:border-primary has-checked:bg-primary has-checked:text-primary-foreground"
                      >
                        <input
                          type="radio"
                          name={group}
                          className="sr-only"
                          checked={answer.number === value}
                          onChange={() =>
                            update(question.id, { number: value })
                          }
                          required={question.required && valueIndex === 0}
                        />
                        {value}
                      </label>
                    ))}
                  </div>
                  {question.scaleLowLabel || question.scaleHighLabel ? (
                    <div className="mt-1 flex justify-between text-[11px] text-muted-foreground">
                      <span>{question.scaleLowLabel ?? ''}</span>
                      <span>{question.scaleHighLabel ?? ''}</span>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {question.type === 'yes-no' ? (
                <div className="mt-2 flex gap-2">
                  {(['yes', 'no'] as const).map((value, valueIndex) => (
                    <label
                      key={value}
                      className="rounded-md border border-border px-3 py-1.5 text-sm capitalize has-checked:border-primary has-checked:bg-primary has-checked:text-primary-foreground"
                    >
                      <input
                        type="radio"
                        name={group}
                        className="sr-only"
                        checked={answer.text === value}
                        onChange={() => update(question.id, { text: value })}
                        required={question.required && valueIndex === 0}
                      />
                      {value}
                    </label>
                  ))}
                </div>
              ) : null}
            </fieldset>
          </li>
        )
      })}
    </ol>
  )
}
