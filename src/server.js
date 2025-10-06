const { createServer } = require('./app');

const PORT = process.env.PORT || 3000;
const app = createServer();

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Fastmail server listening on port ${PORT}`);
});
