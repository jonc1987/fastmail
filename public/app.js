const composeForm = document.getElementById('compose-form');
const statusEl = document.getElementById('status');
const sendButton = document.getElementById('send-button');
const mailboxList = document.getElementById('mailbox-list');
const messageList = document.getElementById('message-list');
const messageView = document.getElementById('message-view');
const messageSubject = document.getElementById('message-subject');
const messageMeta = document.getElementById('message-meta');
const messageBody = document.getElementById('message-body');
const messagesTitle = document.getElementById('messages-title');
const markReadButton = document.getElementById('mark-read');

let selectedMailbox = 'inbox';
let selectedMessageId = null;
let lastDraftId = null;

async function loadMailboxes() {
  const response = await fetch('/api/mailboxes');
  const mailboxes = await response.json();
  renderMailboxes(mailboxes);
  if (!mailboxes.find((box) => box.name === selectedMailbox)) {
    selectedMailbox = mailboxes[0]?.name ?? 'inbox';
  }
  await loadMessages(selectedMailbox);
}

function renderMailboxes(mailboxes) {
  mailboxList.innerHTML = '';
  mailboxes.forEach((mailbox) => {
    const li = document.createElement('li');
    li.textContent = mailbox.name.charAt(0).toUpperCase() + mailbox.name.slice(1);
    li.dataset.mailbox = mailbox.name;
    if (mailbox.unread > 0) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = mailbox.unread;
      li.appendChild(badge);
    }
    if (mailbox.name === selectedMailbox) {
      li.classList.add('active');
    }
    li.addEventListener('click', async () => {
      selectedMailbox = mailbox.name;
      await loadMessages(mailbox.name);
      document.querySelectorAll('#mailbox-list li').forEach((item) => item.classList.remove('active'));
      li.classList.add('active');
    });
    mailboxList.appendChild(li);
  });
}

async function loadMessages(mailbox) {
  const response = await fetch(`/api/mailboxes/${mailbox}/messages`);
  const messages = await response.json();
  renderMessages(mailbox, messages);
}

function renderMessages(mailbox, messages) {
  messagesTitle.textContent = `${mailbox.charAt(0).toUpperCase() + mailbox.slice(1)} (${messages.length})`;
  messageList.innerHTML = '';
  messageView.hidden = true;
  selectedMessageId = null;

  messages.forEach((message) => {
    const li = document.createElement('li');
    li.className = 'message-item';
    li.dataset.messageId = message.id;
    li.innerHTML = `<strong>${message.subject}</strong><br /><small>${message.from} → ${message.to}</small>`;
    if (message.status === 'unread') {
      li.classList.add('unread');
    }
    li.addEventListener('click', () => showMessage(message.id));
    messageList.appendChild(li);
  });
}

async function showMessage(id) {
  const response = await fetch(`/api/messages/${id}`);
  if (!response.ok) {
    return;
  }
  const message = await response.json();
  selectedMessageId = message.id;
  messageView.hidden = false;
  messageSubject.textContent = message.subject;
  messageMeta.textContent = `${message.from} → ${message.to} • ${new Date(message.updatedAt || message.createdAt).toLocaleString()}`;
  messageBody.textContent = message.body || '(no content)';

  if (message.mailbox === 'inbox' && message.status === 'unread') {
    markReadButton.hidden = false;
    markReadButton.disabled = false;
  } else {
    markReadButton.hidden = true;
  }
}

async function markMessageRead() {
  if (!selectedMessageId) return;
  const response = await fetch(`/api/messages/${selectedMessageId}/read`, { method: 'POST' });
  if (response.ok) {
    await loadMailboxes();
    await showMessage(selectedMessageId);
  }
}

composeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(composeForm);
  const payload = Object.fromEntries(formData.entries());
  try {
    const response = await fetch('/api/drafts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Unable to save draft');
    }
    lastDraftId = data.id;
    sendButton.disabled = false;
    statusEl.textContent = 'Draft saved. You can now send it!';
    await loadMailboxes();
  } catch (error) {
    statusEl.textContent = error.message;
  }
});

sendButton.addEventListener('click', async () => {
  if (!lastDraftId) return;
  sendButton.disabled = true;
  try {
    const response = await fetch(`/api/drafts/${lastDraftId}/send`, { method: 'POST' });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Unable to send email');
    }
    statusEl.textContent = 'Email sent! Check your Sent and Inbox mailboxes.';
    composeForm.reset();
    lastDraftId = null;
    await loadMailboxes();
  } catch (error) {
    statusEl.textContent = error.message;
    sendButton.disabled = false;
  }
});

markReadButton.addEventListener('click', markMessageRead);

loadMailboxes().catch((error) => {
  statusEl.textContent = `Failed to load mailboxes: ${error.message}`;
});
