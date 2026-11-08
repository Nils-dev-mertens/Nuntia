/**
 * The Nuntia team's questions, answered without leaving the app.
 *
 * `/ask` and `/ask/<id>` remain for deep links, but the inbox is where a
 * question is noticed, so that is where answering belongs: the dialog keeps the
 * list (and the thread being read) behind it, and a person who changes their
 * mind is one Escape away. The questions themselves are `FormFields`, the same
 * renderer the answer page and the operator's preview use.
 */

import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { X } from 'lucide-react'

import { FormFields } from '#/components/form-fields.tsx'
import type { FormAnswers } from '#/components/form-fields.tsx'
import {
  listOpenQuestions,
  loadQuestionForm,
  submitQuestionAnswers,
} from '#/lib/forms/ask-actions.ts'
import type { OpenForm, UserForm } from '#/lib/forms/repository.ts'
import type { FormAnswerInput } from '#/lib/forms/validation.ts'
import { cn } from '#/lib/utils'

/** The stored answers, in the shape the fields edit in place. */
function answersFrom(form: UserForm): FormAnswers {
  if (form.state !== 'open') return {}

  return Object.fromEntries(
    form.answers.map((answer) => [
      answer.questionId,
      {
        text: answer.text ?? undefined,
        number: answer.number,
        choices: answer.choices ?? undefined,
      },
    ]),
  )
}

