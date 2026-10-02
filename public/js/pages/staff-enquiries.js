// Shelter portal Inbox: pet questions (enquiries) and Contact-page messages as conversations.
// Staff reply (emailed + shown on the adopter's dashboard, where they can answer back) or close.
// Deep links from notifications: enquiries.html?id=… and enquiries.html?tab=messages&id=…
(async () => {
  const { $, $$, esc, icons, timeAgo, fmtDateTime, toast, setBusy, emptyHTML, errorHTML, params } = PawPal;
  const u = await PawPal.booted;
  let kind = params.get('tab') === 'messages' ? 'messages' : 'enquiries';
  let filter = params.get('id') ? '' : 'Open';
  let focusId = params.get('id');
  const drafts = new Map(); // keep half-written replies across auto-refreshes

  const bubble = (m) => `<div class="thread-msg ${m.from === 'staff' ? 'staff' : ''}"><div class="who">${esc(m.from === 'staff' ? `${m.name || 'Staff'} · shelter team` : m.name || 'Adopter')}<span title="${esc(fmtDateTime(m.at))}">${esc(timeAgo(m.at))}</span></div><p>${esc(m.text)}</p></div>`;
  const statusBadge = (s) => `<span class="badge ${s === 'Open' ? 'badge-brand' : s === 'Answered' ? 'badge-sage' : ''}">${s === 'Open' ? 'Needs reply' : esc(s)}</span>`;

  function cardHTML(item) {
    const isEnq = kind === 'enquiries';
    const id = item.id;
    const first = (item.name || '').split(' ')[0] || 'them';
    const about = isEnq
      ? `asked about <a href="pet-profile.html?id=${encodeURIComponent(item.petId)}" target="_blank" rel="noopener">${esc(item.petName)}</a>`
      : `wrote about <b>${esc(item.topic || 'something else')}</b>`;
    return `<article class="card card-pad inbox-item ${item.id === focusId ? 'is-focus' : ''}" id="item-${esc(id)}">
      <div class="row-between" style="align-items:flex-start">
        <div class="row" style="flex-wrap:nowrap;align-items:flex-start"><span class="avatar">${esc(PawPal.initials(item.name))}</span>
          <div><b>${esc(item.name)}</b> ${about}
            <div class="tiny muted"><a href="mailto:${esc(item.email)}">${esc(item.email)}</a> · ${item.userId ? 'Has a PawPal account' : 'Replies go by email only'}${u?.role === 'admin' && item.shelterName ? ` · ${esc(item.shelterName)}` : ''}</div></div></div>
        ${statusBadge(item.status)}</div>
      <div class="msg-thread" style="margin-top:14px">${(item.thread || []).map(bubble).join('')}</div>
      ${item.status !== 'Closed' ? `<form class="stack" style="--stack:8px;margin-top:14px" data-reply="${esc(id)}"><label class="sr-only" for="r-${esc(id)}">Reply to ${esc(first)}</label>
          <textarea class="textarea" id="r-${esc(id)}" style="min-height:84px" maxlength="2000" placeholder="Reply to ${esc(first)} — they'll get an email${item.userId ? ' and a notification' : ''}">${esc(drafts.get(id) || '')}</textarea>
          <div class="row"><button class="btn btn-primary btn-sm" type="submit">${icons.send}Send reply</button><button class="btn btn-ghost btn-sm" type="button" data-close="${esc(id)}">${item.status === 'Open' ? 'Close without reply' : 'Mark as done'}</button></div></form>`
        : '<p class="tiny muted" style="margin-top:12px">Closed. If they write again it reopens here.</p>'}
    </article>`;
  }

  async function load({ quiet = false } = {}) {
    if (quiet && document.querySelector('#enqList textarea:focus')) return; // don't disturb someone typing
    try {
      const [enq, msg] = await Promise.all([PawPalAPI.get('/enquiries', { status: kind === 'enquiries' ? filter : 'Open' }), PawPalAPI.get('/messages', { status: kind === 'messages' ? filter : 'Open' })]);
      $('#nEnq').textContent = enq.open || ''; $('#nMsg').textContent = msg.open || '';
      $('#nOpen').textContent = kind === 'enquiries' ? enq.open : msg.open;
      const items = kind === 'enquiries' ? enq.enquiries : msg.messages;
      $('#enqList').innerHTML = items.length ? items.map(cardHTML).join('')
        : emptyHTML({ icon: 'inbox', title: filter === 'Open' ? 'Nothing waiting for a reply' : 'Nothing here', text: filter === 'Open' ? 'You\'re all caught up. New questions appear here automatically.' : '' });
      $('#refreshNote').textContent = `Updated ${new Date().toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' })}`;
      if (focusId && !quiet) { $(`#item-${CSS.escape(focusId)}`)?.scrollIntoView({ block: 'center', behavior: PawPal.reduceMotion ? 'auto' : 'smooth' }); }
    } catch (err) { if (!quiet) $('#enqList').innerHTML = errorHTML(err.message); }
  }

  const syncTabs = () => {
    $$('#kindTabs [data-kind]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.kind === kind)));
    $$('#enqTabs .tab').forEach((x) => x.setAttribute('aria-selected', String(x.dataset.f === filter)));
  };
  $('#kindTabs').addEventListener('click', (e) => { const b = e.target.closest('[data-kind]'); if (!b) return; kind = b.dataset.kind; focusId = null; syncTabs(); load(); });
  $('#enqTabs').addEventListener('click', (e) => { const t = e.target.closest('[data-f]'); if (!t) return; filter = t.dataset.f; focusId = null; syncTabs(); load(); });
  $('#enqList').addEventListener('input', (e) => { const f = e.target.closest('[data-reply]'); if (f) drafts.set(f.dataset.reply, e.target.value); });
  $('#enqList').addEventListener('submit', async (e) => {
    const f = e.target.closest('[data-reply]'); if (!f) return;
    e.preventDefault();
    const reply = f.querySelector('textarea').value.trim(); if (reply.length < 2) return toast('Write a reply first.', 'error');
    const btn = f.querySelector('button[type=submit]'); setBusy(btn, true, 'Sending…');
    try {
      const r = await PawPalAPI.post(`/${kind}/${encodeURIComponent(f.dataset.reply)}/reply`, { reply });
      drafts.delete(f.dataset.reply); toast(r.message); load(); PawPal.refreshCounts?.();
    } catch (err) { setBusy(btn, false); toast(err.message, 'error'); }
  });
  $('#enqList').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-close]'); if (!b) return;
    try { await PawPalAPI.post(`/${kind}/${encodeURIComponent(b.dataset.close)}/close`); toast('Closed'); load(); PawPal.refreshCounts?.(); } catch (err) { toast(err.message, 'error'); }
  });
  // New questions arrive without a page reload
  setInterval(() => { if (!document.hidden) load({ quiet: true }); }, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load({ quiet: true }); });
  syncTabs();
  load();
})();
