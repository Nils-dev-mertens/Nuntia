/**
 * The hero island: a small but working replica of the Nuntia inbox.
 *
 * It is a demo, not a screenshot. Everything in it behaves: sections and tags
 * filter, search narrows the list, a thread opens, states can be changed, tags
 * added and removed, a draft can be moved into the reply box. Nothing is sent
 * and nothing leaves the page — the mail is synthetic and lives in this file.
 *
 * The point is to let a visitor answer "does this fit how I read mail?" before
 * requesting access, so the interactions mirror the real screen rather than
 * showing a video of it.
 *
 * Motion handles what CSS cannot: rows animating out when a filter changes,
 * the reading pane crossfading between threads, the count badges. The animated
 * grid behind the card is a canvas, and it stops drawing when it is off-screen.
 */

import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  ChevronLeft,
  CornerDownLeft,
  Inbox,
  Plus,
  RotateCcw,
  Search,
  Send,
  Sparkles,
  Tag,
  X,
} from 'lucide-react'

type StateId = 'needs-action' | 'waiting' | 'info' | 'low'
type ThreadState = StateId | 'done'
type SectionId = 'all' | ThreadState

type Message = {
  who: string
  initials: string
  time: string
  body: string
}

type Thread = {
  id: string
  name: string
  initials: string
  subject: string
  preview: string
  tags: string[]
  state: ThreadState
  time: string
  importance: number | null
  messages: Message[]
  draft: string | null
}

const STATE_META: Record<
  ThreadState,
  { label: string; chip: string; dot: string }
> = {
  'needs-action': {
    label: 'Needs action',
    chip: 'border-primary/40 bg-primary/10 text-primary',
    dot: 'bg-primary',
  },
  waiting: {
    label: 'Waiting for reply',
    chip: 'border-warning/40 bg-warning/10 text-warning',
    dot: 'bg-warning',
  },
  info: {
    label: 'Information',
    chip: 'border-border bg-muted text-muted-foreground',
    dot: 'bg-muted-foreground',
  },
  low: {
    label: 'Low priority',
    chip: 'border-border bg-muted text-muted-foreground/70',
    dot: 'bg-muted-foreground/60',
  },
  done: {
    label: 'Done',
    chip: 'border-success/40 bg-success/10 text-success',
    dot: 'bg-success',
  },
}

const SECTIONS: Array<{ id: SectionId; label: string; dot: string }> = [
  { id: 'all', label: 'All mail', dot: 'bg-foreground/40' },
  { id: 'needs-action', label: 'Needs action', dot: 'bg-primary' },
  { id: 'waiting', label: 'Waiting for reply', dot: 'bg-warning' },
  { id: 'info', label: 'Information', dot: 'bg-muted-foreground' },
  { id: 'low', label: 'Low priority', dot: 'bg-muted-foreground/60' },
  { id: 'done', label: 'Done', dot: 'bg-success' },
]

const TAG_CATALOG = [
  'investor',
  'client',
  'supplier',
  'internal',
  'legal',
] as const

