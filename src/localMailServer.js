const { SMTPServer } = require('smtp-server');
const hoodiecrow = require('hoodiecrow-imap');
const { simpleParser } = require('mailparser');

function defaultStorage() {
  return {
    INBOX: {
      messages: [],
    },
    '': {
      type: 'personal',
      separator: '/',
      folders: {
        Sent: {
          'special-use': '\\Sent',
          subscribed: true,
          messages: [],
        },
        Archive: {
          'special-use': '\\Archive',
          subscribed: true,
          messages: [],
        },
      },
    },
  };
}

function normalizeEmail(email = '') {
  return email.trim().toLowerCase();
}

class LocalMailServer {
  constructor(options = {}) {
    this.domain = options.domain || process.env.EMAIL_DOMAIN || 'fastmail.test';
    this.host = options.host || '127.0.0.1';
    this.smtpPort = options.smtpPort ?? 0;
    this.smtpServer = null;
    this.smtpAddress = null;
    this.started = false;
    this.startPromise = null;
    this.users = new Map();
    this.imapServers = new Map();
  }

  async start() {
    if (this.started) {
      return;
    }

    if (this.startPromise) {
      await this.startPromise;
      return;
    }

    this.startPromise = new Promise((resolve, reject) => {
      const server = new SMTPServer({
        disabledCommands: ['STARTTLS'],
        authOptional: false,
        logger: false,
        onAuth: (auth, session, callback) => {
          try {
            const username = normalizeEmail(auth.username);
            const password = auth.password || '';
            const record = this.users.get(username);
            if (!record || record.password !== password) {
              return callback(new Error('Invalid username or password'));
            }
            session.user = record;
            return callback(null, { user: record });
          } catch (error) {
            return callback(error);
          }
        },
        onData: (stream, session, callback) => {
          const chunks = [];
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('error', callback);
          stream.on('end', async () => {
            try {
              const raw = Buffer.concat(chunks);
              await this._handleSmtpMessage(session, raw);
              callback();
            } catch (error) {
              callback(error);
            }
          });
        },
      });

      server.once('error', reject);
      server.listen(this.smtpPort, this.host, () => {
        this.smtpServer = server;
        this.smtpAddress = server.server.address();
        this.started = true;
        this.startPromise = null;
        resolve();
      });
    });

    await this.startPromise;
  }

  async stop() {
    const closures = [];

    if (this.smtpServer) {
      closures.push(
        new Promise((resolve) => {
          this.smtpServer.close(() => resolve());
        })
      );
      this.smtpServer = null;
      this.smtpAddress = null;
      this.started = false;
      this.startPromise = null;
    }

    for (const { server } of this.imapServers.values()) {
      closures.push(
        new Promise((resolve) => {
          server.close(() => resolve());
        })
      );
    }
    this.imapServers.clear();
    this.users.clear();

    await Promise.all(closures);
  }

  transportOptions() {
    if (!this.smtpAddress) {
      throw new Error('local SMTP server is not running');
    }
    return {
      host: this.host,
      port: this.smtpAddress.port,
      secure: false,
      tls: { rejectUnauthorized: false },
    };
  }

  imapDefaults() {
    return {
      host: this.host,
      secure: false,
      tls: { rejectUnauthorized: false },
    };
  }

  async upsertUser({ email, password }) {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) {
      throw new Error('valid email is required');
    }
    if (!password) {
      throw new Error('password is required');
    }

    await this.start();

    let record = this.users.get(normalizedEmail);
    if (!record) {
      const { server, port } = await this._createImapServer(normalizedEmail, password);
      record = { email: normalizedEmail, password, port, server };
      this.users.set(normalizedEmail, record);
    } else {
      record.password = password;
      if (record.server && record.server.users && record.server.users[normalizedEmail]) {
        record.server.users[normalizedEmail].password = password;
      }
    }

    return this._imapOverrides(record);
  }

  getUserImapConfig(email) {
    const record = this.users.get(normalizeEmail(email));
    if (!record) {
      return null;
    }
    return this._imapOverrides(record);
  }

  listMailboxes(email) {
    const entry = this.imapServers.get(normalizeEmail(email));
    if (!entry || !entry.server) {
      return [];
    }

    const results = [];
    const seen = new Set();
    const pushMailbox = (mailbox) => {
      if (!mailbox) {
        return;
      }
      const name = mailbox.path || 'INBOX';
      if (seen.has(name)) {
        return;
      }
      if (Array.isArray(mailbox.flags) && mailbox.flags.includes('\\Noselect')) {
        return;
      }
      const messages = Array.isArray(mailbox.messages) ? mailbox.messages : [];
      const unread = messages.filter((message) => {
        const flags = Array.isArray(message.flags) ? message.flags : [];
        return flags.indexOf('\\Seen') === -1;
      }).length;
      seen.add(name);
      results.push({ name, total: messages.length, unread });
    };

    pushMailbox(entry.server.getMailbox('INBOX'));
    if (entry.server.folderCache) {
      Object.values(entry.server.folderCache).forEach((mailbox) => {
        pushMailbox(mailbox);
      });
    }

    return results;
  }

  _imapOverrides(record) {
    return {
      host: this.host,
      port: record.port,
      secure: false,
      auth: { user: record.email, pass: record.password },
      sentMailbox: 'Sent',
    };
  }

  async _createImapServer(email, password) {
    const storage = defaultStorage();
    const server = hoodiecrow({
      users: { [email]: { password } },
      storage,
      plugins: ['IDLE', 'LITERALPLUS', 'NAMESPACE', 'SPECIAL-USE'],
    });

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, this.host, () => {
        resolve();
      });
    });

    const address = server.server.address();
    this.imapServers.set(email, { server, storage, port: address.port });
    return { server, port: address.port };
  }

  async _handleSmtpMessage(session, rawBuffer) {
    const raw = rawBuffer.toString('utf8');
    const parsed = await simpleParser(raw);
    const recipients = (session.envelope.rcptTo || []).map((rcpt) => normalizeEmail(rcpt.address));
    const deliveryTime = parsed.date || new Date();

    const deliveries = recipients.map((recipient) => this._deliverToLocalInbox(recipient, raw, deliveryTime));
    await Promise.all(deliveries);
  }

  async _deliverToLocalInbox(email, raw, internalDate) {
    const entry = this.imapServers.get(email);
    if (!entry) {
      return;
    }
    entry.server.appendMessage('INBOX', [], internalDate, raw);
  }
}

module.exports = LocalMailServer;
