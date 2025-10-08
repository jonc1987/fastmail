const { randomUUID } = require('crypto');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const addressParser = require('nodemailer/lib/addressparser');
const validator = require('validator');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const DEFAULT_MAILBOXES = ['inbox', 'sent', 'archive'];

function defaultTransportOptions() {
  if (process.env.SMTP_URL) {
    return process.env.SMTP_URL;
  }

  return {
    streamTransport: true,
    buffer: true,
    newline: 'unix',
  };
}

class EmailService {
  constructor(options = {}) {
    this.clock = options.clock || (() => new Date());
    this.domain = options.domain || process.env.EMAIL_DOMAIN || 'fastmail.test';
    this.localMailServer = options.localMailServer || null;
    this.transport = options.transport || null;
    this.initializationPromises = [];

    if (this.localMailServer) {
      const startPromise = this.localMailServer.start().then(() => {
        if (!this.transport) {
          this.transport = nodemailer.createTransport(this.localMailServer.transportOptions());
        }
      });
      this.initializationPromises.push(startPromise);
    }

    if (!this.transport && !this.localMailServer) {
      this.transport = nodemailer.createTransport(options.transportOptions || defaultTransportOptions());
    }
    this.users = new Map();
    this.userIndex = new Map();
    this.mailboxes = new Map();
    this.messages = new Map();

    const imapDefaultOverrides = { ...(options.imapDefaults || {}) };
    if (this.localMailServer) {
      Object.assign(imapDefaultOverrides, this.localMailServer.imapDefaults());
    }
    this.imapDefaults = normalizeImapDefaults(imapDefaultOverrides);
    this.imapClientFactory = options.imapClientFactory || ((config) => new ImapFlow(config));
    this.sentMailboxCache = new Map();

    const seeds = options.seedUsers || parseSeedUsers();
    if (Array.isArray(seeds)) {
      this.seedPromises = seeds.map((user) => this.ensureUser(user));
    } else {
      this.seedPromises = [];
    }
  }

  async ready() {
    const tasks = [...(this.initializationPromises || []), ...(this.seedPromises || [])];
    await Promise.all(tasks);
  }

  async ensureUser({ email, password, name, imap }) {
    const normalizedEmail = this._normalizeEmail(email);
    if (!normalizedEmail || !validator.isEmail(normalizedEmail)) {
      throw new Error('valid email is required');
    }
    if (!password || password.length < 6) {
      throw new Error('password must be at least 6 characters');
    }

    const displayName = name || normalizedEmail.split('@')[0];
    const existing = this.users.get(normalizedEmail);
    const passwordHash = await bcrypt.hash(password, 10);
    const localImap = this.localMailServer ? await this.localMailServer.upsertUser({ email: normalizedEmail, password }) : null;
    const imapSource = typeof imap !== 'undefined' ? imap : localImap;
    const imapConfig = normalizeUserImap(imapSource, existing?.imap);
    const usesLocalMailServer = Boolean(this.localMailServer && typeof imap === 'undefined');

    if (existing) {
      existing.passwordHash = passwordHash;
      existing.name = displayName;
      existing.imap = imapConfig;
      existing.usesLocalMailServer = usesLocalMailServer;
      if (this.localMailServer && usesLocalMailServer) {
        existing.localPassword = password;
      } else if (!usesLocalMailServer) {
        existing.localPassword = undefined;
      }
      return this._publicUser(existing);
    }

    const id = randomUUID();
    const record = {
      id,
      email: normalizedEmail,
      name: displayName,
      passwordHash,
      imap: imapConfig,
      usesLocalMailServer,
      localPassword: this.localMailServer && usesLocalMailServer ? password : undefined,
    };

    this.users.set(normalizedEmail, record);
    this.userIndex.set(id, record);
    this._initMailboxes(id);

    return this._publicUser(record);
  }

  async authenticate(email, password) {
    const normalizedEmail = this._normalizeEmail(email);
    const record = this.users.get(normalizedEmail);
    if (!record) {
      return null;
    }

    const matches = await bcrypt.compare(password, record.passwordHash);
    if (!matches) {
      return null;
    }

    return this._publicUser(record);
  }

