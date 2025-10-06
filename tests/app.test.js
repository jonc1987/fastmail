const request = require('supertest');
const EmailService = require('../src/emailService');
const { createServer } = require('../src/app');

describe('Fastmail live app API with authentication and SMTP', () => {
  let app;
  let service;
  let transport;
  const now = new Date('2024-01-01T12:00:00Z');

  beforeEach(async () => {
    transport = { sendMail: jest.fn().mockResolvedValue({ messageId: 'stub' }) };
    service = new EmailService({ clock: () => now, transport, seedUsers: [] });
    await service.ensureUser({ email: 'alice@fastmail.test', password: 'secret1', name: 'Alice' });
    await service.ensureUser({ email: 'bob@fastmail.test', password: 'secret2', name: 'Bob' });
    app = createServer(service);
  });

  test('requires authentication', async () => {
    const response = await request(app).get('/api/mailboxes');
    expect(response.status).toBe(401);
    expect(response.body.error).toMatch(/authentication required/);
  });

  test('supports login, sending mail, and inbox delivery', async () => {
    const alice = request.agent(app);
    await alice.post('/api/auth/login').send({ email: 'alice@fastmail.test', password: 'secret1' }).expect(200);

    const mailboxesResponse = await alice.get('/api/mailboxes').expect(200);
    expect(mailboxesResponse.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'inbox', total: 0 }),
        expect.objectContaining({ name: 'sent', total: 0 }),
      ])
    );

    const sendResponse = await alice
      .post('/api/messages/send')
      .send({ to: 'bob@fastmail.test', subject: 'Hello', body: 'Testing real email.' })
      .expect(201);

    expect(sendResponse.body).toMatchObject({
      from: 'alice@fastmail.test',
      to: 'bob@fastmail.test',
      subject: 'Hello',
      status: 'sent',
      mailbox: 'sent',
      sentAt: now.toISOString(),
    });
    expect(transport.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'Alice <alice@fastmail.test>',
        to: 'bob@fastmail.test',
        subject: 'Hello',
        text: 'Testing real email.',
      })
    );

    const sentMessages = await alice.get('/api/mailboxes/sent/messages').expect(200);
    expect(sentMessages.body).toHaveLength(1);

    const bob = request.agent(app);
    await bob.post('/api/auth/login').send({ email: 'bob@fastmail.test', password: 'secret2' }).expect(200);

    const inboxMessages = await bob.get('/api/mailboxes/inbox/messages').expect(200);
    expect(inboxMessages.body).toHaveLength(1);
    expect(inboxMessages.body[0]).toMatchObject({
      from: 'alice@fastmail.test',
      to: 'bob@fastmail.test',
      subject: 'Hello',
      status: 'unread',
      mailbox: 'inbox',
    });

    const messageId = inboxMessages.body[0].id;
    await bob.post(`/api/messages/${messageId}/read`).expect(200);

    const refreshed = await bob.get(`/api/messages/${messageId}`).expect(200);
    expect(refreshed.body.status).toBe('read');
  });
});
