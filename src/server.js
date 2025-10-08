const { createServer } = require('./app');
const EmailService = require('./emailService');
const LocalMailServer = require('./localMailServer');

async function main() {
  const PORT = process.env.PORT || 3000;
  const localMailToggle = (process.env.LOCAL_MAIL_SERVERS || 'on').toLowerCase();
  const enableLocalMail = localMailToggle !== 'off' && localMailToggle !== 'false';

  const localMailServer = enableLocalMail ? new LocalMailServer() : null;
  const emailService = new EmailService({ localMailServer });
  const app = createServer(emailService);

  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Fastmail server listening on port ${PORT}`);
    if (enableLocalMail && localMailServer && localMailServer.smtpAddress) {
      const { host, port } = localMailServer.smtpAddress;
      // eslint-disable-next-line no-console
      console.log(`Local SMTP server listening on ${host}:${port}`);
    }
  });
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start Fastmail server', error);
  process.exit(1);
});