  getProfile(userId) {
    const record = this._getUserRecord(userId);
    return this._publicUser(record);
  }

  _getUserRecord(userId) {
    const record = this.userIndex.get(userId);
    if (!record) {
      throw new Error('user not found');
    }
    return record;
  }

  async listMailboxes(userId) {
    const user = this._getUserRecord(userId);
    if (this.localMailServer && user.usesLocalMailServer) {
      const mailboxes = this.localMailServer.listMailboxes(user.email) || [];
      mailboxes.sort(
        (a, b) => mailboxPriority(a.name) - mailboxPriority(b.name) || a.name.localeCompare(b.name)
      );
      return mailboxes;
    }
    const imapConfig = this._imapConfigFor(user);
    if (imapConfig) {
      return this._listImapMailboxes(user);
    }

    const boxes = this._mailboxMap(userId);
    return Array.from(boxes.entries()).map(([name, messages]) => ({
      name,
      total: messages.length,
      unread: messages.filter((message) => message.status === 'unread').length,
    }));
  }

  async listMessages(userId, mailbox) {
    const user = this._getUserRecord(userId);
    const imapConfig = this._imapConfigFor(user);
    if (imapConfig) {
      return this._listImapMessages(user, mailbox);
    }

    const boxes = this._mailboxMap(userId);
    const messages = boxes.get(mailbox);
    if (!messages) {
      throw new Error(`mailbox not found: ${mailbox}`);
    }
    return messages;
  }

  async getMessage(userId, messageId) {
    const user = this._getUserRecord(userId);
    const imapConfig = this._imapConfigFor(user);
    if (imapConfig) {
      return this._getImapMessage(user, messageId);
    }

    const messages = this.messages.get(userId);
    if (!messages || !messages.has(messageId)) {
      throw new Error('message not found');
    }
    return messages.get(messageId);
  }

  async markRead(userId, messageId) {
    const user = this._getUserRecord(userId);
    const imapConfig = this._imapConfigFor(user);
    if (imapConfig) {
      return this._markImapRead(user, messageId);
    }

    const message = await this.getMessage(userId, messageId);
    const timestamp = this.clock().toISOString();
    const updated = { ...message, status: 'read', updatedAt: timestamp };

    const boxes = this._mailboxMap(userId);
    const mailbox = boxes.get(message.mailbox);
    if (!mailbox) {
      throw new Error('mailbox not found');
    }
    const index = mailbox.findIndex((item) => item.id === messageId);
    if (index >= 0) {
      mailbox.splice(index, 1, updated);
    }
    this.messages.get(userId).set(messageId, updated);
    return updated;
  }

  async _listImapMailboxes(user) {
    return this._withImap(user, async (client, config) => {
      const results = [];
      for await (const mailbox of client.list()) {
        if (hasFlag(mailbox.flags, '\\Noselect')) {
          continue;
        }
        const status = await client
          .status(mailbox.path, { unseen: true, messages: true })
          .catch(() => ({ unseen: 0, messages: 0 }));
        results.push({
          name: mailbox.path,
          total: status.messages || 0,
          unread: status.unseen || 0,
        });
      }
      results.sort((a, b) => mailboxPriority(a.name) - mailboxPriority(b.name) || a.name.localeCompare(b.name));
      return results;
    });
  }

  async _listImapMessages(user, mailbox) {
    return this._withImap(user, async (client) => {
      const opened = await client.mailboxOpen(mailbox);
      if (!opened || !opened.exists) {
        return [];
      }
      const startSeq = Math.max(1, opened.exists - 49);
      const range = `${startSeq}:*`;
      const results = [];
      for await (const message of client.fetch(range, { envelope: true, flags: true, internalDate: true }, { uid: true })) {
        const dto = this._imapMessageToDto(mailbox, message);
        this._cacheMessage(user.id, dto);
        results.push(dto);
      }
      results.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      return results;
    });
  }