const INITIAL_THREADS: Thread[] = [
  {
    id: 'ana',
    name: 'Ana de Vries',
    initials: 'AV',
    subject: 'Seed round — monthly update',
    preview: 'Could you send the update before Friday?',
    tags: ['investor'],
    state: 'needs-action',
    time: '09:41',
    importance: 7,
    messages: [
      {
        who: 'Ana de Vries',
        initials: 'AV',
        time: '09:41',
        body: 'Morning. Could you send the monthly update before Friday? The board pack goes out Monday and I would like to include the retention numbers.',
      },
      {
        who: 'Me',
        initials: 'ME',
        time: 'Yesterday',
        body: 'Of course — I am pulling the numbers together now and will send them over.',
      },
    ],
    draft:
      'Hi Ana — the update will be with you before Friday. I am adding the retention numbers now so they land in the same file.',
  },
  {
    id: 'elena',
    name: 'Elena Ruiz',
    initials: 'ER',
    subject: 'Staging logs before the release',
    preview: 'Can you look at the error spike from last night?',
    tags: ['client'],
    state: 'needs-action',
    time: '08:12',
    importance: 9,
    messages: [
      {
        who: 'Elena Ruiz',
        initials: 'ER',
        time: '08:12',
        body: 'The release is booked for Thursday. Can you look at the error spike from last night and tell me whether it changes the plan?',
      },
    ],
    draft:
      'Hi Elena — I have been through the logs. The spike is one retrying webhook, not a new error. Nothing in it moves Thursday; I will keep an eye on it until the release.',
  },
  {
    id: 'piet',
    name: 'Piet Bakker',
    initials: 'PB',
    subject: 'Invoice 2041 — payment date',
    preview: 'The invoice is attached; no rush on the payment.',
    tags: ['supplier'],
    state: 'waiting',
    time: 'Tue',
    importance: 3,
    messages: [
      {
        who: 'Piet Bakker',
        initials: 'PB',
        time: 'Tue',
        body: 'The invoice for the February delivery is attached. No rush on the payment — the usual thirty days is fine.',
      },
    ],
    draft: null,
  },
  {
    id: 'marcus',
    name: 'Marcus Klein',
    initials: 'MK',
    subject: 'Board pack v3 — two notes',
    preview: 'Numbers look right; the hiring slide needs a date.',
    tags: ['investor'],
    state: 'info',
    time: 'Mon',
    importance: 5,
    messages: [
      {
        who: 'Marcus Klein',
        initials: 'MK',
        time: 'Mon',
        body: 'Numbers look right to me. The only thing missing is a date on the hiring slide — otherwise I am happy to send it round.',
      },
    ],
    draft: null,
  },
  {
    id: 'design',
    name: 'Design weekly',
    initials: 'DW',
    subject: 'Thursday notes, week 46',
    preview: 'Recording and slides from this week are up.',
    tags: ['internal'],
    state: 'info',
    time: 'Mon',
    importance: 2,
    messages: [
      {
        who: 'Design weekly',
        initials: 'DW',
        time: 'Mon',
        body: 'The recording and slides from this week are in the shared folder. Nothing needs a decision before Thursday.',
      },
    ],
    draft: null,
  },
  {
    id: 'joost',
    name: 'Joost Smit',
    initials: 'JS',
    subject: 'Introduction to a fund II founder',
    preview: 'Happy to introduce you if it is useful.',
    tags: ['investor'],
    state: 'low',
    time: 'Sun',
    importance: 1,
    messages: [
      {
        who: 'Joost Smit',
        initials: 'JS',
        time: 'Sun',
        body: 'I met someone last week who is raising a second fund and looking at tools like yours. Happy to introduce you if it is useful — no pressure either way.',
      },
    ],
    draft: null,
  },
  {
    id: 'sanne',
    name: 'Sanne de Boer',
    initials: 'SB',
    subject: 'NDA countersigned',
    preview: 'Signed copy attached for your records.',
    tags: ['client', 'legal'],
    state: 'done',
    time: 'Fri',
    importance: null,
    messages: [
      {
        who: 'Sanne de Boer',
        initials: 'SB',
        time: 'Fri',
        body: 'Signed copy attached for your records. Thanks for turning it around so quickly.',
      },
    ],
    draft: null,
  },
]

const SUGGESTED_TAGS = ['board observer', 'fund II', 'press'] as const

/** Deep copy so "Reset demo" can put every thread back exactly as it started. */
function resetThreads(): Thread[] {
  return INITIAL_THREADS.map((thread) => ({
    ...thread,
    tags: [...thread.tags],
    messages: thread.messages.map((message) => ({ ...message })),
  }))
}

/**
 * Hairline grid with a few slow pulses.
 *
 * Redraws every frame, but only touches a canvas, stops when it scrolls out of
 * view, and stops entirely when the visitor asked for reduced motion: the grid
 * is painted once and left alone.
 */
