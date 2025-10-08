# Fastmail Demo

A Node.js + Express demo application that behaves like a real email service. Users can sign in, send mail through either the built-in SMTP relay or an external transport, and triage their inbox from the single-page app. When IMAP credentials are provided—or when the bundled IMAP server is enabled—the UI surfaces live mailbox state and message content instead of the in-memory demo data.

## Getting started

```bash
npm install
npm run dev
```

The server listens on [http://localhost:3000](http://localhost:3000). Open the UI and sign in with one of the seeded demo users:

- `demo@fastmail.test` / `demo-pass`
- `team@fastmail.test` / `team-pass`

You can override or extend these users by setting `SEED_USERS` (see below). Once authenticated you can compose emails, view mailboxes, and read messages from any device sharing the same server session.

### Available scripts

- `npm run dev` – start the development server with hot reload via nodemon.
- `npm start` – run the production Express server.
- `npm test` – execute the Jest and Supertest suite.

## Configuration

| Variable | Purpose |
| -------- | ------- |
| `SMTP_URL` | Connection string for an external SMTP relay (e.g. `smtp://user:pass@smtp.mailgun.org:587`). If omitted the built-in SMTP server is used. |
| `IMAP_HOST` / `IMAP_PORT` / `IMAP_SECURE` | Default IMAP host connection details. These values seed any users that do not declare their own host-specific overrides. |
| `IMAP_USER` / `IMAP_PASS` | Optional default credentials used for IMAP when a seeded user does not supply explicit authentication details. |
| `IMAP_SENT_MAILBOX` | Overrides the mailbox path used when archiving outbound mail (defaults to autodetecting the `\Sent` mailbox). |
| `IMAP_TLS_REJECT_UNAUTHORIZED` | Set to `false` to trust self-signed certificates when testing against local IMAP servers. |
| `SESSION_SECRET` | Secret used to sign Express session cookies. Defaults to `fastmail-secret` for local development. |
| `EMAIL_DOMAIN` | Optional default domain name advertised by the service. |
| `SEED_USERS` | JSON array of `{ email, password, name, imap? }` objects used to bootstrap accounts on startup. |
| `LOCAL_MAIL_SERVERS` | Set to `off` or `false` to disable the bundled SMTP/IMAP servers. Enabled by default. |

When configuring IMAP, each seeded user can override connection details by supplying an `imap` object:

```json
[
  {
    "email": "carol@example.com",
    "password": "demo-pass",
    "name": "Carol",
    "imap": {
      "host": "imap.example.com",
      "port": 993,
      "secure": true,
      "auth": { "user": "carol@example.com", "pass": "imap-password" },
      "sentMailbox": "Sent"
    }
  }
]
```

With IMAP enabled the API proxies mailbox listing, message retrieval, read-state updates, and sent-mail archiving to the remote server. Local in-memory delivery is skipped for users wired to IMAP so incoming mail must arrive through the external provider.

### Built-in SMTP/IMAP servers

By default the service now launches real SMTP and IMAP servers backed by the application’s in-memory message store. Each seeded user receives dedicated IMAP credentials, making it possible to connect a desktop or mobile email client directly to the demo environment:

- **SMTP** – available on `127.0.0.1` with an ephemeral high port announced in the server logs and returned by the `/api/me` endpoint. Authenticate using the same email address and password that you use for the web UI.
- **IMAP** – each user has a unique port; inspect the server logs or query `/api/me` after sign-in to discover the connection details. The default Sent mailbox is named `Sent`.

Disable these local transports by setting `LOCAL_MAIL_SERVERS=off` when you prefer to integrate with production mail infrastructure.

## API overview

| Method | Endpoint | Description |
| ------ | -------- | ----------- |
| `POST` | `/api/auth/login` | Authenticate a user session. |
| `POST` | `/api/auth/logout` | Destroy the current session. |
| `GET` | `/api/me` | Fetch the authenticated user's profile. |
| `GET` | `/api/mailboxes` | List mailbox counts for the signed-in user. |
| `GET` | `/api/mailboxes/:mailbox/messages` | Fetch messages from a specific mailbox. |
| `POST` | `/api/messages/send` | Send an email through SMTP and archive it in Sent. |
| `GET` | `/api/messages/:id` | Retrieve a single message. |
| `POST` | `/api/messages/:id/read` | Mark a message as read. |

All data lives in-memory for non-IMAP users and resets whenever the process restarts. Messages addressed to seeded in-memory users are delivered to their inboxes automatically. When `SMTP_URL` is configured those messages are also relayed to the external recipients, enabling end-to-end sending beyond the demo service. For IMAP-backed users, mailbox state and message content flows directly from the configured provider.
