const request = require('supertest');
const { ImapFlow } = require('imapflow');
const EmailService = require('../src/emailService');
const LocalMailServer = require('../src/localMailServer');
const { createServer } = require('../src/app');

describe('Fastmail live app with built-in mail servers', () => {
  let app;
  let service;
  let localMail;
  const now = new Date('2024-01-01T12:00:00Z');

  beforeEach(async () => {
    localMail = new LocalMailServer({ host: '127.0.0.1' });
    service = new EmailService({ clock: () => now, seedUsers: [], localMailServer: localMail });
    await service.ensureUser({ email: 'alice@fastmail.test', password: 'secret1', name: 'Alice' });
    await service.ensureUser({ email: 'bob@fastmail.test', password: 'secret2', name: 'Bob' });
    await service.ready();
    app = createServer(service);
  });

  afterEach(async () => {
    if (localMail) {
      await localMail.stop();
    }
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
        expect.objectContaining({ name: 'INBOX', total: 0 }),
        expect.objectContaining({ name: 'Sent', total: 0 }),
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
      status: 'read',
      mailbox: 'Sent',
      sentAt: now.toISOString(),
    });

    const sentMessages = await alice.get('/api/mailboxes/Sent/messages').expect(200);
    expect(sentMessages.body).toHaveLength(1);

    const bob = request.agent(app);
    await bob.post('/api/auth/login').send({ email: 'bob@fastmail.test', password: 'secret2' }).expect(200);

    const inboxMessages = await bob.get('/api/mailboxes/INBOX/messages').expect(200);
    expect(inboxMessages.body).toHaveLength(1);
    expect(inboxMessages.body[0]).toMatchObject({
      from: 'Alice <alice@fastmail.test>',
      to: 'bob@fastmail.test',
      subject: 'Hello',
      status: 'unread',
      mailbox: 'INBOX',
    });

    const messageId = inboxMessages.body[0].id;
    await bob.post(`/api/messages/${messageId}/read`).expect(200);

    const refreshed = await bob.get(`/api/messages/${messageId}`).expect(200);
    expect(refreshed.body.status).toBe('read');
  });

  test('exposes connection details for external clients', async () => {
    const agent = request.agent(app);
    const login = await agent
      .post('/api/auth/login')
      .send({ email: 'alice@fastmail.test', password: 'secret1' })
      .expect(200);

    expect(login.body.smtp).toEqual(
      expect.objectContaining({ host: expect.any(String), port: expect.any(Number) })
    );
    expect(login.body.imap).toEqual(
      expect.objectContaining({ host: expect.any(String), port: expect.any(Number), username: 'alice@fastmail.test' })
    );

    const sendResponse = await agent
      .post('/api/messages/send')
      .send({ to: 'bob@fastmail.test', subject: 'IMAP test', body: 'Check IMAP inbox.' })
      .expect(201);
    expect(sendResponse.body.subject).toBe('IMAP test');

    const bobImap = localMail.getUserImapConfig('bob@fastmail.test');
    const imapClient = new ImapFlow({
      host: bobImap.host,
      port: bobImap.port,
      secure: false,
      auth: { user: bobImap.auth.user, pass: 'secret2' },
    });
    await imapClient.connect();
    await imapClient.mailboxOpen('INBOX');
    const uids = await imapClient.search({ all: true });
    expect(uids.length).toBeGreaterThan(0);
    const lastUid = uids[uids.length - 1];
    const fetched = await imapClient.fetchOne(lastUid, { envelope: true });
    expect(fetched.envelope.subject).toBe('IMAP test');
    await imapClient.logout();
  });
});

describe('Fastmail live app with IMAP integration', () => {
  let app;
  let service;
  let transport;
  let imapState;
  const now = new Date('2024-04-01T09:00:00Z');

  beforeEach(async () => {
    transport = { sendMail: jest.fn().mockResolvedValue({ messageId: 'imap-stub' }) };
    imapState = createFakeImapState();
    const imapClientFactory = () => new FakeImapClient(imapState);
    service = new EmailService({
      clock: () => now,
      transport,
      seedUsers: [],
      imapClientFactory,
      imapDefaults: { host: 'imap.test', port: 993, secure: true },
    });
    await service.ensureUser({
      email: 'carol@fastmail.test',
      password: 'secret3',
      name: 'Carol',
      imap: {
        auth: { user: 'carol-imap', pass: 'imap-pass' },
      },
    });
    app = createServer(service);
  });

  test('lists, reads, and sends mail via IMAP-backed mailboxes', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ email: 'carol@fastmail.test', password: 'secret3' }).expect(200);

    const mailboxesResponse = await agent.get('/api/mailboxes').expect(200);
    expect(mailboxesResponse.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'INBOX', total: 1, unread: 1 }),
        expect.objectContaining({ name: 'Sent', total: 0 }),
      ])
    );

    const messagesResponse = await agent.get('/api/mailboxes/INBOX/messages').expect(200);
    expect(messagesResponse.body).toHaveLength(1);
    const inboxMessage = messagesResponse.body[0];
    expect(inboxMessage).toMatchObject({
      id: '101',
      subject: 'Hello from the outside',
      status: 'unread',
      mailbox: 'INBOX',
    });

    const fullMessage = await agent.get(`/api/messages/${inboxMessage.id}`).expect(200);
    expect(fullMessage.body.body).toContain('Checking in via IMAP');

    await agent.post(`/api/messages/${inboxMessage.id}/read`).send({}).expect(200);
    const afterRead = await agent.get('/api/mailboxes/INBOX/messages').expect(200);
    expect(afterRead.body[0].status).toBe('read');

    const sendResponse = await agent
      .post('/api/messages/send')
      .send({ to: 'remote@example.com', subject: 'Outbound', body: 'Testing append.' })
      .expect(201);

    expect(transport.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'Carol <carol@fastmail.test>',
        to: 'remote@example.com',
        subject: 'Outbound',
      })
    );

    expect(sendResponse.body).toMatchObject({ mailbox: 'Sent', status: 'read', subject: 'Outbound' });

    const sentMessages = await agent.get('/api/mailboxes/Sent/messages').expect(200);
    expect(sentMessages.body[0]).toMatchObject({ subject: 'Outbound', status: 'read' });
  });
});

