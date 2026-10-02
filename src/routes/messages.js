// General messages sent through the Contact page. Every staff member and administrator can see them in the
// shelter portal Inbox and reply; replies are emailed to the sender and, if they have an account, appear on
// their dashboard where they can answer back.
const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const config = require('../config');
const { sendMail } = require('../services/mailer');
const { notify, notifyStaff } = require('../services/notify');
const { requireAuth, requireStaff } = require('../middleware/auth');
const { now, asyncHandler, clean, escapeHtml, HttpError } = require('../utils');

const router = express.Router();
const replyLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 40, message: { error: 'Too many messages in a short time. Please try again later.' } });

// Conversation for a message, including ones saved before threads existed
const threadOf = (m) => (m.thread?.length ? m.thread : [{ from: 'visitor', name: m.name, text: m.message, at: m.at }]);
const lastAt = (m) => { const t = threadOf(m); return t[t.length - 1]?.at || m.at; };
const statusOf = (m) => m.status || 'Open';
const owns = (req, m) => m.userId === req.user.id || (!m.userId && req.user.emailVerified && m.email === req.user.email);

const forSender = (m) => ({ id: m.id, topic: m.topic || 'General', status: statusOf(m), at: m.at, updatedAt: lastAt(m),
  thread: threadOf(m).map((x) => ({ from: x.from, name: x.from === 'staff' ? (x.name || 'PawPal team') : 'You', text: x.text, at: x.at })) });

router.get('/', requireStaff, asyncHandler(async (req, res) => {
  const all = await db.find('messages');
  let list = req.query.status ? all.filter((m) => statusOf(m) === req.query.status) : all;
  list = list.sort((a, b) => ((statusOf(a) === 'Open') === (statusOf(b) === 'Open') ? new Date(lastAt(b)) - new Date(lastAt(a)) : statusOf(a) === 'Open' ? -1 : 1));
  res.json({ messages: list.map((m) => ({ ...m, status: statusOf(m), thread: threadOf(m), updatedAt: lastAt(m) })), open: all.filter((m) => statusOf(m) === 'Open').length });
}));

router.get('/mine', requireAuth, asyncHandler(async (req, res) => {
  const list = (await db.find('messages')).filter((m) => owns(req, m)).sort((a, b) => new Date(lastAt(b)) - new Date(lastAt(a)));
  res.json({ messages: list.map(forSender) });
}));

router.post('/:id/reply', requireStaff, asyncHandler(async (req, res) => {
  const m = await db.findOne('messages', { id: req.params.id });
  if (!m) throw new HttpError(404, 'Message not found.');
  const reply = clean(req.body.reply, 2000);
  if (reply.length < 2) throw new HttpError(400, 'Please write a reply.');
  const updated = await db.update('messages', m.id, { thread: [...threadOf(m), { from: 'staff', name: req.user.name, text: reply, at: now() }],
    status: 'Answered', repliedBy: req.user.name });
  await notify(m.userId, { type: 'enquiry', title: 'The PawPal team replied', message: reply.slice(0, 140), link: `dashboard.html?message=${m.id}#enquiries` });
  sendMail({ to: m.email, type: 'contact-reply', subject: `Re: your message to PawPal${m.topic ? ` (${m.topic})` : ''}`, heading: 'The PawPal team replied',
    body: `<p>Hi ${escapeHtml(String(m.name || '').split(' ')[0] || 'there')},</p><p style="white-space:pre-wrap">${escapeHtml(reply)}</p>`
      + `<p style="color:#76604F"><b>You wrote:</b><br>${escapeHtml(m.message)}</p>`,
    buttonText: m.userId ? 'Reply on PawPal' : 'Visit PawPal', buttonUrl: m.userId ? `${config.appUrl}/dashboard.html#enquiries` : `${config.appUrl}/contact.html` }).catch(() => {});
  res.json({ message: m.userId ? 'Reply sent — they have been emailed and notified.' : 'Reply sent by email.', item: updated });
}));

// The sender answers back from their dashboard
router.post('/:id/messages', requireAuth, replyLimiter, asyncHandler(async (req, res) => {
  const m = await db.findOne('messages', { id: req.params.id });
  if (!m || !owns(req, m)) throw new HttpError(404, 'Message not found.');
  const text = clean(req.body.text, 2000);
  if (text.length < 2) throw new HttpError(400, 'Please write a message.');
  const updated = await db.update('messages', m.id, { thread: [...threadOf(m), { from: 'visitor', name: req.user.name, text, at: now() }], status: 'Open', userId: m.userId || req.user.id });
  await notifyStaff(null, { title: `${req.user.name} replied to PawPal`, message: text.slice(0, 120), link: `enquiries.html?tab=messages&id=${m.id}` });
  res.json({ message: 'Sent — the PawPal team has been notified.', item: forSender(updated) });
}));

router.post('/:id/close', requireStaff, asyncHandler(async (req, res) => {
  const m = await db.findOne('messages', { id: req.params.id });
  if (!m) throw new HttpError(404, 'Message not found.');
  await db.update('messages', m.id, { status: 'Closed' });
  res.json({ message: 'Message closed.' });
}));

module.exports = router;