export function QuestionsOverlay({
  open,
  initialFormId,
  onClose,
  onAnswered,
}: {
  open: boolean
  /** The form the banner pointed at; the first unanswered one is the fallback. */
  initialFormId: string | null
  onClose: () => void
  /** After a successful answer, so the inbox can re-read its counts. */
  onAnswered: () => void
}) {
  const [forms, setForms] = useState<OpenForm[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [listVersion, setListVersion] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [form, setForm] = useState<UserForm | null>(null)
  const [answers, setAnswers] = useState<FormAnswers>({})
  const [loadingForm, setLoadingForm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [thanks, setThanks] = useState(false)
  const closeButton = useRef<HTMLButtonElement>(null)

  // Callbacks in refs: the parent passes fresh closures on every render, and the
  // effects below must not restart (and re-fetch, and re-focus) because of that.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const onAnsweredRef = useRef(onAnswered)
  onAnsweredRef.current = onAnswered

  // Reset when a window opens, kept apart from the list fetch: re-reading the
  // list after an answer must not send the person back to the first question.
  useEffect(() => {
    if (!open) return
    setSelectedId(initialFormId)
    setForms(null)
    setThanks(false)
    setError(null)
  }, [open, initialFormId])

  useEffect(() => {
    if (!open) return

    let cancelled = false
    setListError(null)

    void listOpenQuestions()
      .then((state) => {
        if (cancelled) return
        if (!state.signedIn) {
          setForms([])
          return
        }
        setForms(state.forms)
        // The newest unanswered one first, then anything already answered so it
        // stays editable — but never replacing a row the person picked.
        setSelectedId((current) => {
          if (current) return current
          const next =
            state.forms.find((item) => !item.submitted) ?? state.forms[0]
          return next?.id ?? null
        })
      })
      .catch(() => {
        if (cancelled) return
        setForms([])
        setListError('Could not load the questions. Try again in a moment.')
      })

    return () => {
      cancelled = true
    }
  }, [open, listVersion])

  useEffect(() => {
    if (!open || !selectedId) {
      setForm(null)
      setAnswers({})
      return
    }

    let cancelled = false
    setLoadingForm(true)
    setForm(null)
    setAnswers({})
    setThanks(false)
    setError(null)

    void loadQuestionForm({ data: { id: selectedId } })
      .then((state) => {
        if (cancelled || !state.signedIn) return
        setForm(state.form)
        setAnswers(answersFrom(state.form))
      })
      .catch(() => {
        if (!cancelled) setError('Could not load this question.')
      })
      .finally(() => {
        if (!cancelled) setLoadingForm(false)
      })

    return () => {
      cancelled = true
    }
  }, [open, selectedId])

  useEffect(() => {
    if (!open) return

    const previousFocus = document.activeElement as HTMLElement | null
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current()
    }
    // A dialog over a scrolling list would still scroll the list underneath.
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', onKeyDown)
    closeButton.current?.focus()

    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', onKeyDown)
      previousFocus?.focus()
    }
  }, [open])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!form || form.state !== 'open' || !selectedId || busy) return

    setBusy(true)
    setError(null)
    try {
      const payload: FormAnswerInput[] = form.questions.map((question) => {
        const answer = answers[question.id] ?? {}
        return {
          questionId: question.id,
          text: answer.text ?? null,
          number: answer.number ?? null,
          choices: answer.choices ?? null,
        }
      })

      const result = await submitQuestionAnswers({
        data: { id: selectedId, answers: payload },
      })
      if (result.error) {
        setError(result.error)
        return
      }

      setThanks(true)
      // Reloads the list so the row in the window says "answered" too.
      setListVersion((version) => version + 1)
      onAnsweredRef.current()
    } catch {
      setError('Could not reach the server. Try again.')
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null

  const selected = forms?.find((item) => item.id === selectedId) ?? null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Questions"
      onMouseDown={(event) => {
        // Only a click on the backdrop closes: a drag that starts inside the
        // window and ends out here is a text selection, not a dismissal.
        if (event.target === event.currentTarget) onClose()
      }}
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/70 p-3 backdrop-blur-sm sm:p-6"
    >
      <div className="flex max-h-[calc(100dvh-1.5rem)] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl sm:max-h-[calc(100dvh-3rem)]">
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4 sm:px-6 sm:py-5">
          <div className="min-w-0">
            <h2 className="font-display text-2xl font-semibold tracking-tight text-foreground">
              Questions
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              What the Nuntia team is asking. Answer here — the inbox stays
              behind this window.
            </p>
          </div>
          <button
            ref={closeButton}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X aria-hidden="true" className="size-5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {forms === null && !listError ? (
            <p className="px-6 py-10 text-sm text-muted-foreground">
              Loading questions…
            </p>
          ) : null}

          {listError ? (
            <p
              role="alert"
              className="m-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {listError}
            </p>
          ) : null}

          {forms && forms.length === 0 && !listError ? (
            <p className="px-6 py-10 text-sm text-muted-foreground">
              Nothing open right now. The feedback box is always there.
            </p>
          ) : null}

          {forms && forms.length > 0 ? (
            <>
              {/* Tabs rather than a list page: the window is for answering, and
                  every open question is one click from the others. */}
              {/* Two columns once there is room: the questions as a rail, the
                  one being answered in the wide half. Narrow screens keep the
                  strip above the form. */}
              <div className="md:grid md:grid-cols-[16rem_minmax(0,1fr)]">
                <div
                  role="tablist"
                  aria-label="Open questions"
                  className="flex flex-wrap gap-1 border-b border-border p-3 md:flex-col md:flex-nowrap md:border-r md:border-b-0"
                >
                  {forms.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      role="tab"
                      aria-selected={item.id === selectedId}
                      onClick={() => setSelectedId(item.id)}
                      className={cn(
                        'inline-flex max-w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-left text-xs font-medium transition-colors md:w-full',
                        item.id === selectedId
                          ? 'bg-muted text-foreground'
                          : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      <span className="truncate">{item.title}</span>
                      {item.submitted ? (
                        <span className="shrink-0 text-[10px] text-muted-foreground">
                          answered
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>

                <div className="p-5 sm:p-6">
                  {loadingForm ? (
                    <p className="text-sm text-muted-foreground">Loading…</p>
                  ) : null}

                  {!loadingForm && !form ? (
                    <p className="text-sm text-muted-foreground">
                      Pick a question above.
                    </p>
                  ) : null}

                  {form && form.state === 'unavailable' ? (
                    <p className="text-sm text-muted-foreground">
                      These questions are not available.
                    </p>
                  ) : null}

                  {form && form.state === 'closed' ? (
                    <p className="text-sm text-muted-foreground">
                      This form has closed. Thanks for taking a look.
                    </p>
                  ) : null}

                  {form && form.state === 'submitted' ? (
                    <p className="text-sm text-muted-foreground">
                      You already answered this one. Thank you.
                    </p>
                  ) : null}

                  {form && form.state === 'open' && thanks ? (
                    <div>
                      <p className="font-display text-lg font-semibold text-foreground">
                        Thanks
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        That is recorded, and it is read by the person who runs
                        this beta.
                      </p>
                      <div className="mt-4 flex items-center gap-4">
                        <button
                          type="button"
                          onClick={onClose}
                          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
                        >
                          Done
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setThanks(false)
                            setListVersion((version) => version + 1)
                          }}
                          className="text-xs text-muted-foreground hover:underline"
                        >
                          Change answers
                        </button>
                      </div>
                    </div>
                  ) : null}

                  {form && form.state === 'open' && !thanks ? (
                    <>
                      <h3 className="font-display text-lg font-semibold tracking-tight text-foreground">
                        {selected?.title ?? form.title}
                      </h3>
                      {form.description ? (
                        <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                          {form.description}
                        </p>
                      ) : null}
                      {form.submitted ? (
                        <p className="mt-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                          You already answered this one. Sending again replaces
                          those answers, and stays possible until the form
                          closes.
                        </p>
                      ) : null}

                      <form onSubmit={(event) => void submit(event)}>
                        <FormFields
                          questions={form.questions}
                          answers={answers}
                          onChange={(questionId, next) =>
                            setAnswers((current) => ({
                              ...current,
                              [questionId]: next,
                            }))
                          }
                          disabled={busy}
                          idPrefix="questions"
                        />

                        {error ? (
                          <p
                            role="alert"
                            className="mt-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                          >
                            {error}
                          </p>
                        ) : null}

                        <button
                          type="submit"
                          disabled={busy}
                          className="mt-5 w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
                        >
                          {busy
                            ? 'Sending…'
                            : form.submitted
                              ? 'Update answers'
                              : 'Send answers'}
                        </button>
                      </form>

                      <p className="mt-3 text-[11px] text-muted-foreground">
                        Answers are attached to your account and visible only to
                        the person who runs this beta.
                      </p>
                    </>
                  ) : null}
                </div>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}
