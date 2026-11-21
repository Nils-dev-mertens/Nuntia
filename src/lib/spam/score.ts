/**
 * The deterministic half of spam detection.
 *
 * Gmail already runs a spam filter, and this does not try to replace it: it is
 * the layer that can explain itself and that learns from what the user says. The
 * scorer is deliberately conservative. A single trigger phrase is weak evidence
 * — plenty of real invoices say "final notice" — so `judgeSpam` requires more
 * than one independent signal before it calls something spam.
 *
 * Pure on purpose: every signal here is a rule that can be tested without a
 * database or a mailbox.
 */

export type SpamInput = {
  from: string
  fromName?: string | null
  subject: string
  body: string
}

export type SpamSignal = {
  /** Stable name, used by tests and by the reason line. */
  code: string
  weight: number
  reason: string
}

/** Phrasing that appears far more often in bulk/phishing mail than in letters. */
const PHRASES: Array<{ pattern: RegExp; weight: number; reason: string }> = [
  {
    pattern:
      /verify (your|the) account|account (has been|is) (suspended|locked|limited)/i,
    weight: 30,
    reason: 'asks the reader to verify or unlock an account',
  },
  {
    pattern: /confirm (your )?(identity|password|account details)/i,
    weight: 25,
    reason: 'asks for identity confirmation',
  },
  {
    pattern: /unusual (sign[- ]?in|activity|login)/i,
    weight: 20,
    reason: 'claims unusual activity',
  },
  {
    pattern:
      /you(?:'ve| have) won|claim (your|the) prize|lottery (winner|winning)/i,
    weight: 30,
    reason: 'promises a prize',
  },
  {
    pattern: /claim your (refund|winnings|reward|compensation)/i,
    weight: 25,
    reason: 'promises an unclaimed reward',
  },
  {
    pattern:
      /gift card|wire transfer|bitcoin|crypto ?(wallet|currency)|western union/i,
    weight: 25,
    reason: 'asks for payment through an untraceable route',
  },
  {
    pattern:
      /password (will )?expire[sd]?|update your payment (method|details)/i,
    weight: 20,
    reason: 'pressures the reader about account credentials or payment',
  },
  {
    pattern: /click (here|below) to (verify|confirm|unlock|restore)/i,
    weight: 20,
    reason: 'asks the reader to click a verification link',
  },
  {
    pattern: /final (notice|warning)|urgent action (required|needed)/i,
    weight: 15,
    reason: 'uses urgency to force a reaction',
  },
]

/** Free mail domains a company writing "officially" almost never uses. */
const FREE_MAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'yahoo.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'mail.ru',
])

/** Brands phishers like to borrow in the display name. */
const IMPERSONATED_BRANDS = [
  'paypal',
  'apple',
  'amazon',
  'microsoft',
  'google',
  'netflix',
  'dhl',
  'fedex',
  'ups',
  'bank',
  'coinbase',
  'binance',
]

/** TLDs with a very high abuse rate relative to legitimate mail. */
const SUSPICIOUS_TLDS = [
  '.zip',
  '.mov',
  '.top',
  '.xyz',
  '.click',
  '.link',
  '.loan',
  '.work',
  '.gq',
  '.tk',
  '.ml',
  '.cf',
  '.ga',
]

export function domainOf(address: string): string {
  const at = address.lastIndexOf('@')
  return at === -1
    ? ''
    : address
        .slice(at + 1)
        .trim()
        .toLowerCase()
}

export function localPartOf(address: string): string {
  const at = address.lastIndexOf('@')
  return at === -1
    ? address.trim().toLowerCase()
    : address.slice(0, at).trim().toLowerCase()
}

/**
 * Every signal one message raises.
 *
 * More than the score matters: two unrelated weak signals are stronger evidence
 * than one strong phrase, which is what `judgeSpam` uses to decide.
 */
