# Global staff notifications

## Goal

Make the staff notification inbox a dashboard-wide service instead of an
Anti-Fraud feature. The shared bell must work from Admin, Creator Hub, Pack
Studio, and Anti-Fraud. Admins and owners must be able to send a custom message
to selected active staff, a system role, or every active staff account.

## Product contract

- Staff notifications are separate from packy.gg customer notifications.
- Every staff account reads its own inbox through the shared header bell.
- `/system/staff-notifications` is the canonical inbox and management page.
- The old Anti-Fraud inbox redirects to the canonical page.
- Custom sends use the existing `announcement` staff-notification kind.
- In-app, Discord, and Telegram delivery follow each recipient's notification
  preferences. External delivery additionally requires a verified channel.
- Deactivated admin accounts are never targeted.
- A broadcast targets all active admin accounts, including people who have not
  opened Anti-Fraud and therefore do not have a `staff_profiles` row.
- Only admins and owners can compose. Every signed-in admin account can read its
  own inbox.
- Every custom send is recorded in the admin audit log.

## Delivery phases

1. Decouple the bell and broadcast recipient query from `/antifraud`.
2. Add the canonical System page, inbox, recipient overview, and composer.
3. Add System navigation and permission metadata.
4. Redirect the legacy Anti-Fraud notification page.
5. Verify lint, TypeScript, production build, and the page in a browser.

## Future support

- Add durable delivery-attempt rows if operators need per-channel delivery
  receipts; the current channel row only keeps the latest send/error.
- Add pagination when an account can exceed the current 50-item inbox window.
- Add scheduled announcements and expiry only after a queue/worker owns retry
  semantics.
- Add notification retention once product requirements define how long staff
  history must remain available.
