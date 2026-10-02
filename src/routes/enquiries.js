// Enquiries: an adopter asks the shelter about a specific pet. Each enquiry is a conversation — staff and the adopter
// can keep replying, and every message notifies (and emails) the other side.
const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { emails } = require('../services/mailer');
const { notify, notifyStaff } = require('../services/notify');
const { requireAuth, requireAdopter, requireStaff, shelterScope, inScope } = require('../middleware/auth');
const { newId, now, asyncHandler, clean, HttpError } = require('../utils');

const router = express.Router();
const limiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 15, message: { error: 'Too many questions in a short time. Please try again later.' } });
const replyLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 40, message: { error: 'Too many messages in a short time. Please try again later.' } });

// The conversation, including enquiries saved before threads existed (one question + one reply)
const threadOf = (e) => (e.thread?.length ? e.thread : [
  { from: 'adopter', name: e.name, text: e.message, at: e.at },
  ...(e.reply ? [{ from: 'staff', name: e.repliedBy || 'Shelter team', text: e.reply, at: e.repliedAt || e.at }] : []),
]);
const lastAt = (e) => { const t = threadOf(e); return t[t.length - 1]?.at || e.at; };

const forAdopter = (e) => ({ id: e.id, petId: e.petId, petName: e.petName, message: e.message, status: e.status, reply: e.reply || '', at: e.at,
  repliedAt: e.repliedAt || null, updatedAt: lastAt(e), thread: threadOf(e).map((m) => ({ from: m.from, name: m.from === 'staff' ? (m.name || 'Shelter team') : 'You', text: m.text, at: m.at })) });

router.post('/', requireAdopter, limiter, asyncHandler(async (req, res) => {
  const pet = await db.findOne('pets', { id: clean(req.body.petId, 40) });
  if (!pet || !['Available', 'On Hold'].includes(pet.status)) throw new HttpError(404, 'This pet is not available.');
  const message = clean(req.body.message, 1500);
  if (message.length < 10) throw new HttpError(400, 'Please write your question (at least 10 characters).');
  const at = now();
  const enq = { id: newId('enq'), petId: pet.id, petName: pet.name, shelterId: pet.shelterId || null, userId: req.user.id,
    name: req.user.name, email: req.user.email, message, status: 'Open', reply: '', at,
    thread: [{ from: 'adopter', name: req.user.name, text: message, at }] };
  await db.insert('enquiries', enq);
  await notifyStaff(enq.shelterId, { title: `New question about ${pet.name}`, message: `${req.user.name}: ${message.slice(0, 120)}`, link: `enquiries.html?id=${enq.id}` });
  emails.enquiryReceived(enq).catch(() => {});
  res.status(201).json({ enquiry: forAdopter(enq), message: 'Your question was sent to the shelter. You\'ll get an email and a notification when they reply.' });
}));

router.get('/mine', requireAuth, asyncHandler(async (req, res) => {
  const list = (await db.find('enquiries', { userId: req.user.id })).sort((a, b) => new Date(lastAt(b)) - new Date(lastAt(a)));
  res.json({ enquiries: list.map(forAdopter) });
}));

// The adopter follows up in the same conversation; it reopens the enquiry for the shelter
router.post('/:id/messages', requireAdopter, replyLimiter, asyncHandler(async (req, res) => {
  const enq = await db.findOne('enquiries', { id: req.params.id });
  if (!enq || enq.userId !== req.user.id) throw new HttpError(404, 'Enquiry not found.');
  const text = clean(req.body.text, 1500);
  if (text.length < 2) throw new HttpError(400, 'Please write a message.');
  const msg = { from: 'adopter', name: req.user.name, text, at: now() };
  const updated = await db.update('enquiries', enq.id, { thread: [...threadOf(enq), msg], status: 'Open' });
  await notifyStaff(enq.shelterId, { title: `${req.user.name} replied about ${enq.petName}`, message: text.slice(0, 120), link: `enquiries.html?id=${enq.id}` });
  res.json({ enquiry: forAdopter(updated), message: 'Sent — the shelter team has been notified.' });
}));

router.get('/', requireStaff, asyncHandler(async (req, res) => {
  const [all, shelters] = await Promise.all([db.find('enquiries'), db.find('shelters')]);
  const names = new Map(shelters.map((s) => [s.id, s.name]));
  const scope = shelterScope(req);
  const scoped = scope ? all.filter((e) => e.shelterId === scope) : all;
  let list = req.query.status ? scoped.filter((e) => e.status === req.query.status) : scoped;
  list = list.sort((a, b) => ((a.status === 'Open') === (b.status === 'Open') ? new Date(lastAt(b)) - new Date(lastAt(a)) : a.status === 'Open' ? -1 : 1));
  res.json({
    enquiries: list.map((e) => ({ ...e, thread: threadOf(e), updatedAt: lastAt(e), shelterName: names.get(e.shelterId) || '' })),
    open: scoped.filter((e) => e.status === 'Open').length,
  });
}));

router.post('/:id/reply', requireStaff, asyncHandler(async (req, res) => {
  const enq = await db.findOne('enquiries', { id: req.params.id });
  if (!enq || !inScope(req, enq)) throw new HttpError(404, 'Enquiry not found.');
  const reply = clean(req.body.reply, 2000);
  if (reply.length < 2) throw new HttpError(400, 'Please write a reply.');
  const at = now();
  const updated = await db.update('enquiries', enq.id, { thread: [...threadOf(enq), { from: 'staff', name: req.user.name, text: reply, at }],
    reply, status: 'Answered', repliedBy: req.user.name, repliedAt: at });
  await notify(enq.userId, { type: 'enquiry', title: `Reply about ${enq.petName}`, message: reply.slice(0, 140), link: `dashboard.html?enquiry=${enq.id}#enquiries` });
  emails.enquiryReply(updated).catch(() => {});
  res.json({ enquiry: updated, message: 'Reply sent — the adopter has been notified and emailed.' });
}));

router.post('/:id/close', requireStaff, asyncHandler(async (req, res) => {
  const enq = await db.findOne('enquiries', { id: req.params.id });
  if (!enq || !inScope(req, enq)) throw new HttpError(404, 'Enquiry not found.');
  const updated = await db.update('enquiries', enq.id, { status: 'Closed' });
  res.json({ enquiry: updated, message: 'Enquiry closed.' });
}));

module.exports = router;