  async _getImapMessage(user, messageId) {
    const cached = this._getCachedMessage(user.id, messageId);
    if (!cached) {
      throw new Error('message not found');
    }

    if (cached.body && cached.body.length) {
      return cached;
    }

    return this._withImap(user, async (client) => {
      await client.mailboxOpen(cached.mailbox);
      const fetched = await client.fetchOne(
        Number(messageId),
        {
          envelope: true,
          flags: true,
          internalDate: true,
          source: true,
        },
        { uid: true }
      );
      if (!fetched) {
        throw new Error('message not found');
      }

      const buffer = await streamToBuffer(fetched.source);
      const parsed = await simpleParser(buffer);
      const updated = {
        ...cached,
        from: formatAddressList(fetched.envelope?.from) || cached.from,
        to: formatAddressList(fetched.envelope?.to) || cached.to,
        subject: fetched.envelope?.subject || cached.subject,
        body: parsed.text || parsed.html || '',
        status: hasSeenFlag(fetched.flags) ? 'read' : 'unread',
        updatedAt: (fetched.internalDate || fetched.envelope?.date || this.clock()).toISOString(),
      };
      this._cacheMessage(user.id, updated);
      return updated;
    });
  }

  async _markImapRead(user, messageId) {
    const cached = this._getCachedMessage(user.id, messageId);
    if (!cached) {
      throw new Error('message not found');
    }
    const timestamp = this.clock().toISOString();

    await this._withImap(user, async (client) => {
      await client.mailboxOpen(cached.mailbox);
      await client.messageFlagsAdd(Number(messageId), ['\\Seen'], { uid: true });
    });

    const updated = { ...cached, status: 'read', updatedAt: timestamp };
    this._cacheMessage(user.id, updated);
    return updated;
  }

  async _appendSentViaImap(user, message, imapConfig) {
    let stored = { ...message, status: 'read' };
    await this._withImap(user, async (client, config) => {
      const sentMailbox = await this._resolveSentMailbox(client, imapConfig, user.id);
      const raw = buildRawMessage({
        from: `${user.name} <${user.email}>`,
        to: message.to,
        subject: message.subject,
        date: new Date(message.sentAt),
        body: message.body,
      });
      const appendResult = await client.append(sentMailbox, raw, ['\\Seen'], new Date(message.sentAt));
      const id = appendResult && appendResult.uid ? String(appendResult.uid) : message.id;
      stored = {
        ...message,
        id,
        mailbox: sentMailbox,
        status: 'read',
        createdAt: message.sentAt,
        updatedAt: message.sentAt,
      };
      this._cacheMessage(user.id, stored);
    });
    return stored;
  }

  async _resolveSentMailbox(client, imapConfig, userId) {
    if (imapConfig.sentMailbox) {
      this.sentMailboxCache.set(userId, imapConfig.sentMailbox);
      return imapConfig.sentMailbox;
    }

    if (this.sentMailboxCache.has(userId)) {
      return this.sentMailboxCache.get(userId);
    }

    for await (const mailbox of client.list()) {
      const specialUse = toArray(mailbox.specialUse);
      if (specialUse.some((flag) => flag && flag.toLowerCase() === '\\sent')) {
        this.sentMailboxCache.set(userId, mailbox.path);
        return mailbox.path;
      }
      const lower = mailbox.path.toLowerCase();
      if (lower === 'sent' || lower === 'sent items' || lower === 'sent messages') {
        this.sentMailboxCache.set(userId, mailbox.path);
        return mailbox.path;
      }
    }

    const fallback = 'Sent';
    this.sentMailboxCache.set(userId, fallback);
    return fallback;
  }

  _imapMessageToDto(mailbox, message) {
    const internalDate = message.internalDate ? new Date(message.internalDate) : null;
    const envelopeDate = message.envelope?.date ? new Date(message.envelope.date) : null;
    const created = internalDate || envelopeDate || this.clock();
    return {
      id: message.uid ? String(message.uid) : randomUUID(),
      from: formatAddressList(message.envelope?.from),
      to: formatAddressList(message.envelope?.to),
      subject: message.envelope?.subject || '(no subject)',
      body: '',
      status: hasSeenFlag(message.flags) ? 'read' : 'unread',
      mailbox,
      createdAt: created.toISOString(),
      updatedAt: created.toISOString(),
    };
  }

