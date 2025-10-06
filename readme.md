# Fastmail Demo

A Node.js + Express demo application that behaves like a real email service. Users can sign in, send mail through an SMTP relay, and triage their inbox from the built-in single-page app.

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
| `SMTP_URL` | Connection string for the SMTP relay (e.g. `smtp://user:pass@smtp.mailgun.org:587`). If omitted, messages are captured in-memory for testing. |
| `SESSION_SECRET` | Secret used to sign Express session cookies. Defaults to `fastmail-secret` for local development. |
| `EMAIL_DOMAIN` | Optional default domain name advertised by the service. |
| `SEED_USERS` | JSON array of `{ email, password, name }` objects used to bootstrap accounts on startup. |

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

All data lives in-memory and resets whenever the process restarts. Messages addressed to other seeded users are delivered to their inboxes automatically. When `SMTP_URL` is configured those messages are also relayed to the external recipients, enabling end-to-end sending beyond the demo service.
