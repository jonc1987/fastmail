const { randomUUID } = require('crypto');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const addressParser = require('nodemailer/lib/addressparser');
const validator = require('validator');

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
    this.transport =
      options.transport || nodemailer.createTransport(options.transportOptions || defaultTransportOptions());
    this.users = new Map();
    this.userIndex = new Map();
    this.mailboxes = new Map();
    this.messages = new Map();

    const seeds = options.seedUsers || parseSeedUsers();
    if (Array.isArray(seeds)) {
      this.seedPromises = seeds.map((user) => this.ensureUser(user));
    } else {
      this.seedPromises = [];
    }
  }

  async ready() {
    await Promise.all(this.seedPromises || []);
  }

  async ensureUser({ email, password, name }) {
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

    if (existing) {
      existing.passwordHash = passwordHash;
      existing.name = displayName;
      return this._publicUser(existing);
    }

    const id = randomUUID();
    const record = {
      id,
      email: normalizedEmail,
      name: displayName,
      passwordHash,
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
    const record = this.userIndex.get(userId);
    if (!record) {
      throw new Error('user not found');
    }
    return this._publicUser(record);
  }

  listMailboxes(userId) {
    const boxes = this._mailboxMap(userId);
    return Array.from(boxes.entries()).map(([name, messages]) => ({
      name,
      total: messages.length,
      unread: messages.filter((message) => message.status === 'unread').length,
    }));
  }

  listMessages(userId, mailbox) {
    const boxes = this._mailboxMap(userId);
    const messages = boxes.get(mailbox);
    if (!messages) {
      throw new Error(`mailbox not found: ${mailbox}`);
    }
    return messages;
  }

  getMessage(userId, messageId) {
    const messages = this.messages.get(userId);
    if (!messages || !messages.has(messageId)) {
      throw new Error('message not found');
    }
    return messages.get(messageId);
  }

  markRead(userId, messageId) {
    const message = this.getMessage(userId, messageId);
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

  async sendMessage(userId, payload = {}) {
    const user = this.userIndex.get(userId);
    if (!user) {
      throw new Error('user not found');
    }

    const { to, subject, body } = payload;
    if (!to || !to.trim()) {
      throw new Error('to is required');
    }
    if (!subject || !subject.trim()) {
      throw new Error('subject is required');
    }

    const timestamp = this.clock().toISOString();
    const formattedRecipients = this._normalizeRecipientList(to);
    const message = {
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

    this._storeMessage(userId, message);

    await this.transport.sendMail({
      from: `${user.name} <${user.email}>`,
      to: formattedRecipients,
      subject: message.subject,
      text: message.body,
    });

    this._deliverInternalRecipients({ ...message, ownerId: userId });

    return message;
  }

  _deliverInternalRecipients(message) {
    const recipients = this._parseAddresses(message.to);
    recipients.forEach((recipient) => {
      const user = this.users.get(recipient.address);
      if (!user) {
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
    return { id: record.id, email: record.email, name: record.name };
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
