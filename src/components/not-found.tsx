import { Link } from '@tanstack/react-router'

/**
 * Shown for any URL that matches no route.
 *
 * Without this the router falls back to its own `<p>Not Found</p>`, which logs a
 * warning at startup and leaves the user on a dead page with no way back.
 */
export function NotFound() {
  return (
    <div className="mx-auto max-w-2xl p-8">
      <h1 className="text-3xl font-bold">Nothing here</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        That address does not match any conversation.
      </p>
      <Link
        to="/"
        className="mt-6 inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
      >
        Back to the inbox
      </Link>
    </div>
  )
}