const request = require('supertest');
const EmailService = require('../src/emailService');
const { createServer } = require('../src/app');

describe('Fastmail live app API', () => {
  let app;
  let service;
  const now = new Date('2024-01-01T12:00:00Z');

  beforeEach(() => {
    service = new EmailService(() => now);
    app = createServer(service);
  });

  test('creates a draft and exposes it via the drafts mailbox', async () => {
    const payload = {
      from: 'alice@example.com',
      to: 'bob@example.com',
      subject: 'Quarterly Update',
      body: 'Q1 numbers look strong.',
    };

    const response = await request(app).post('/api/drafts').send(payload);

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      from: payload.from,
      to: payload.to,
      subject: payload.subject,
      status: 'draft',
      mailbox: 'drafts',
    });

    const drafts = service.listMessages('drafts');
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ subject: payload.subject });
  });

  test('validates required fields when creating a draft', async () => {
    const response = await request(app).post('/api/drafts').send({ from: '', to: 'bob@example.com' });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/from is required/);
  });

  test('sends a draft and delivers a copy to the inbox', async () => {
    const payload = {
      from: 'carol@example.com',
      to: 'dave@example.com',
      subject: 'Team Social',
      body: 'Join us for coffee next Friday.',
    };

    const { body: draft } = await request(app).post('/api/drafts').send(payload).expect(201);

    const sendResponse = await request(app).post(`/api/drafts/${draft.id}/send`).expect(200);
    expect(sendResponse.body).toMatchObject({ status: 'sent', mailbox: 'sent', sentAt: now.toISOString() });

    const inboxResponse = await request(app).get('/api/mailboxes/inbox/messages').expect(200);
    expect(inboxResponse.body).toHaveLength(1);
    expect(inboxResponse.body[0]).toMatchObject({
      subject: payload.subject,
      mailbox: 'inbox',
      status: 'unread',
    });

    const markReadResponse = await request(app)
      .post(`/api/messages/${inboxResponse.body[0].id}/read`)
      .expect(200);
    expect(markReadResponse.body.status).toBe('read');
  });
});
