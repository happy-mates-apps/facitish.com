# Beskeder — messages from the administration, replies, and (later) conversations

Messages from the people running an instance to its users, delivered in the app and, per recipient, on push, SMS
or e-mail; replies back to the administration; and in phase 2 conversations between users with moderation.

The design is the canvas *Beskeder i /admin* (Claude Design): the /admin screens Beskeder, Send besked, Svar,
Moderering, Levering and Kanaler og regler, plus an implementation board. It is ported from happy-groups'
`member-chat` (conversations, broadcasts in two steps, moderation), `member-push` (channels, quiet hours, delivery
log) and `member-sms` (SMS log, duplicates, hourly cap). Gær is one instance without groups, so group-scoped RLS
becomes admin roles and owner checks, Prisma becomes raw SQL, and NATS `notify.send` / `sms.send` become `app.jobs`.

## Decisions (11 November 2026)

1. **SMS needs its own yes.** A phone number used for SMS login is not consent to receive messages by SMS. The user
   turns SMS messages on themselves (`notification_prefs.sms`, default off; `sms_consent_at` records when, and the
   change is audited).
2. **Push on both `/` and `/m`.** The desktop browser and the phone, including the installed app; every device is its
   own subscription (phase 3).
3. **Moderators see the reported message and the three before it**, and only while the report is open; never the
   rest of a conversation. Each view is audited (phase 2).
4. **Recipients can reply to a broadcast.** Each reply opens (or continues) a private thread between that user and
   the administration, answered in /admin → Svar. The sender can switch replies off per broadcast.

## Phases

| Phase | What | Status |
| --- | --- | --- |
| 1 | Broadcasts with estimate and two-step confirmation; channels in-app, SMS, e-mail; quiet hours for SMS; SMS duplicates and hourly cap; in-app inbox on `/beskeder` and `/m/beskeder`; replies; delivery log; settings | built |
| 2 | Conversations between users (the instance conversation, direct), report and block, word filter, /admin → Moderering | to do |
| 3 | Web push with VAPID on `/` and `/m`, 404/410 turns a subscription off and falls back to SMS | to do |

## Model (phase 1, `server/app/migrations/0024_messages.sql`)

```
message_broadcasts   one send: title, body, audience (jsonb) + label, channels, urgent, allow_replies, the estimate
                     (total, push, sms, mail, app_only, segments, price_minor), actor, confirmation_hash (unique),
                     send_at, sent_at, status (scheduled | sending | sent)
message_deliveries   one per recipient and channel: app | push | sms | mail; status queued | held | sent | delivered
                     | read | failed | skipped | duplicate | throttled; the app row is the inbox entry (read_at)
notification_prefs   per user: sms (default false) + sms_consent_at, mail (default true)
sms_messages         every message SMS that went (or did not go) out: phone, body, segments, encoding, status,
                     attempts, error — kept 90 days
conversations        kind 'reply' (phase 2 adds 'instance' and 'direct'): broadcast_id + user_id unique,
                     last_message_at, closed_at
conversation_messages author_id (null once erased), from_admin, body, created_at
```

## Rules

- **Audiences**: `all`, `admins`, `ring` (feature level ≤ N, as in /admin/features), `inactive` (no login for N
  days), `users` (chosen ids, at most 500). Blocked users and impersonation test accounts are never recipients.
- **Channel per recipient** (phase 1, without push): SMS when the broadcast uses SMS, SMS is on in Kanaler og regler,
  the user said yes and has a phone; else e-mail when the broadcast uses e-mail, e-mail is on and the user has an
  address and has not switched it off; else only in the app. Everyone gets the in-app copy.
- **Two steps.** `POST /api/admin/messages/broadcast` without a token answers with the estimate and a confirmation
  token (HMAC over admin, digest of title, text, audience, channels, urgency, replies and send time; 10 minutes). The
  same call with the token sends; the token's hash is unique on the broadcast, so a second click is `409`.
  A broadcast to `all` needs a fresh second factor (step-up).
- **SMS**: GSM-7 / UCS-2 segment count (160/153, 70/67); the same text to the same number within the duplicate
  window (60 s) is `duplicate`; more than the hourly cap (500) is `throttled`; in quiet hours (22–07 by default,
  instance time zone) a non-urgent SMS waits until they end. Transient failures retry through the job's backoff.
- **E-mail** goes through `app.mail.send_mail` and `outbound_mail.record_sent(purpose="message")`, so Lettermint's
  delivery status shows up as it does for other mail.
- **Replies** are allowed while the broadcast allows them. An admin can close a thread; a new reply from the user opens
  it again. An admin reply notifies the user the same way (in-app always; SMS or e-mail by the same rules, never in
  quiet hours). Replying marks the broadcast read. Other recipients never see a thread.

## API

`/api/admin/messages` (each sub-path is its own /admin section, so admin roles can be split):

| Section | Role | Paths |
| --- | --- | --- |
| `/messages` Beskeder | support | `GET /overview` |
| `/messages/send` Send besked | support | `GET /broadcast/audiences`, `POST /broadcast/estimate`, `POST /broadcast`, `POST /broadcast/test`, `GET /broadcast/log` |
| `/messages/replies` Svar | support | `GET /replies`, `GET /replies/{id}`, `POST /replies/{id}`, `POST /replies/{id}/close` |
| `/messages/delivery` Levering | drift | `GET /deliveries` |
| `/messages/settings` Kanaler og regler | drift | `GET /settings`, `PUT /settings` |

`/api/messages` (the user): `GET /inbox`, `GET /unread`, `GET /inbox/{broadcast_id}`, `POST /inbox/{broadcast_id}/read`,
`POST /inbox/{broadcast_id}/reply`, `GET /prefs`, `PUT /prefs`.

Jobs: `messages.deliver` (fan-out of one broadcast), `messages.sms`, `messages.mail`, `messages.notify_reply`.
Events: `messages.broadcast`, `messages.reply`, `messages.sms` (ref = id). Webhooks: `message.broadcast.sent`,
`message.reply.created` (ids only). Audit: `messages.broadcast.send`, `messages.broadcast.test`,
`messages.reply`, `messages.reply.close`, `messages.prefs`, `messages.settings`.

## Personal data

Exported (`build_user_export`): inbox entries with title and text, deliveries, replies the user wrote and received,
preferences, SMS sent to them. Erased with the user (cascade): deliveries, preferences, reply threads, SMS rows.
Admin replies keep the text with `author_id = null` once the admin is erased; broadcasts keep `actor_id = null`.
Retention (`retention_policies`): `message_deliveries` 90 days, `sms_messages` 90 days.

## Phase 2 and 3 (not built)

- `conversations` gains kinds `instance` and `direct` (pair key), `conversation_members` (last_read_at,
  active_until), `message_reports`, `user_blocks`; word filter in settings; /admin → Moderering with dismiss and
  remove; webhooks `message.report.created` / `.reviewed`.
- `push_subscriptions` (endpoint, keys, device, status, last_seen_at), `notification_prefs.push` and quiet hours per
  user, VAPID keys from `WEB_PUSH_VAPID_*`, service workers in `web/public/` and `web/public/m/`, jobs
  `messages.push`, `messages.release_held`, `messages.expire_push`; SMS delivery receipts as an incoming webhook
  handler; kill switches `messages.sms` and `messages.broadcast`.
