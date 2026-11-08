/**
 * The operator pages' frame.
 *
 * `/admin` used to be one long document: funnel, requests, invites, people, two
 * logs and feedback, all stacked. It now follows Settings: one topic per screen,
 * picked from the column on the left, so a queue is not read past six other
 * blocks to be found.
 *
 * The screen is in the URL (`/admin?section=invites`), not in component state,
 * which is what lets the Forms page keep the same column and makes a section
 * something that can be linked to or reached with Back.
 */

import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import type { LucideIcon } from 'lucide-react'
import {
  ClipboardList,
  Inbox,
  LayoutDashboard,
  MessageSquare,
  Sparkles,
  Ticket,
  TriangleAlert,
  Users,
} from 'lucide-react'

import { cn } from '#/lib/utils'

export type AdminSectionKey =
  | 'overview'
  | 'forms'
  | 'requests'
  | 'invites'
  | 'people'
  | 'activity'
  | 'errors'
  | 'feedback'

type AdminItem = {
  key: AdminSectionKey
  label: string
  icon: LucideIcon
  /** The line under the title when this section is open. */
  description: string
}

/** The column, in the order an operator works through the beta. */
export const ADMIN_SECTIONS: Array<{ group: string; items: AdminItem[] }> = [
  {
    group: 'Beta',
    items: [
      {
        key: 'overview',
        label: 'Overview',
        icon: LayoutDashboard,
        description:
          'Who asked, who got in, and how far they got. Every action here re-checks that you are signed in as an operator.',
      },
      {
        key: 'forms',
        label: 'Forms',
        icon: ClipboardList,
        description:
          'Ask the beta a question. Published forms are frozen so the answers stay comparable.',
      },
    ],
  },
  {
    group: 'People',
    items: [
      {
        key: 'requests',
        label: 'Requests',
        icon: Inbox,
        description:
          'People asking for an invite. Approving mints a link, and emails it when mail is configured.',
      },
      {
        key: 'invites',
        label: 'Invites',
        icon: Ticket,
        description:
          'Every link you have issued, its state, and a replacement when the old code is gone.',
      },
      {
        key: 'people',
        label: 'People',
        icon: Users,
        description:
          'Who has an account, which mailboxes they connected, and when they were last here.',
      },
    ],
  },
  {
    group: 'Activity',
    items: [
      {
        key: 'activity',
        label: 'AI activity',
        icon: Sparkles,
        description:
          'Every call to Jev or the topic model, including the failures the rules paper over.',
      },
      {
        key: 'errors',
        label: 'Recent errors',
        icon: TriangleAlert,
        description:
          'The last failures written to app.log: a request that threw, a sync that stopped, a read mark the mailbox refused.',
      },
      {
        key: 'feedback',
        label: 'Feedback',
        icon: MessageSquare,
        description: 'What the beta wrote to you, and where each note stands.',
      },
    ],
  },
]

const ADMIN_ITEMS = ADMIN_SECTIONS.flatMap((group) => group.items)

/** The URL value as a section, or `undefined` for anything unrecognised. */
export function adminSectionFrom(value: unknown): AdminSectionKey | undefined {
  return ADMIN_ITEMS.find((item) => item.key === value)?.key
}

/** The row style Settings uses for its sections, so both columns match. */
const ROW =
  'flex h-[34px] items-center gap-2.5 rounded-[4px] px-2.5 text-left text-[12.5px] transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'

function rowClass(active: boolean) {
  return cn(
    ROW,
    active
      ? 'bg-muted/70 font-semibold text-foreground'
      : 'font-medium text-foreground/90 hover:bg-muted/40',
  )
}