export function spamSignals(input: SpamInput): SpamSignal[] {
  const signals: SpamSignal[] = []
  const subject = input.subject
  const body = input.body
  const text = `${subject}\n${body}`
  const domain = domainOf(input.from)
  const name = input.fromName?.trim().toLowerCase() ?? ''

  for (const phrase of PHRASES) {
    if (phrase.pattern.test(text)) {
      signals.push({
        code: `phrase:${phrase.reason}`,
        weight: phrase.weight,
        reason: phrase.reason,
      })
    }
  }

  // A subject shouted in capitals is a bulk-mail habit, not proof: the small
  // weight is the point, and it can only matter beside something else.
  const letters = subject.replace(/[^A-Za-z]/g, '')
  if (
    letters.length >= 12 &&
    letters === letters.toUpperCase() &&
    /!/.test(subject)
  ) {
    signals.push({
      code: 'shouting-subject',
      weight: 15,
      reason: 'the subject is shouted in capitals',
    })
  }

  // Punycode hides what an address actually says. Legitimate senders sometimes
  // use it, so this stays a strong-but-not-final signal.
  if (domain.startsWith('xn--') || domain.includes('.xn--')) {
    signals.push({
      code: 'punycode-domain',
      weight: 40,
      reason: 'the sender domain is punycode-encoded',
    })
  }

  if (SUSPICIOUS_TLDS.some((tld) => domain.endsWith(tld))) {
    signals.push({
      code: 'suspicious-tld',
      weight: 20,
      reason: 'the sender domain uses a high-abuse TLD',
    })
  }

  // "PayPal" writing from anything that does not contain "paypal" is the oldest
  // phishing tell there is. The brand check only looks at the display name, so
  // a person called "Amazon Smith" on gmail.com would trip it — the second
  // signal requirement is what keeps that from being enough on its own.
  if (name) {
    const brand = IMPERSONATED_BRANDS.find((candidate) =>
      name.includes(candidate),
    )
    if (brand && !domain.includes(brand)) {
      signals.push({
        code: `impersonated-brand:${brand}`,
        weight: 30,
        reason: `the display name claims ${brand} but the address does not`,
      })
    }

    if (
      /(support|security|billing|service|admin)/.test(name) &&
      FREE_MAIL_DOMAINS.has(domain)
    ) {
      signals.push({
        code: 'official-name-free-mail',
        weight: 20,
        reason: 'an official-sounding name writes from a free mail domain',
      })
    }
  }

  // "no-reply" senders are normal; a *human-sounding* local part on a free mail
  // address is not a signal by itself. Deliberately nothing here: the local part
  // alone produced too many false positives on real people.

  return signals
}

export function spamScore(input: SpamInput): number {
  return spamSignals(input).reduce((total, signal) => total + signal.weight, 0)
}

/** Score at or above this, with at least two signals, is spam. */
export const SPAM_SCORE_THRESHOLD = 60

export type SpamVerdict = {
  spam: boolean
  /** One line per reason, for a tooltip or the Spam view. */
  reasons: string[]
  score: number
}

/**
 * Combine the heuristic with what the user and their rules have taught.
 *
 * A rule or a learned spam sender is decisive on its own; the heuristic needs
 * both enough weight and two independent signals. `learnedSender` is a boolean
 * rather than the address so the caller can keep its lookup in the repository
 * layer.
 */
export function judgeSpam(
  input: SpamInput,
  opts: { ruleReasons?: string[]; learnedSender?: boolean } = {},
): SpamVerdict {
  const signals = spamSignals(input)
  const reasons = [
    ...(opts.learnedSender ? ['you marked this sender as spam'] : []),
    ...(opts.ruleReasons ?? []),
    ...signals.map((signal) => signal.reason),
  ]
  const score = signals.reduce((total, signal) => total + signal.weight, 0)

  if (opts.learnedSender || (opts.ruleReasons?.length ?? 0) > 0) {
    return { spam: true, reasons, score: 100 }
  }

  return {
    spam: signals.length >= 2 && score >= SPAM_SCORE_THRESHOLD,
    reasons,
    score,
  }
}
