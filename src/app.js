const path = require('path');
const express = require('express');
const EmailService = require('./emailService');

function createServer(emailService = new EmailService()) {
  const app = express();

  app.use(express.json());

  app.get('/api/mailboxes', (req, res) => {
    res.json(emailService.listMailboxes());
  });

  app.get('/api/mailboxes/:mailbox/messages', (req, res) => {
    try {
      const messages = emailService.listMessages(req.params.mailbox);
      res.json(messages);
    } catch (error) {
      res.status(404).json({ error: error.message });
    }
  });

  app.post('/api/drafts', (req, res) => {
    try {
      const draft = emailService.createDraft(req.body);
      res.status(201).json(draft);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/api/drafts/:id/send', (req, res) => {
    try {
      const message = emailService.sendDraft(req.params.id);
      res.json(message);
    } catch (error) {
      const status = error.message.includes('not found') ? 404 : 400;
      res.status(status).json({ error: error.message });
    }
  });

  app.post('/api/messages/:id/read', (req, res) => {
    try {
      const message = emailService.markRead(req.params.id);
      res.json(message);
    } catch (error) {
      res.status(404).json({ error: error.message });
    }
  });

  app.get('/api/messages/:id', (req, res) => {
    try {
      const message = emailService.getMessage(req.params.id);
      res.json(message);
    } catch (error) {
      res.status(404).json({ error: error.message });
    }
  });

  const publicDir = path.join(__dirname, '..', 'public');
  app.use(express.static(publicDir));

  app.use((req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  return app;
}

module.exports = { createServer };