export function AdminShell({
  active,
  title,
  description,
  eyebrow,
  actions,
  counts,
  children,
}: {
  active: AdminSectionKey
  /** Defaults to the section's own name, as Settings does. */
  title?: string
  description?: string
  /** A line above the title — the "All forms" link on a single form. */
  eyebrow?: ReactNode
  /** Buttons for the screen, right of its title. */
  actions?: ReactNode
  /** Numbers beside a nav row, e.g. pending requests. */
  counts?: Partial<Record<AdminSectionKey, number>>
  children: ReactNode
}) {
  const current = ADMIN_ITEMS.find((item) => item.key === active)

  return (
    <div className="flex min-h-screen bg-background">
      <aside className="sticky top-0 hidden h-screen w-[248px] shrink-0 flex-col gap-[18px] border-r border-border bg-card px-4 py-5 lg:flex">
        <div className="flex flex-col gap-[18px]">
          <div className="flex items-center gap-2.5">
            <span
              aria-hidden="true"
              className="flex size-[30px] items-center justify-center rounded-[6px] bg-primary font-display text-[15px] font-bold text-primary-foreground"
            >
              N
            </span>
            <span className="font-display text-xl font-semibold tracking-tight text-foreground">
              Nuntia
            </span>
          </div>

          <nav aria-label="Admin" className="flex flex-col gap-4">
            {ADMIN_SECTIONS.map((group) => (
              <div key={group.group} className="flex flex-col gap-0.5">
                <p className="px-2.5 pt-1 pb-1 text-[10px] font-semibold tracking-[0.12em] text-muted-foreground/70 uppercase">
                  {group.group}
                </p>
                {group.items.map((item) => (
                  <AdminRow
                    key={item.key}
                    item={item}
                    active={active === item.key}
                    count={counts?.[item.key]}
                  />
                ))}
              </div>
            ))}
          </nav>
        </div>

        <div className="mt-auto flex flex-col gap-0.5 border-t border-border pt-3">
          <Link
            to="/"
            className="flex h-[34px] items-center rounded-[4px] px-2.5 text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
          >
            Back to the app
          </Link>
          <Link
            to="/settings"
            className="flex h-[34px] items-center rounded-[4px] px-2.5 text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
          >
            Settings
          </Link>
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
          {/* Narrow screens lose the column, so the same sections sit above the
              content as a strip — the way Settings does it. */}
          <div
            role="group"
            aria-label="Admin sections"
            className="mb-5 flex gap-1 overflow-x-auto rounded-lg border border-border bg-muted/40 p-1 lg:hidden"
          >
            {ADMIN_ITEMS.map((item) => (
              <MobileRow
                key={item.key}
                item={item}
                active={active === item.key}
              />
            ))}
          </div>

          {eyebrow}

          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h1 className="font-display text-2xl font-bold tracking-tight text-foreground">
              {title ?? current?.label ?? 'Admin'}
            </h1>
            {actions}
          </div>
          {(description ?? current?.description) ? (
            <p className="mt-1 text-sm text-muted-foreground">
              {description ?? current?.description}
            </p>
          ) : null}

          <div className="mt-6 space-y-5">{children}</div>
        </div>
      </div>
    </div>
  )
}

/** One destination in the desktop column. Forms is a route, the rest a section. */
function AdminRow({
  item,
  active,
  count,
}: {
  item: AdminItem
  active: boolean
  count?: number
}) {
  const Icon = item.icon

  const content = (
    <>
      <Icon aria-hidden="true" className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {typeof count === 'number' && count > 0 ? (
        <span className="shrink-0 text-[11px] font-semibold text-muted-foreground/70 tabular-nums">
          {count}
        </span>
      ) : null}
    </>
  )

  if (item.key === 'forms') {
    return (
      <Link
        to="/admin/forms"
        aria-current={active ? 'page' : undefined}
        className={rowClass(active)}
      >
        {content}
      </Link>
    )
  }

  return (
    <Link
      to="/admin"
      search={{ section: item.key }}
      aria-current={active ? 'page' : undefined}
      className={rowClass(active)}
    >
      {content}
    </Link>
  )
}

function MobileRow({ item, active }: { item: AdminItem; active: boolean }) {
  const className = cn(
    'inline-flex h-7 shrink-0 items-center rounded-md px-2.5 text-xs font-medium transition-colors',
    active
      ? 'bg-card text-foreground shadow-sm'
      : 'text-muted-foreground hover:text-foreground',
  )

  if (item.key === 'forms') {
    return (
      <Link
        to="/admin/forms"
        aria-current={active ? 'page' : undefined}
        className={className}
      >
        {item.label}
      </Link>
    )
  }

  return (
    <Link
      to="/admin"
      search={{ section: item.key }}
      aria-current={active ? 'page' : undefined}
      className={className}
    >
      {item.label}
    </Link>
  )
}
