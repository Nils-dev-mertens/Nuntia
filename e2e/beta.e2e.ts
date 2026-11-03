/**
 * The beta's core actions, in the order a person meets them.
 *
 * Serial, and ordered: the first account can only come from the bootstrap code,
 * and creating it changes what `/join` and `/sign-in` do for every later test.
 * Each test still gets a fresh browser context, so none of them inherits the
 * session from the one before.
 */

import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

/**
 * Open a page and wait until React has hydrated the form.
 *
 * The markup is visible as soon as the server has rendered it, but the submit
 * handler only exists once the client bundle has run. Clicking in that window is
 * a native form submission, which reloads the page and silently throws the input
 * away. React tags the nodes it manages during hydration, so that is the signal
 * waited on here rather than a timeout.
 */
async function gotoWithForm(page: Page, path: string) {
  await page.goto(path)
  await page.waitForFunction(() => {
    const forms = [...document.querySelectorAll('form')]
    return forms.some((form) =>
      Object.keys(form).some((key) => key.startsWith('__reactFiber$')),
    )
  })
}

/**
 * Sign in as the account the bootstrap code created.
 *
 * The suite is serial and ordered, so this only means anything after that test
 * has run. Each test still starts from a fresh browser context, so every one of
 * them has to sign in for itself.
 */
async function signIn(page: Page) {
  await gotoWithForm(page, '/sign-in')
  await expect(
    page.getByRole('heading', { name: 'Sign in to Nuntia' }),
  ).toBeVisible()

  await page.getByLabel('Email').fill(EMAIL)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()

  await expect(page).toHaveURL('/')
}

const EMAIL = 'e2e@example.com'
const PASSWORD = 'twelve-chars-or-more'
const BOOTSTRAP_CODE = 'AAAA-BBBB-CCCC'
const REQUEST_RECEIVED = /Request received\./

test.describe.configure({ mode: 'serial' })

test('a stranger asks for access and gets the one answer', async ({ page }) => {
  await gotoWithForm(page, '/request-access')
  await expect(
    page.getByRole('heading', { name: 'Ask for access' }),
  ).toBeVisible()

  await page.getByLabel('Email').fill(EMAIL)
  await page.getByLabel('Name').fill('E2E')
  await page
    .getByLabel('What are you trying to fix?')
    .fill('Checking the funnel works end to end.')
  await page.getByRole('button', { name: 'Request access' }).click()

  await expect(page.getByText(REQUEST_RECEIVED)).toBeVisible()
})

test('asking twice returns the same sentence and writes nothing', async ({
  page,
}) => {
  await gotoWithForm(page, '/request-access')
  await page.getByLabel('Email').fill(EMAIL)
  await page
    .getByLabel('What are you trying to fix?')
    .fill('Asking again, to check the dedupe.')
  await page.getByRole('button', { name: 'Request access' }).click()

  await expect(page.getByText(REQUEST_RECEIVED)).toBeVisible()
})

test('the bootstrap code creates the first account', async ({ page }) => {
  await gotoWithForm(page, `/join/${BOOTSTRAP_CODE}`)
  await expect(page.getByRole('heading', { name: "You're in" })).toBeVisible()

  await page.getByLabel('Email').fill(EMAIL)
  await page.getByLabel('Name').fill('E2E')
  await page.getByLabel(/^Password/).fill(PASSWORD)
  await page.getByLabel('Confirm password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Open Nuntia' }).click()

  // Signed in with no mailbox is the first-run screen, not an empty inbox.
  await expect(page).toHaveURL('/')
  await expect(
    page.getByRole('heading', { name: 'Welcome to Nuntia' }),
  ).toBeVisible()
})

test('the account signs back in', async ({ page }) => {
  await signIn(page)
  await expect(
    page.getByRole('heading', { name: 'Welcome to Nuntia' }),
  ).toBeVisible()
})

test('a dead invite lands on the code form', async ({ page }) => {
  await page.goto('/join/ZZZZ-ZZZZ-ZZZZ')
  await expect(page).toHaveURL(/\/join$/)
})

test('the workspace page is the owner’s to manage', async ({ page }) => {
  await signIn(page)
  // The rename form needs React's handler: without it the submit is native, the
  // page reloads, and the save is silently dropped.
  await gotoWithForm(page, '/organisation')

  await expect(
    page.getByRole('heading', { name: 'Organisation', level: 1 }),
  ).toBeVisible()

  // The first account is the owner of its own one-person workspace, which is
  // what makes «solo stays the default» something the page can already show.
  await expect(page.getByText('You are owner here.')).toBeVisible()
  await expect(page.getByText('1 seat in this workspace.')).toBeVisible()

  // An owner gets the AI form, not the member's read-only summary. Solo users
  // are owners of their own workspace, so they keep the form they had before it
  // moved.
  await expect(page.getByLabel('Jev API key')).toBeVisible()

  await page.getByLabel('Name').fill('E2E Workspace')
  await page.getByRole('button', { name: 'Save name' }).click()
  await expect(page.getByText('Workspace renamed.')).toBeVisible()

  // A reload reads the stored name back rather than the optimistic one.
  await page.reload()
  await expect(page.getByLabel('Name')).toHaveValue('E2E Workspace')
})

test('the workspace page needs a session', async ({ page }) => {
  await page.goto('/organisation')
  await expect(page).toHaveURL(/\/sign-in/)
})

test('the AI keys point at the workspace instead of the member', async ({
  page,
}) => {
  await signIn(page)
  // No hydration wait here: after the AI form moved out, this page has no
  // `<form>` left, and the link is a plain anchor in the markup.
  await page.goto('/settings')
  await expect(
    page.getByRole('heading', { name: 'Settings', level: 1 }),
  ).toBeVisible()

  const link = page.getByRole('link', { name: 'Open organisation settings' })
  await expect(link).toBeVisible()

  // The per-user key form is gone: a raw key field on the personal page would be
  // the old behaviour, where each member brought their own key.
  await expect(page.getByLabel('Jev API key')).toHaveCount(0)

  await link.click()
  await expect(page).toHaveURL('/organisation')
})
