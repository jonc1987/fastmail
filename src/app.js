const path = require('path');
const express = require('express');
const session = require('express-session');
const EmailService = require('./emailService');

function createServer(emailService = new EmailService()) {
  const app = express();
  const readyPromise = emailService.ready();

  app.use(express.json());
  app.use(
    session({
      secret: process.env.SESSION_SECRET || 'fastmail-secret',
      resave: false,
      saveUninitialized: false,
      cookie: {
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000,
      },
    })
  );

  app.use((req, res, next) => {
    readyPromise.then(() => next()).catch(next);
  });

  const requireAuth = (req, res, next) => {
    if (!req.session.userId) {
      return res.status(401).json({ error: 'authentication required' });
    }
    next();
  };

  const asyncHandler = (handler) => (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };

  app.post(
    '/api/auth/login',
    asyncHandler(async (req, res) => {
      const { email, password } = req.body || {};
      const user = await emailService.authenticate(email, password);
      if (!user) {
        return res.status(401).json({ error: 'invalid email or password' });
      }
      req.session.userId = user.id;
      res.json(user);
    })
  );

  app.post('/api/auth/logout', (req, res) => {
    if (!req.session) {
      return res.status(204).end();
    }
    req.session.destroy(() => {
      res.status(204).end();
    });
  });

  app.get('/api/me', requireAuth, (req, res) => {
    try {
      const profile = emailService.getProfile(req.session.userId);
      res.json(profile);
    } catch (error) {
      res.status(404).json({ error: error.message });
    }
  });

  app.get('/api/mailboxes', requireAuth, (req, res) => {
    try {
      const mailboxes = emailService.listMailboxes(req.session.userId);
      res.json(mailboxes);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get('/api/mailboxes/:mailbox/messages', requireAuth, (req, res) => {
    try {
      const messages = emailService.listMessages(req.session.userId, req.params.mailbox);
      res.json(messages);
    } catch (error) {
      const status = error.message.includes('not found') ? 404 : 400;
      res.status(status).json({ error: error.message });
    }
  });

  app.get('/api/messages/:id', requireAuth, (req, res) => {
    try {
      const message = emailService.getMessage(req.session.userId, req.params.id);
      res.json(message);
    } catch (error) {
      res.status(404).json({ error: error.message });
    }
  });

  app.post('/api/messages/:id/read', requireAuth, (req, res) => {
    try {
      const message = emailService.markRead(req.session.userId, req.params.id);
      res.json(message);
    } catch (error) {
      res.status(404).json({ error: error.message });
    }
  });

  app.post(
    '/api/messages/send',
    requireAuth,
    asyncHandler(async (req, res) => {
      try {
        const message = await emailService.sendMessage(req.session.userId, req.body || {});
        res.status(201).json(message);
      } catch (error) {
        const status = error.message.includes('required') || error.message.includes('valid') ? 400 : 500;
        res.status(status).json({ error: error.message });
      }
    })
  );

  const publicDir = path.join(__dirname, '..', 'public');
  app.use(express.static(publicDir));

  app.use((req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  app.use((error, req, res, next) => {
    // eslint-disable-next-line no-console
    console.error(error);
    res.status(500).json({ error: 'internal server error' });
  });

  return app;
}

module.exports = { createServer };
