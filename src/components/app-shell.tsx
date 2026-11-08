/**
 * The application shell from `design.pen` v3.
 *
 * A fixed 248px sidebar on the left, the screen's own content on the right.
 * The sidebar carries the three things the design made global: starting a
 * message, narrowing the list to one section, and the mailboxes the list is
 * merged from — so the inbox itself can stop repeating them in a header.
 *
 * Presentational on purpose. It receives the sections and the active one, and
 * calls back when one is picked; the inbox still owns what a section *is*.
 */

import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { Check, Inbox, PenLine, Plus, Settings } from 'lucide-react'

import { cn } from '#/lib/utils'

/** One row under SECTIONS: a state group, a custom label, or Done. */
export type ShellSection = {
  key: string
  title: string
  /** Background class for the row's dot, e.g. `bg-success`. */
  dotClass: string
  count: number
  /** The user's own label, rather than one of the four states. */
  custom?: boolean
  /** Done is a filing decision, so its row stays quiet. */
  muted?: boolean
}

/** "ND" from "nils@nuntia.app" — enough for a 32px avatar. */
function initialsOf(email: string): string {
  const local = email.split('@')[0] ?? email
  const parts = local.split(/[._-]+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return local.slice(0, 2).toUpperCase()
}

export function AppShell({
  sections = [],
  activeSection = '',
  onSelectSection,
  accounts,
  onCompose,
  nav,
  profileEmail,
  children,
}: {
  sections?: ShellSection[]
  /** `all`, a section key (`state:needs-action`, `label:<id>`, `done`), … */
  activeSection?: string
  onSelectSection?: (key: string) => void
  accounts: Array<{ id: string; email: string }>
  /** Opens the compose overlay; the design puts it beside the list. */
  onCompose?: () => void
  /**
   * Replaces the inbox navigation — New message, Inbox/Done, the section list —
   * with another screen's own. Settings uses it: the brand, mailboxes and
   * profile stay, but the middle of the sidebar becomes settings sections.
   */
  nav?: ReactNode
  /** Shown when no mailbox is connected yet, where the address list is empty. */
  profileEmail?: string
  children: ReactNode
}) {
  const profile = accounts[0]?.email ?? profileEmail ?? 'Not signed in'

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

          {nav ?? (
            <>
              <button
                type="button"
                onClick={onCompose}
                className={cn(
                  'flex h-[42px] w-full items-center justify-center gap-2 rounded-[4px] bg-white',
                  'text-sm font-medium text-[#0a0a0c] transition-colors hover:bg-white/90',
                  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                )}
              >
                <PenLine aria-hidden="true" className="size-4" />
                New message
              </button>

              <nav aria-label="Mailbox" className="flex flex-col gap-0.5">
                <NavRow
                  active={activeSection === 'all'}
                  onClick={() => onSelectSection?.('all')}
                  icon={<Inbox aria-hidden="true" className="size-4" />}
                  label="Inbox"
                  count={sections
                    .filter((section) => !section.muted)
                    .reduce((total, section) => total + section.count, 0)}
                />
                <NavRow
                  active={activeSection === 'done'}
                  onClick={() => onSelectSection?.('done')}
                  icon={<Check aria-hidden="true" className="size-4" />}
                  label="Done"
                  count={
                    sections.find((section) => section.key === 'done')?.count
                  }
                />
              </nav>

              {sections.length > 0 ? (
                <div className="flex flex-col gap-0.5">
                  <p className="px-2.5 pt-1 pb-1 text-[10px] font-semibold tracking-[0.12em] text-muted-foreground/70 uppercase">
                    Sections
                  </p>
                  {sections.map((section) => (
                    <button
                      key={section.key}
                      type="button"
                      onClick={() => onSelectSection?.(section.key)}
                      aria-current={
                        activeSection === section.key ? 'true' : undefined
                      }
                      className={cn(
                        'flex h-[34px] items-center gap-2.5 rounded-[4px] px-2.5 text-left',
                        'text-[12.5px] transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                        activeSection === section.key
                          ? 'bg-muted/70 font-semibold text-foreground'
                          : 'font-medium text-foreground/90 hover:bg-muted/40',
                        section.muted && 'text-muted-foreground',
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          'size-1.5 shrink-0 rounded-full',
                          section.dotClass,
                        )}
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {section.title}
                      </span>
                      <span className="shrink-0 text-[11px] font-semibold text-muted-foreground/70 tabular-nums">
                        {section.count}
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}
            </>
          )}
        </div>

        <div className="mt-auto flex flex-col gap-3">
          <div className="rounded-[4px] border border-border bg-muted/40 p-2.5">
            <p className="text-[10px] font-semibold tracking-[0.12em] text-muted-foreground/70 uppercase">
              Accounts
            </p>
            <ul className="mt-1.5 flex flex-col gap-1.5">
              {accounts.map((account) => (
                <li
                  key={account.id}
                  className="flex min-w-0 items-center gap-2 text-[11.5px] text-foreground/90"
                >
                  <span
                    aria-hidden="true"
                    className="size-1.5 shrink-0 rounded-full bg-success"
                  />
                  <span className="truncate" title={account.email}>
                    {account.email}
                  </span>
                </li>
              ))}
            </ul>
            <a
              href="/auth/google"
              className="mt-2 flex items-center gap-1.5 text-[11.5px] font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <Plus aria-hidden="true" className="size-3" />
              Add mailbox
            </a>
          </div>

          <div className="flex items-center gap-2.5 px-0.5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-[4px] bg-primary/15 text-[11px] font-semibold text-primary">
              {initialsOf(profile)}
            </span>
            <span className="min-w-0 flex-1 truncate text-[11.5px] text-foreground/80">
              {profile}
            </span>
            <Link
              to="/settings"
              aria-label="Settings"
              className="shrink-0 rounded-[4px] p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Settings aria-hidden="true" className="size-4" />
            </Link>
          </div>
        </div>
      </aside>

      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

/** One of the two top-level destinations. The design inverts the active one. */
function NavRow({
  active,
  onClick,
  icon,
  label,
  count,
}: {
  active: boolean
  onClick: () => void
  icon: ReactNode
  label: string
  count?: number
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex h-9 items-center gap-2.5 rounded-[4px] px-2.5 text-left',
        'text-[12.5px] tracking-[0.04em] uppercase transition-colors',
        'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        active
          ? 'bg-primary font-semibold text-primary-foreground'
          : 'font-medium text-foreground/90 hover:bg-muted/40',
      )}
    >
      {icon}
      <span className="flex-1">{label}</span>
      {typeof count === 'number' && count > 0 ? (
        <span
          className={cn(
            'text-[11px] font-semibold tabular-nums',
            active ? 'text-primary-foreground/70' : 'text-muted-foreground/70',
          )}
        >
          {count}
        </span>
      ) : null}
    </button>
  )
}
