const { randomUUID } = require('crypto');

const DEFAULT_MAILBOXES = ['inbox', 'sent', 'drafts'];

class EmailService {
  constructor(clock = () => new Date()) {
    this.clock = clock;
    this.mailboxes = new Map();
    DEFAULT_MAILBOXES.forEach((name) => {
      this.mailboxes.set(name, []);
    });
    this.messages = new Map();
    this.drafts = new Map();
  }

  createDraft(payload) {
    const { from, to, subject, body } = payload || {};
    if (!from || !from.trim()) {
      throw new Error('from is required');
    }
    if (!to || !to.trim()) {
      throw new Error('to is required');
    }
    if (!subject || !subject.trim()) {
      throw new Error('subject is required');
    }

    const timestamp = this.clock().toISOString();
    const draft = {
      id: randomUUID(),
      from: from.trim(),
      to: to.trim(),
      subject: subject.trim(),
      body: body || '',
      status: 'draft',
      mailbox: 'drafts',
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    this.messages.set(draft.id, draft);
    this.drafts.set(draft.id, draft);
    this._mailbox('drafts').unshift(draft);
    return draft;
  }

  sendDraft(id) {
    const draft = this.drafts.get(id);
    if (!draft) {
      throw new Error('draft not found');
    }
    if (draft.status === 'sent') {
      throw new Error('draft already sent');
    }

    const timestamp = this.clock().toISOString();
    const sentMessage = {
      ...draft,
      status: 'sent',
      mailbox: 'sent',
      sentAt: timestamp,
      updatedAt: timestamp,
    };

    this.messages.set(id, sentMessage);
    this._replaceInMailbox('drafts', id, sentMessage);
    this._removeFromMailbox('drafts', id);
    this.drafts.delete(id);
    this._mailbox('sent').unshift(sentMessage);

    const deliveredMessage = {
      ...sentMessage,
      id: randomUUID(),
      mailbox: 'inbox',
      status: 'unread',
    };
    this.messages.set(deliveredMessage.id, deliveredMessage);
    this._mailbox('inbox').unshift(deliveredMessage);

    return sentMessage;
  }

  listMailboxes() {
    return Array.from(this.mailboxes.entries()).map(([name, messages]) => ({
      name,
      total: messages.length,
      unread: messages.filter((message) => message.status === 'unread').length,
    }));
  }

  listMessages(mailbox) {
    const messages = this.mailboxes.get(mailbox);
    if (!messages) {
      throw new Error(`mailbox not found: ${mailbox}`);
    }
    return messages;
  }

  getMessage(id) {
    const message = this.messages.get(id);
    if (!message) {
      throw new Error('message not found');
    }
    return message;
  }

  markRead(id) {
    const message = this.messages.get(id);
    if (!message) {
      throw new Error('message not found');
    }

    const timestamp = this.clock().toISOString();
    const updated = { ...message, status: 'read', updatedAt: timestamp };
    this.messages.set(id, updated);
    this._replaceInMailbox(updated.mailbox, id, updated);
    return updated;
  }

  _mailbox(name) {
    if (!this.mailboxes.has(name)) {
      this.mailboxes.set(name, []);
    }
    return this.mailboxes.get(name);
  }

  _replaceInMailbox(name, id, updatedMessage) {
    const mailbox = this.mailboxes.get(name);
    if (!mailbox) {
      return;
    }
    const index = mailbox.findIndex((message) => message.id === id);
    if (index >= 0) {
      mailbox.splice(index, 1, updatedMessage);
    }
  }

  _removeFromMailbox(name, id) {
    const mailbox = this.mailboxes.get(name);
    if (!mailbox) {
      return;
    }
    const index = mailbox.findIndex((message) => message.id === id);
    if (index >= 0) {
      mailbox.splice(index, 1);
    }
  }
}

module.exports = EmailService;