  _imapConfigFor(user) {
    return buildImapConfig(this.imapDefaults, user);
  }

  _withImap(user, handler) {
    const imapConfig = this._imapConfigFor(user);
    if (!imapConfig) {
      throw new Error('imap not configured');
    }
    const client = this.imapClientFactory(imapConfig.client);
    return (async () => {
      try {
        if (typeof client.connect === 'function') {
          await client.connect();
        }
        return await handler(client, imapConfig);
      } finally {
        try {
          if (typeof client.logout === 'function') {
            await client.logout();
          } else if (typeof client.close === 'function') {
            await client.close();
          }
        } catch (error) {
          // eslint-disable-next-line no-console
          console.warn('imap disconnect failed', error.message);
        }
      }
    })();
  }

  _cacheMessage(userId, message) {
    if (!this.messages.has(userId)) {
      this.messages.set(userId, new Map());
    }
    this.messages.get(userId).set(message.id, message);
  }

  _getCachedMessage(userId, messageId) {
    const messages = this.messages.get(userId);
    if (!messages) {
      return null;
    }
    return messages.get(messageId) || null;
  }

  async sendMessage(userId, payload = {}) {
    const user = this._getUserRecord(userId);

    const { to, subject, body } = payload;
    if (!to || !to.trim()) {
      throw new Error('to is required');
    }
    if (!subject || !subject.trim()) {
      throw new Error('subject is required');
    }

    const timestamp = this.clock().toISOString();
    const formattedRecipients = this._normalizeRecipientList(to);
    let message = {
      id: randomUUID(),
      from: user.email,
      to: formattedRecipients,
      subject: subject.trim(),
      body: body || '',
      status: 'sent',
      mailbox: 'sent',
      createdAt: timestamp,
      updatedAt: timestamp,
      sentAt: timestamp,
    };

    const mailOptions = {
      from: `${user.name} <${user.email}>`,
      to: formattedRecipients,
      subject: message.subject,
      text: message.body,
    };
    if (this.localMailServer && user.usesLocalMailServer) {
      if (!user.localPassword) {
        throw new Error('local mail credentials unavailable');
      }
      mailOptions.auth = { user: user.email, pass: user.localPassword };
    }

    await this.transport.sendMail(mailOptions);

    const imapConfig = this._imapConfigFor(user);
    if (imapConfig) {
      message = await this._appendSentViaImap(user, message, imapConfig);
    } else {
      this._storeMessage(userId, message);
    }

    if (!this.localMailServer) {
      this._deliverInternalRecipients({ ...message, ownerId: userId });
    }

    return message;
  }

  _deliverInternalRecipients(message) {
    const recipients = this._parseAddresses(message.to);
    recipients.forEach((recipient) => {
      const user = this.users.get(recipient.address);
      if (!user) {
        return;
      }
      if (this._imapConfigFor(user)) {
        return;
      }
      const timestamp = this.clock().toISOString();
      const inboxMessage = {
        id: randomUUID(),
        from: message.from,
        to: recipient.address,
        subject: message.subject,
        body: message.body,
        status: 'unread',
        mailbox: 'inbox',
        createdAt: timestamp,
        updatedAt: timestamp,
        receivedAt: timestamp,
      };
      this._storeMessage(user.id, inboxMessage);
    });
  }

  _storeMessage(userId, message) {
    const boxes = this._mailboxMap(userId);
    const mailbox = boxes.get(message.mailbox);
    if (!mailbox) {
      throw new Error(`mailbox not found: ${message.mailbox}`);
    }
    mailbox.unshift(message);

    if (!this.messages.has(userId)) {
      this.messages.set(userId, new Map());
    }
    this.messages.get(userId).set(message.id, message);
  }

  _mailboxMap(userId) {
    const boxes = this.mailboxes.get(userId);
    if (!boxes) {
      throw new Error('user not found');
    }
    return boxes;
  }

  _initMailboxes(userId) {
    const boxes = new Map();
    DEFAULT_MAILBOXES.forEach((name) => boxes.set(name, []));
    this.mailboxes.set(userId, boxes);
    this.messages.set(userId, new Map());
  }

