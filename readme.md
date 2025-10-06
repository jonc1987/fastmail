# Fastmail Demo

A Node.js + Express demo application that lets you compose, send, and browse emails in-memory. It exposes a REST API and a simple web UI so you can try the workflows live without any external dependencies.

## Getting started

```bash
npm install
npm run dev
```

The server listens on [http://localhost:3000](http://localhost:3000). The SPA served at `/` consumes the same API used by the Jest tests.

### Available scripts

- `npm run dev` – start the development server with hot reload via nodemon.
- `npm start` – run the production Express server.
- `npm test` – execute the Jest and Supertest suite.

## API overview

| Method | Endpoint | Description |
| ------ | -------- | ----------- |
| `POST` | `/api/drafts` | Create a draft email. |
| `POST` | `/api/drafts/:id/send` | Send a draft and deliver it to the inbox. |
| `GET` | `/api/mailboxes` | List mailbox counts. |
| `GET` | `/api/mailboxes/:mailbox/messages` | Fetch messages for a mailbox. |
| `GET` | `/api/messages/:id` | Fetch a single message. |
| `POST` | `/api/messages/:id/read` | Mark a message as read. |

All data lives in-memory and resets whenever the process restarts.