function createFakeImapState() {
  return {
    lastUid: 150,
    mailboxes: {
      INBOX: [
        {
          uid: 101,
          envelope: {
            from: [{ name: 'Remote Friend', address: 'friend@example.com' }],
            to: [{ name: 'Carol', address: 'carol@fastmail.test' }],
            subject: 'Hello from the outside',
            date: new Date('2024-03-28T08:30:00Z'),
          },
          flags: [],
          internalDate: new Date('2024-03-28T08:30:00Z'),
          raw: buildTestRaw({
            from: 'Remote Friend <friend@example.com>',
            to: 'Carol <carol@fastmail.test>',
            subject: 'Hello from the outside',
            date: new Date('2024-03-28T08:30:00Z'),
            body: 'Checking in via IMAP!',
          }),
        },
      ],
      Sent: [],
    },
  };
}

class FakeImapClient {
  constructor(state) {
    this.state = state;
    this.currentMailbox = null;
  }

  async connect() {}

  async logout() {}

  async *list() {
    for (const [name, messages] of Object.entries(this.state.mailboxes)) {
      const flags = name === 'Sent' ? ['\\Sent'] : [];
      yield { path: name, flags, specialUse: flags };
    }
  }

  async status(path) {
    const mailbox = this.state.mailboxes[path] || [];
    const unseen = mailbox.filter((message) => !message.flags.includes('\\Seen')).length;
    return { messages: mailbox.length, unseen };
  }

  async mailboxOpen(path) {
    this.currentMailbox = path;
    const mailbox = this.state.mailboxes[path];
    if (!mailbox) {
      throw new Error('mailbox not found');
    }
    return { exists: mailbox.length };
  }

  async *fetch(range, query, options = {}) { // eslint-disable-line no-unused-vars
    const mailbox = this.state.mailboxes[this.currentMailbox];
    if (!mailbox) {
      return;
    }
    for (const message of mailbox) {
      yield {
        uid: message.uid,
        envelope: message.envelope,
        flags: message.flags,
        internalDate: message.internalDate,
      };
    }
  }

  async fetchOne(uid) {
    const mailbox = this.state.mailboxes[this.currentMailbox];
    if (!mailbox) {
      return null;
    }
    const message = mailbox.find((item) => item.uid === uid);
    if (!message) {
      return null;
    }
    return {
      uid: message.uid,
      envelope: message.envelope,
      flags: message.flags,
      internalDate: message.internalDate,
      source: Buffer.from(message.raw),
    };
  }

  async messageFlagsAdd(uid, flags) {
    const mailbox = this.state.mailboxes[this.currentMailbox];
    const message = mailbox.find((item) => item.uid === uid);
    if (!message) {
      return;
    }
    flags.forEach((flag) => {
      if (!message.flags.includes(flag)) {
        message.flags.push(flag);
      }
    });
  }

  async append(path, raw, flags) {
    const mailbox = this.state.mailboxes[path];
    if (!mailbox) {
      throw new Error('mailbox not found');
    }
    const uid = ++this.state.lastUid;
    mailbox.unshift({
      uid,
      envelope: {
        from: [{ address: extractHeader(raw, 'From') }],
        to: [{ address: extractHeader(raw, 'To') }],
        subject: extractHeader(raw, 'Subject'),
        date: new Date(),
      },
      flags: [...flags],
      internalDate: new Date(),
      raw,
    });
    return { uid };
  }
}

function buildTestRaw({ from, to, subject, date, body }) {
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${(date instanceof Date ? date : new Date(date)).toUTCString()}`,
    '',
    body,
  ].join('\r\n');
}

function extractHeader(raw, header) {
  const line = raw.split(/\r?\n/).find((entry) => entry.toLowerCase().startsWith(`${header.toLowerCase()}:`));
  if (!line) {
    return '';
  }
  return line.split(':').slice(1).join(':').trim();
}