function GridBackdrop() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const reduceMotion = useReducedMotion()

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const context = canvas.getContext('2d')
    if (!context) return

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const cell = 42
    let width = 0
    let height = 0
    let frame = 0
    let inView = true

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      width = rect.width
      height = rect.height
      canvas.width = Math.max(1, Math.round(width * dpr))
      canvas.height = Math.max(1, Math.round(height * dpr))
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    const paint = (time: number) => {
      context.clearRect(0, 0, width, height)

      const cols = Math.ceil(width / cell)
      const rows = Math.ceil(height / cell)

      // Sparse pulses: one cell in twenty-three, each on its own phase.
      if (!reduceMotion) {
        for (let column = 0; column < cols; column += 1) {
          for (let row = 0; row < rows; row += 1) {
            if ((column * 31 + row * 17) % 23 !== 0) continue

            const wave =
              0.5 + 0.5 * Math.sin(time * 0.7 + column * 0.8 + row * 1.4)
            context.fillStyle = `rgba(255, 87, 34, ${0.03 + wave * 0.09})`
            context.fillRect(
              column * cell + 1,
              row * cell + 1,
              cell - 2,
              cell - 2,
            )
          }
        }
      }

      context.strokeStyle = 'rgba(255, 255, 255, 0.055)'
      context.lineWidth = 1
      context.beginPath()
      for (let column = 0; column <= cols; column += 1) {
        const x = column * cell + 0.5
        context.moveTo(x, 0)
        context.lineTo(x, height)
      }
      for (let row = 0; row <= rows; row += 1) {
        const y = row * cell + 0.5
        context.moveTo(0, y)
        context.lineTo(width, y)
      }
      context.stroke()
    }

    const loop = (now: number) => {
      frame = requestAnimationFrame(loop)
      if (!inView) return
      paint(now / 1000)
    }

    const observer = new ResizeObserver(() => {
      resize()
      if (reduceMotion) paint(0)
    })
    observer.observe(canvas)

    const visibility = new IntersectionObserver(
      (entries) => {
        inView = entries[0]?.isIntersecting ?? true
      },
      { rootMargin: '160px' },
    )
    visibility.observe(canvas)

    resize()
    if (reduceMotion) {
      paint(0)
    } else {
      frame = requestAnimationFrame(loop)
    }

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      visibility.disconnect()
    }
  }, [reduceMotion])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 h-full w-full"
    />
  )
}