  _publicUser(record) {
    const user = { id: record.id, email: record.email, name: record.name };
    if (this.localMailServer) {
      const imap = this.localMailServer.getUserImapConfig(record.email);
      if (imap) {
        user.imap = {
          host: imap.host,
          port: imap.port,
          secure: !!imap.secure,
          username: (imap.auth && imap.auth.user) || record.email,
          sentMailbox: imap.sentMailbox || null,
        };
      }
      const smtp = this._publicSmtpConfig();
      if (smtp) {
        user.smtp = smtp;
      }
    }
    return user;
  }

  _publicSmtpConfig() {
    if (!this.localMailServer || !this.localMailServer.smtpAddress) {
      return null;
    }
    const { host, port } = this.localMailServer.smtpAddress;
    return {
      host: host || this.localMailServer.host,
      port,
      secure: false,
    };
  }

  _normalizeEmail(email = '') {
    return email.trim().toLowerCase();
  }

  _normalizeRecipientList(value) {
    const recipients = this._parseAddresses(value);
    if (!recipients.length) {
      throw new Error('to must include at least one valid email address');
    }
    return recipients.map((recipient) => recipient.formatted).join(', ');
  }

  _parseAddresses(value) {
    return addressParser(value || '')
      .map((item) => ({
        address: item.address ? item.address.trim().toLowerCase() : '',
        formatted: item.name ? `${item.name} <${item.address}>` : item.address,
      }))
      .filter((item) => item.address && validator.isEmail(item.address));
  }
}

function parseSeedUsers() {
  if (!process.env.SEED_USERS) {
    return [
      { email: 'demo@fastmail.test', password: 'demo-pass', name: 'Demo User' },
      { email: 'team@fastmail.test', password: 'team-pass', name: 'Team Inbox' },
    ];
  }

  try {
    const parsed = JSON.parse(process.env.SEED_USERS);
    if (!Array.isArray(parsed)) {
      throw new Error('SEED_USERS must be an array');
    }
    return parsed;
  } catch (error) {
    throw new Error(`Unable to parse SEED_USERS: ${error.message}`);
  }
}

module.exports = EmailService;

function normalizeImapDefaults(overrides = {}) {
  const defaults = {};
  const host = overrides.host || process.env.IMAP_HOST;
  if (host) {
    defaults.host = host;
  }

  const port = overrides.port ?? process.env.IMAP_PORT;
  if (port !== undefined && port !== null && port !== '') {
    defaults.port = Number(port);
  }

  if (overrides.secure !== undefined) {
    defaults.secure = Boolean(overrides.secure);
  } else if (process.env.IMAP_SECURE !== undefined) {
    const parsedSecure = parseBoolean(process.env.IMAP_SECURE);
    if (parsedSecure !== undefined) {
      defaults.secure = parsedSecure;
    }
  }

  const auth = { ...(overrides.auth || {}) };
  if (!auth.user && process.env.IMAP_USER) {
    auth.user = process.env.IMAP_USER;
  }
  if (!auth.pass && process.env.IMAP_PASS) {
    auth.pass = process.env.IMAP_PASS;
  }
  if (Object.keys(auth).length) {
    defaults.auth = auth;
  }

  const tls = { ...(overrides.tls || {}) };
  const tlsReject = process.env.IMAP_TLS_REJECT_UNAUTHORIZED;
  if (tlsReject !== undefined && tlsReject !== null) {
    const parsed = parseBoolean(tlsReject);
    if (parsed !== undefined) {
      tls.rejectUnauthorized = parsed;
    }
  }
  if (Object.keys(tls).length) {
    defaults.tls = tls;
  }

  const sentMailbox = overrides.sentMailbox || process.env.IMAP_SENT_MAILBOX;
  if (sentMailbox) {
    defaults.sentMailbox = sentMailbox;
  }

  return defaults;
}

