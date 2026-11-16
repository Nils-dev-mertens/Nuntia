/**
 * Person or service desk — the question a contact tag has to answer.
 *
 * A tag is an address-book label: what kind of person this is — client,
 * investor, family, the people at one company. That says nothing useful about a
 * department mailbox, so `support@`, `billing@` and `info@` are never filed
 * automatically. The desk stays in the inbox; it just does not get a label meant
 * for a person.
 *
 * Deliberately separate from `conversation/automated.ts`. That module answers
 * "is there a human in this thread?" for replyability and chat view, and has to
 * stay strict: a false positive hides a real person's mail. Here the cost is
 * inverted — labelling a desk as a person is the mistake, so role mailboxes are
 * exactly the case worth catching.
 *
 * One precision choice: only exact local parts and a short list of compound
 * desks match. No arbitrary prefix matching, because `sales.jane@` and
 * `info@jane.example` are real people, and the separator-flattened form would
 * otherwise file them as services.
 */

/**
 * Local parts that belong to a desk rather than to a person.
 *
 * `+tag` sub-addressing is stripped before matching, so `support+eu@` is the
 * support desk. Compounds are enumerated instead of prefix-matched, for the
 * reason in the module note.
 */
const SERVICE_LOCAL_PARTS = new Set([
  'support',
  'supportdesk',
  'support-team',
  'team-support',
  'help',
  'helpdesk',
  'help-desk',
  'service',
  'services',
  'servicedesk',
  'service-desk',
  'customercare',
  'customer-service',
  'customerservice',
  'info',
  'information',
  'sales',
  'sales-team',
  'team-sales',
  'marketing',
  'billing',
  'billing-team',
  'invoices',
  'invoice',
  'accounts',
  'accounting',
  'finance',
  'admin',
  'administration',
  'office',
  'frontdesk',
  'front-desk',
  'reception',
  'contact',
  'contacts',
  'hello',
  'hi',
  'team',
  'staff',
  'mail',
  'email',
  'enquiries',
  'enquiry',
  'inquiries',
  'inquiry',
  'orders',
  'order',
  'bookings',
  'booking',
  'reservations',
  'reservation',
  'complaints',
  'complaint',
  'feedback',
  'press',
  'media',
  'jobs',
  'job',
  'careers',
  'career',
  'recruiting',
  'recruitment',
  'hr',
  'people',
  'legal',
  'privacy',
  'security',
  'abuse',
  'webmaster',
  'postmaster',
  'newsletter',
  'newsletters',
  'news',
  'updates',
  'notification',
  'notifications',
  'noreply',
  'no-reply',
  'do-not-reply',
  'donotreply',
  'alerts',
  'alert',
  'delivery',
  'deliveries',
  'returns',
  'shipping',
  'general',
])

/**
 * Whether an address belongs to a service desk rather than to a person.
 *
 * Only the local part is read. The host says where someone works, not whether
 * they are a desk, and `jane@support.example` is a person at a support company.
 */
export function isServiceContact(email: string): boolean {
  const address = email.trim().toLowerCase()
  const at = address.lastIndexOf('@')
  if (at <= 0) return false

  const local = (address.slice(0, at).split('+')[0] ?? '')
    .replace(/[._]+/g, '-')
    .replace(/-+/g, '-')
  if (!local) return false

  return SERVICE_LOCAL_PARTS.has(local)
}