export default function HeroVisual() {
  const reduceMotion = useReducedMotion()
  const [threads, setThreads] = useState<Thread[]>(resetThreads)
  const [section, setSection] = useState<SectionId>('all')
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [activeId, setActiveId] = useState<string | null>(
    INITIAL_THREADS[0]?.id ?? null,
  )
  const [mobileOpen, setMobileOpen] = useState(false)
  const [reply, setReply] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)

  const counts = useMemo(() => {
    const result: Record<SectionId, number> = {
      all: threads.length,
      'needs-action': 0,
      waiting: 0,
      info: 0,
      low: 0,
      done: 0,
    }
    for (const thread of threads) result[thread.state] += 1
    return result
  }, [threads])

  const tagCounts = useMemo(() => {
    const result = new Map<string, number>()
    for (const thread of threads) {
      for (const tag of thread.tags) {
        result.set(tag, (result.get(tag) ?? 0) + 1)
      }
    }
    return result
  }, [threads])

  const allTags = useMemo(() => {
    const known = new Set<string>(TAG_CATALOG)
    for (const thread of threads) thread.tags.forEach((tag) => known.add(tag))
    return [...known]
  }, [threads])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return threads.filter((thread) => {
      if (section !== 'all' && thread.state !== section) return false
      if (tagFilter && !thread.tags.includes(tagFilter)) return false
      if (!needle) return true
      return `${thread.name} ${thread.subject} ${thread.preview} ${thread.tags.join(
        ' ',
      )}`
        .toLowerCase()
        .includes(needle)
    })
  }, [threads, section, tagFilter, query])

  const active = threads.find((thread) => thread.id === activeId) ?? null

  // When a filter hides the open thread, open the first one that is still
  // visible. The reading pane never shows a thread the list does not contain.
  useEffect(() => {
    if (visible.some((thread) => thread.id === activeId)) return
    setActiveId(visible[0]?.id ?? null)
  }, [visible, activeId])

  // A reply typed into one thread does not belong to the next one.
  useEffect(() => {
    setReply('')
  }, [activeId])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 2600)
    return () => window.clearTimeout(timer)
  }, [notice])

  // `/` or Cmd/Ctrl+K focuses search, Escape leaves it — the shortcuts the
  // real app uses, so the demo does not teach a different habit.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing =
        target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA'

      if (
        event.key === '/' &&
        !typing &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      ) {
        event.preventDefault()
        searchRef.current?.focus()
        return
      }

      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
        return
      }

      if (event.key !== 'Escape') return
      if (typing) {
        setQuery('')
        target?.blur()
      } else if (mobileOpen) {
        setMobileOpen(false)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [mobileOpen])

  const updateActive = (change: (thread: Thread) => Thread) => {
    if (!activeId) return
    setThreads((current) =>
      current.map((thread) =>
        thread.id === activeId ? change(thread) : thread,
      ),
    )
  }

  const changeState = (state: ThreadState) => {
    if (!active) return
    updateActive((thread) => ({ ...thread, state }))
    setNotice(`Moved to ${STATE_META[state].label}`)
  }

  const addTag = (tag: string) => {
    if (!active || active.tags.includes(tag)) return
    updateActive((thread) => ({ ...thread, tags: [...thread.tags, tag] }))
    setNotice(`Tagged ${active.name} as ${tag}`)
  }

  const removeTag = (tag: string) => {
    updateActive((thread) => ({
      ...thread,
      tags: thread.tags.filter((current) => current !== tag),
    }))
    setNotice(`Removed ${tag}`)
  }

  const useDraft = () => {
    if (!active?.draft) return
    setReply(active.draft)
    setNotice('Draft moved into the reply box — edit it or send it yourself')
  }

  const resetDemo = () => {
    setThreads(resetThreads())
    setSection('all')
    setTagFilter(null)
    setQuery('')
    setActiveId(INITIAL_THREADS[0]?.id ?? null)
    setMobileOpen(false)
    setReply('')
    setNotice('Demo reset')
  }

  const fade = reduceMotion
    ? { duration: 0 }
    : { duration: 0.28, ease: [0.22, 1, 0.36, 1] as const }

  const rowMotion = reduceMotion
    ? {}
    : {
        initial: { opacity: 0, y: 10 },
        animate: { opacity: 1, y: 0 },
        exit: { opacity: 0, height: 0 },
        transition: { duration: 0.24, ease: [0.22, 1, 0.36, 1] as const },
      }

  return (
    <div className="relative isolate mx-auto mt-10 max-w-6xl md:mt-14">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -inset-x-6 -inset-y-8 -z-10 overflow-hidden rounded-xl"
      >
        <GridBackdrop />
      </div>

      <p className="mb-3 flex items-center justify-center gap-2 font-mono text-[10px] tracking-[0.12em] text-muted-foreground uppercase">
        <span aria-hidden="true" className="size-1.5 rounded-full bg-primary" />
        Interactive demo · synthetic mail · nothing is sent
      </p>

      <motion.div
        initial={reduceMotion ? false : { opacity: 0, y: 26 }}
        animate={{ opacity: 1, y: 0 }}
        transition={
          reduceMotion
            ? { duration: 0 }
            : { duration: 0.7, ease: [0.22, 1, 0.36, 1] }
        }
        className="overflow-hidden rounded-lg border border-border bg-card/95 text-left backdrop-blur-sm"
      >
        {/* Workspace bar */}
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/30 px-3 py-2.5 md:px-4">
          <div className="flex items-center gap-2 font-mono text-[10px] tracking-[0.12em] text-muted-foreground uppercase">
            <span
              aria-hidden="true"
              className="size-2 rounded-full bg-success"
            />
            Nuntia · inbox
          </div>
          <span
            aria-hidden="true"
            className="hidden h-3 w-px bg-border sm:block"
          />
          <span className="hidden font-mono text-[10px] text-muted-foreground sm:block">
            2 mailboxes · synced 09:41
          </span>

          <div className="relative order-last flex w-full items-center gap-2 rounded-[4px] border border-border bg-background/60 px-2.5 py-1.5 focus-within:border-primary/50 sm:order-none sm:ml-auto sm:w-64">
            <Search
              aria-hidden="true"
              className="size-3.5 shrink-0 text-muted-foreground"
            />
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search mail, people, tags"
              aria-label="Search the demo inbox"
              className="min-w-0 flex-1 bg-transparent text-[12px] text-foreground outline-none placeholder:text-muted-foreground/70 [&::-webkit-search-cancel-button]:hidden"
            />
            <kbd className="hidden shrink-0 rounded-[2px] border border-border px-1 font-mono text-[9px] text-muted-foreground sm:block">
              /
            </kbd>
          </div>

          <button
            type="button"
            onClick={resetDemo}
            title="Reset the demo"
            className="flex items-center gap-1 rounded-[3px] border border-border px-1.5 py-1 font-mono text-[9px] tracking-[0.08em] text-muted-foreground uppercase transition-colors hover:border-foreground/20 hover:text-foreground"
          >
            <RotateCcw aria-hidden="true" className="size-3" />
            <span className="hidden sm:inline">Reset</span>
          </button>

          <span aria-hidden="true" className="hidden -space-x-1.5 pl-1 sm:flex">
            {['AV', 'MK'].map((initials) => (
              <span
                key={initials}
                className="flex size-5 items-center justify-center rounded-full border border-card bg-muted font-display text-[8px] font-semibold"
              >
                {initials}
              </span>
            ))}
          </span>
        </div>

        <div className="grid lg:h-[600px] lg:grid-cols-[196px_minmax(0,1fr)_minmax(0,1.15fr)]">
          {/* Sections and tags */}
          <div className="hidden min-h-0 flex-col border-r border-border p-2.5 lg:flex">
            <p className="px-2 py-1 font-mono text-[9px] tracking-[0.12em] text-muted-foreground uppercase">
              Sections
            </p>
            <div className="flex flex-col gap-0.5">
              {SECTIONS.map((item) => {
                const selected = section === item.id && !tagFilter
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => {
                      setSection(item.id)
                      setTagFilter(null)
                    }}
                    className={`relative flex items-center gap-2 rounded-[4px] px-2 py-1.5 text-left text-[12px] transition-colors ${
                      selected
                        ? 'bg-muted text-foreground'
                        : 'text-foreground/70 hover:bg-muted/50 hover:text-foreground'
                    }`}
                  >
                    <span
                      aria-hidden="true"
                      className={`size-1.5 shrink-0 rounded-full ${item.dot}`}
                    />
                    <span className="flex-1 truncate">{item.label}</span>
                    <AnimatePresence mode="popLayout" initial={false}>
                      <motion.span
                        key={counts[item.id]}
                        initial={reduceMotion ? false : { opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={reduceMotion ? undefined : { opacity: 0, y: 4 }}
                        transition={fade}
                        className="font-mono text-[10px] text-muted-foreground"
                      >
                        {counts[item.id]}
                      </motion.span>
                    </AnimatePresence>
                  </button>
                )
              })}
            </div>

            <p className="mt-4 px-2 py-1 font-mono text-[9px] tracking-[0.12em] text-muted-foreground uppercase">
              Tags
            </p>
            <div className="flex flex-col gap-0.5">
              {allTags.map((tag) => {
                const selected = tagFilter === tag
                const count = tagCounts.get(tag) ?? 0
                return (
                  <button
                    key={tag}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => {
                      setTagFilter(selected ? null : tag)
                      setSection('all')
                    }}
                    className={`flex items-center gap-1.5 rounded-[4px] px-2 py-1.5 text-left text-[12px] transition-colors ${
                      selected
                        ? 'border border-primary/35 bg-primary/10 text-primary'
                        : 'border border-transparent text-foreground/70 hover:bg-muted/50 hover:text-foreground'
                    }`}
                  >
                    <Tag aria-hidden="true" className="size-3 shrink-0" />
                    <span className="flex-1 truncate">{tag}</span>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {count}
                    </span>
                  </button>
                )
              })}
            </div>

            <div className="mt-auto border-t border-border px-2 pt-2.5">
              <p className="font-mono text-[9px] leading-4 text-muted-foreground">
                Demo data. No mailbox is connected and no mail leaves this page.
              </p>
            </div>
          </div>

          {/* Thread list */}
          <div
            className={`flex min-h-0 min-w-0 flex-col border-border lg:border-r ${
              mobileOpen ? 'hidden lg:flex' : 'flex'
            }`}
          >
            {/* Sections have to stay reachable on a phone, where the rail is hidden. */}
            <div className="flex gap-1 overflow-x-auto border-b border-border px-2.5 py-2 lg:hidden">
              {SECTIONS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setSection(item.id)
                    setTagFilter(null)
                  }}
                  aria-pressed={section === item.id && !tagFilter}
                  className={`shrink-0 rounded-[3px] border px-2 py-1 font-mono text-[9px] tracking-[0.06em] uppercase transition-colors ${
                    section === item.id && !tagFilter
                      ? 'border-primary/40 bg-primary/10 text-primary'
                      : 'border-border text-muted-foreground'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>

            <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
              <span className="font-mono text-[9px] tracking-[0.12em] text-muted-foreground uppercase">
                {tagFilter
                  ? `Tag · ${tagFilter}`
                  : SECTIONS.find((item) => item.id === section)?.label}
              </span>
              <span className="font-mono text-[9px] text-muted-foreground">
                {visible.length} {visible.length === 1 ? 'thread' : 'threads'}
              </span>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              <AnimatePresence initial={false} mode="popLayout">
                {visible.map((thread) => {
                  const meta = STATE_META[thread.state]
                  const selected = thread.id === activeId
                  return (
                    <motion.button
                      key={thread.id}
                      type="button"
                      layout={!reduceMotion}
                      {...rowMotion}
                      onClick={() => {
                        setActiveId(thread.id)
                        setMobileOpen(true)
                      }}
                      aria-current={selected ? 'true' : undefined}
                      className={`relative flex w-full items-start gap-2.5 border-b border-border/70 px-3 py-2.5 text-left transition-colors ${
                        selected ? 'bg-muted/60' : 'hover:bg-muted/30'
                      }`}
                    >
                      {selected && (
                        <motion.span
                          aria-hidden="true"
                          layoutId="demo-thread-marker"
                          className="absolute inset-y-0 left-0 w-[2px] bg-primary"
                        />
                      )}
                      <span className="relative flex size-7 shrink-0 items-center justify-center rounded-full bg-muted font-display text-[9px] font-semibold text-foreground">
                        {thread.initials}
                        {thread.state === 'needs-action' && (
                          <span
                            aria-hidden="true"
                            className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full border border-card bg-primary"
                          />
                        )}
                      </span>

                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="truncate text-[12px] font-medium">
                            {thread.name}
                          </span>
                          <span className="ml-auto shrink-0 font-mono text-[9px] text-muted-foreground">
                            {thread.time}
                          </span>
                        </span>
                        <span className="mt-0.5 flex items-center gap-1.5">
                          <span
                            className={`shrink-0 rounded-[2px] border px-1 py-px font-mono text-[8px] tracking-[0.06em] uppercase ${meta.chip}`}
                          >
                            {meta.label}
                          </span>
                          {thread.tags.slice(0, 2).map((tag) => (
                            <span
                              key={tag}
                              className="shrink-0 rounded-[2px] border border-border bg-muted px-1 py-px font-mono text-[8px] tracking-[0.06em] text-muted-foreground uppercase"
                            >
                              {tag}
                            </span>
                          ))}
                        </span>
                        <span
                          className={`mt-1 block truncate text-[12px] ${
                            thread.state === 'done'
                              ? 'text-muted-foreground line-through'
                              : 'text-foreground/90'
                          }`}
                        >
                          {thread.subject}
                        </span>
                        <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                          {thread.preview}
                        </span>
                      </span>
                    </motion.button>
                  )
                })}
              </AnimatePresence>

              {visible.length === 0 && (
                <motion.div
                  initial={reduceMotion ? false : { opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="flex flex-col items-center gap-2 px-4 py-10 text-center"
                >
                  <Search
                    aria-hidden="true"
                    className="size-4 text-muted-foreground"
                  />
                  <p className="text-[12px] text-muted-foreground">
                    Nothing matches
                    {query ? ` “${query}”` : ' this filter'}.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setSection('all')
                      setTagFilter(null)
                      setQuery('')
                    }}
                    className="rounded-[3px] border border-border px-2 py-1 font-mono text-[9px] tracking-[0.08em] text-foreground uppercase hover:bg-muted"
                  >
                    Clear filters
                  </button>
                </motion.div>
              )}
            </div>
          </div>

          {/* Reading pane */}
          <div
            className={`min-h-0 min-w-0 flex-col ${
              mobileOpen ? 'flex' : 'hidden lg:flex'
            }`}
          >
            {active ? (
              <>
                <div className="border-b border-border px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setMobileOpen(false)}
                      className="flex items-center gap-0.5 font-mono text-[9px] tracking-[0.08em] text-muted-foreground uppercase hover:text-foreground lg:hidden"
                    >
                      <ChevronLeft aria-hidden="true" className="size-3" />
                      Inbox
                    </button>
                    <span className="ml-auto font-mono text-[9px] text-muted-foreground">
                      {active.messages.length}{' '}
                      {active.messages.length === 1 ? 'message' : 'messages'}
                    </span>
                  </div>

                  <AnimatePresence mode="wait" initial={false}>
                    <motion.div
                      key={active.id}
                      initial={reduceMotion ? false : { opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={reduceMotion ? undefined : { opacity: 0, y: -6 }}
                      transition={fade}
                    >
                      <h3 className="mt-1 text-[14px] leading-5 font-medium">
                        {active.subject}
                      </h3>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <span className="flex size-5 items-center justify-center rounded-full bg-muted font-display text-[8px] font-semibold">
                          {active.initials}
                        </span>
                        <span className="text-[11px] text-foreground/80">
                          {active.name}
                        </span>
                        <span
                          aria-hidden="true"
                          className="text-muted-foreground"
                        >
                          ·
                        </span>
                        {active.tags.map((tag) => (
                          <span
                            key={tag}
                            className="flex items-center gap-1 rounded-[2px] border border-border bg-muted px-1 py-px font-mono text-[8px] tracking-[0.06em] text-muted-foreground uppercase"
                          >
                            {tag}
                            <button
                              type="button"
                              onClick={() => removeTag(tag)}
                              aria-label={`Remove tag ${tag}`}
                              className="text-muted-foreground/70 transition-colors hover:text-foreground"
                            >
                              <X aria-hidden="true" className="size-2.5" />
                            </button>
                          </span>
                        ))}
                      </div>
                    </motion.div>
                  </AnimatePresence>

                  <div className="mt-2 flex flex-wrap items-center gap-1">
                    {(
                      ['needs-action', 'waiting', 'info', 'low'] as StateId[]
                    ).map((state) => (
                      <button
                        key={state}
                        type="button"
                        onClick={() => changeState(state)}
                        aria-pressed={active.state === state}
                        className={`rounded-[2px] border px-1.5 py-0.5 font-mono text-[8px] tracking-[0.06em] uppercase transition-colors ${
                          active.state === state
                            ? STATE_META[state].chip
                            : 'border-border text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        {STATE_META[state].label}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() =>
                        changeState(active.state === 'done' ? 'info' : 'done')
                      }
                      className={`ml-auto flex items-center gap-1 rounded-[2px] border px-1.5 py-0.5 font-mono text-[8px] tracking-[0.06em] uppercase transition-colors ${
                        active.state === 'done'
                          ? 'border-success/40 bg-success/10 text-success'
                          : 'border-border text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      <Check aria-hidden="true" className="size-2.5" />
                      {active.state === 'done' ? 'Done' : 'Mark done'}
                    </button>
                  </div>

                  {active.importance !== null && (
                    <p className="mt-2 flex items-center gap-1 font-mono text-[8px] tracking-[0.06em] text-muted-foreground uppercase">
                      <Sparkles
                        aria-hidden="true"
                        className="size-2.5 text-primary"
                      />
                      Importance {active.importance}/10 · scored from the thread
                    </p>
                  )}
                </div>

                <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
                  {active.messages.map((message) => (
                    <div
                      key={`${message.who}-${message.time}`}
                      className="flex gap-2"
                    >
                      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-muted font-display text-[8px] font-semibold">
                        {message.initials}
                      </span>
                      <div className="min-w-0 rounded-[5px] bg-muted/40 px-2.5 py-2">
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] font-medium">
                            {message.who}
                          </span>
                          <span className="font-mono text-[8px] text-muted-foreground">
                            {message.time}
                          </span>
                        </div>
                        <p className="mt-1 text-[12px] leading-5 text-foreground/90">
                          {message.body}
                        </p>
                      </div>
                    </div>
                  ))}

                  <AnimatePresence initial={false}>
                    {active.draft && (
                      <motion.div
                        initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={reduceMotion ? undefined : { opacity: 0, y: -6 }}
                        transition={fade}
                        className="rounded-[5px] border border-border bg-background/60 p-2.5"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="flex items-center gap-1 font-mono text-[8px] tracking-[0.08em] text-muted-foreground uppercase">
                            <Sparkles
                              aria-hidden="true"
                              className="size-2.5 text-primary"
                            />
                            Suggested draft
                          </span>
                          <span className="font-mono text-[8px] text-muted-foreground">
                            Edit before sending
                          </span>
                        </div>
                        <p className="mt-1.5 text-[12px] leading-5 text-foreground/90">
                          {active.draft}
                        </p>
                        <div className="mt-2 flex gap-1.5">
                          <button
                            type="button"
                            onClick={useDraft}
                            className="flex items-center gap-1 rounded-[3px] bg-primary px-2 py-1 font-mono text-[8px] tracking-[0.06em] text-primary-foreground uppercase transition-opacity hover:opacity-90"
                          >
                            <CornerDownLeft
                              aria-hidden="true"
                              className="size-2.5"
                            />
                            Use draft
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              updateActive((thread) => ({
                                ...thread,
                                draft: null,
                              }))
                              setNotice('Draft discarded')
                            }}
                            className="rounded-[3px] border border-border px-2 py-1 font-mono text-[8px] tracking-[0.06em] text-muted-foreground uppercase transition-colors hover:text-foreground"
                          >
                            Discard
                          </button>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>

                  {(SUGGESTED_TAGS as readonly string[]).some(
                    (tag) => !active.tags.includes(tag),
                  ) && (
                    <div className="flex flex-wrap items-center gap-1">
                      <span className="font-mono text-[8px] tracking-[0.08em] text-muted-foreground uppercase">
                        Suggest
                      </span>
                      {(SUGGESTED_TAGS as readonly string[])
                        .filter((tag) => !active.tags.includes(tag))
                        .slice(0, 2)
                        .map((tag) => (
                          <button
                            key={tag}
                            type="button"
                            onClick={() => addTag(tag)}
                            className="flex items-center gap-0.5 rounded-[2px] border border-dashed border-border px-1.5 py-0.5 font-mono text-[8px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                          >
                            <Plus aria-hidden="true" className="size-2.5" />
                            {tag}
                          </button>
                        ))}
                    </div>
                  )}
                </div>

                <div className="border-t border-border p-2.5">
                  <label className="sr-only" htmlFor="demo-reply">
                    Reply
                  </label>
                  <textarea
                    id="demo-reply"
                    rows={2}
                    value={reply}
                    onChange={(event) => setReply(event.target.value)}
                    placeholder={`Reply to ${active.name.split(' ')[0]}…`}
                    className="w-full resize-none rounded-[4px] border border-border bg-background/60 px-2.5 py-1.5 text-[12px] leading-5 text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-primary/40"
                  />
                  <div className="mt-1.5 flex items-center justify-between gap-2">
                    <span className="font-mono text-[8px] text-muted-foreground">
                      Nothing is sent from this page.
                    </span>
                    <button
                      type="button"
                      disabled
                      title="The demo does not send mail"
                      className="flex cursor-not-allowed items-center gap-1 rounded-[3px] bg-primary/40 px-2 py-1 font-mono text-[8px] tracking-[0.06em] text-primary-foreground uppercase"
                    >
                      <Send aria-hidden="true" className="size-2.5" />
                      Send
                    </button>
                  </div>
                  <div aria-live="polite" className="min-h-4">
                    <AnimatePresence initial={false}>
                      {notice && (
                        <motion.p
                          initial={reduceMotion ? false : { opacity: 0, y: 4 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={reduceMotion ? undefined : { opacity: 0 }}
                          transition={fade}
                          className="mt-1 flex items-center gap-1 font-mono text-[8px] text-muted-foreground"
                        >
                          <span
                            aria-hidden="true"
                            className="size-1 rounded-full bg-primary"
                          />
                          {notice}
                        </motion.p>
                      )}
                    </AnimatePresence>
                  </div>
                </div>
              </>
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
                <Inbox
                  aria-hidden="true"
                  className="size-5 text-muted-foreground"
                />
                <p className="text-[12px] text-muted-foreground">
                  Pick a thread on the left, or press <kbd>/</kbd> to search.
                </p>
              </div>
            )}
          </div>
        </div>
      </motion.div>
    </div>
  )
}