function buildImapConfig(defaults, user) {
  const userImap = cloneImapConfig(user.imap);
  const host = (userImap && userImap.host) || defaults.host;
  if (!host) {
    return null;
  }

  const authUser = (userImap && userImap.auth && userImap.auth.user) || (defaults.auth && defaults.auth.user) || user.email;
  const authPass = (userImap && userImap.auth && userImap.auth.pass) || (defaults.auth && defaults.auth.pass);
  if (!authUser || !authPass) {
    return null;
  }

  const port = userImap && userImap.port !== undefined ? userImap.port : defaults.port;
  const secure = userImap && userImap.secure !== undefined ? userImap.secure : defaults.secure;
  const tls = { ...(defaults.tls || {}), ...((userImap && userImap.tls) || {}) };
  const sentMailbox = (userImap && userImap.sentMailbox) || defaults.sentMailbox;

  const client = {
    host,
    auth: { user: authUser, pass: authPass },
  };

  if (port !== undefined && port !== null) {
    client.port = Number(port);
  }

  if (secure !== undefined) {
    client.secure = Boolean(secure);
  } else if (!client.port || Number(client.port) === 993) {
    client.secure = true;
  }

  if (Object.keys(tls).length) {
    client.tls = tls;
  }

  return { client, sentMailbox };
}

function normalizeUserImap(input, fallback) {
  if (typeof input === 'undefined') {
    return cloneImapConfig(fallback);
  }
  if (!input) {
    return null;
  }
  const normalized = cloneImapConfig(input) || {};
  if (input.port !== undefined) {
    normalized.port = Number(input.port);
  }
  if (input.secure !== undefined) {
    normalized.secure = Boolean(input.secure);
  }
  if (input.sentMailbox !== undefined) {
    normalized.sentMailbox = input.sentMailbox;
  }
  return normalized;
}

function cloneImapConfig(config) {
  if (!config) {
    return null;
  }
  const clone = { ...config };
  if (config.auth) {
    clone.auth = { ...config.auth };
  }
  if (config.tls) {
    clone.tls = { ...config.tls };
  }
  return clone;
}

function mailboxPriority(name = '') {
  const value = name.toLowerCase();
  if (value === 'inbox') return 0;
  if (value.includes('sent')) return 1;
  if (value.includes('draft')) return 2;
  if (value.includes('archive')) return 3;
  if (value.includes('spam') || value.includes('junk')) return 4;
  if (value.includes('trash')) return 5;
  return 10;
}

function hasFlag(flags, flag) {
  if (!flags) {
    return false;
  }
  const normalizedFlag = flag.toLowerCase();
  if (Array.isArray(flags)) {
    return flags.some((item) => String(item).toLowerCase() === normalizedFlag);
  }
  if (flags instanceof Set) {
    return Array.from(flags).some((item) => String(item).toLowerCase() === normalizedFlag);
  }
  return String(flags).toLowerCase() === normalizedFlag;
}

function hasSeenFlag(flags) {
  return hasFlag(toArray(flags), '\\seen');
}

function toArray(value) {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value;
  }
  if (value instanceof Set) {
    return Array.from(value);
  }
  return [value];
}

function formatAddressList(addresses) {
  if (!addresses) {
    return '';
  }
  const list = Array.isArray(addresses) ? addresses : [addresses];
  return list
    .map((entry) => {
      if (!entry) {
        return '';
      }
      const address = entry.address || entry;
      const name = entry.name;
      if (!address) {
        return '';
      }
      return name ? `${name} <${address}>` : address;
    })
    .filter(Boolean)
    .join(', ');
}

function buildRawMessage({ from, to, subject, date, body }) {
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${(date instanceof Date ? date : new Date(date)).toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    body || '',
  ];
  return lines.join('\r\n');
}

function streamToBuffer(source) {
  if (!source) {
    return Promise.resolve(Buffer.alloc(0));
  }
  if (Buffer.isBuffer(source)) {
    return Promise.resolve(source);
  }
  if (typeof source === 'string') {
    return Promise.resolve(Buffer.from(source));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let finished = false;
    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      resolve(Buffer.concat(chunks));
    };
    source.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    source.once('error', (error) => {
      if (!finished) {
        finished = true;
        reject(error);
      }
    });
    source.once('end', finish);
    source.once('close', finish);
  });
}

function parseBoolean(value) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
      return true;
    }
    if (['0', 'false', 'no', 'off'].includes(normalized)) {
      return false;
    }
  }
  return undefined;
}
