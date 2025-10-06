const authPanel = document.getElementById('auth-panel');
const appShell = document.getElementById('app-shell');
const loginForm = document.getElementById('login-form');
const loginStatus = document.getElementById('login-status');
const loginEmail = document.getElementById('login-email');
const loginPassword = document.getElementById('login-password');
const composeForm = document.getElementById('compose-form');
const statusEl = document.getElementById('status');
const mailboxList = document.getElementById('mailbox-list');
const messageList = document.getElementById('message-list');
const messageView = document.getElementById('message-view');
const messageSubject = document.getElementById('message-subject');
const messageMeta = document.getElementById('message-meta');
const messageBody = document.getElementById('message-body');
const messagesTitle = document.getElementById('messages-title');
const markReadButton = document.getElementById('mark-read');
const userControls = document.getElementById('user-controls');
const userLabel = document.getElementById('user-label');
const logoutButton = document.getElementById('logout-button');
const fromDisplay = document.getElementById('from-display');

const state = {
  user: null,
  mailboxes: [],
  selectedMailbox: null,
  selectedMessageId: null,
};

async function authorizedFetch(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    credentials: 'same-origin',
    ...options,
  });
  if (response.status === 401) {
    showAuth();
    throw new Error('authentication required');
  }
  return response;
}

function showApp() {
  authPanel.hidden = true;
  appShell.hidden = false;
  userControls.hidden = false;
  statusEl.textContent = '';
  loginStatus.textContent = '';
  if (state.user) {
    userLabel.textContent = `${state.user.name} (${state.user.email})`;
    fromDisplay.textContent = state.user.email;
  }
}

function showAuth(message = '') {
  authPanel.hidden = false;
  appShell.hidden = true;
  userControls.hidden = true;
  loginStatus.textContent = message;
  state.user = null;
}

async function bootstrap() {
  bindEvents();
  await checkSession();
}

function bindEvents() {
  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    loginStatus.textContent = 'Signing in…';
    try {
      const response = await authorizedFetch('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: loginEmail.value, password: loginPassword.value }),
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Unable to sign in');
      }
      state.user = await response.json();
      loginForm.reset();
      await afterAuth();
    } catch (error) {
      loginStatus.textContent = error.message;
    }
  });

  logoutButton.addEventListener('click', async () => {
    await authorizedFetch('/api/auth/logout', { method: 'POST', body: '{}' }).catch(() => {});
    showAuth('Signed out.');
  });

  composeForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    statusEl.textContent = 'Sending…';
    try {
      const formData = new FormData(composeForm);
      const payload = Object.fromEntries(formData.entries());
      const response = await authorizedFetch('/api/messages/send', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Unable to send message');
      }
      statusEl.textContent = 'Email sent!';
      composeForm.reset();
      await refreshMailboxes();
      await loadMessages(state.selectedMailbox || 'sent');
    } catch (error) {
      statusEl.textContent = error.message;
    }
  });

  markReadButton.addEventListener('click', async () => {
    if (!state.selectedMessageId) return;
    try {
      await authorizedFetch(`/api/messages/${state.selectedMessageId}/read`, { method: 'POST', body: '{}' });
      await refreshMailboxes();
      await showMessage(state.selectedMessageId);
    } catch (error) {
      statusEl.textContent = error.message;
    }
  });
}

async function checkSession() {
  try {
    const response = await fetch('/api/me', { credentials: 'same-origin' });
    if (!response.ok) {
      throw new Error();
    }
    state.user = await response.json();
    await afterAuth();
  } catch {
    showAuth();
  }
}

async function afterAuth() {
  showApp();
  await refreshMailboxes();
  if (!state.selectedMailbox && state.mailboxes?.length) {
    state.selectedMailbox = state.mailboxes[0].name;
  }
  if (state.selectedMailbox) {
    await loadMessages(state.selectedMailbox);
  }
}

async function refreshMailboxes() {
  const response = await authorizedFetch('/api/mailboxes');
  const mailboxes = await response.json();
  state.mailboxes = mailboxes;
  renderMailboxes(mailboxes);
}

function renderMailboxes(mailboxes) {
  mailboxList.innerHTML = '';
  mailboxes.forEach((mailbox) => {
    const li = document.createElement('li');
    li.textContent = capitalize(mailbox.name);
    li.dataset.mailbox = mailbox.name;
    if (mailbox.unread > 0) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = mailbox.unread;
      li.appendChild(badge);
    }
    if (mailbox.name === state.selectedMailbox) {
      li.classList.add('active');
    }
    li.addEventListener('click', async () => {
      state.selectedMailbox = mailbox.name;
      document.querySelectorAll('#mailbox-list li').forEach((item) => item.classList.remove('active'));
      li.classList.add('active');
      await loadMessages(mailbox.name);
    });
    mailboxList.appendChild(li);
  });
}

async function loadMessages(mailbox) {
  const response = await authorizedFetch(`/api/mailboxes/${mailbox}/messages`);
  const messages = await response.json();
  state.selectedMailbox = mailbox;
  renderMessages(mailbox, messages);
}

function renderMessages(mailbox, messages) {
  messagesTitle.textContent = `${capitalize(mailbox)} (${messages.length})`;
  messageList.innerHTML = '';
  messageView.hidden = true;
  state.selectedMessageId = null;

  if (messages.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'message-item';
    empty.textContent = 'No messages yet.';
    messageList.appendChild(empty);
    return;
  }

  messages.forEach((message) => {
    const li = document.createElement('li');
    li.className = 'message-item';
    if (message.status === 'unread') {
      li.classList.add('unread');
    }
    li.dataset.messageId = message.id;
    li.innerHTML = `<strong>${escapeHtml(message.subject)}</strong><br /><small>${escapeHtml(message.from)} → ${escapeHtml(
      message.to
    )}</small>`;
    li.addEventListener('click', () => showMessage(message.id));
    messageList.appendChild(li);
  });
}

async function showMessage(id) {
  const response = await authorizedFetch(`/api/messages/${id}`);
  if (!response.ok) {
    return;
  }
  const message = await response.json();
  state.selectedMessageId = message.id;
  messageView.hidden = false;
  messageSubject.textContent = message.subject;
  messageMeta.textContent = `${message.from} → ${message.to} • ${new Date(
    message.updatedAt || message.createdAt
  ).toLocaleString()}`;
  messageBody.textContent = message.body || '(no content)';

  if (message.mailbox === 'inbox' && message.status === 'unread') {
    markReadButton.hidden = false;
    markReadButton.disabled = false;
  } else {
    markReadButton.hidden = true;
  }
}

function capitalize(value = '') {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function escapeHtml(value = '') {
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}

bootstrap();
