// Vet finder: the nearest clinics listed under the search box (top 3 first, more on request) and a map of every
// surrounding clinic. Clinics come from Google Places when a key is set, otherwise from OpenStreetMap; the map is the
// Google Maps embed either way. Clicking a clinic focuses the map on it.
(async () => {
  const { $, esc, icons } = PawPal;
  await PawPal.booted;
  const cfg = await PawPal.siteConfig;
  const TOP = 3;
  let results = []; let showAll = false; let area = '';

  const embed = (q) => (cfg.mapsEmbedKey
    ? `https://www.google.com/maps/embed/v1/search?key=${encodeURIComponent(cfg.mapsEmbedKey)}&q=${encodeURIComponent(q)}`
    : `https://www.google.com/maps?q=${encodeURIComponent(q)}&output=embed`);
  // The whole neighbourhood of clinics, like a normal "vets near me" map
  const showArea = () => { $('#vetMap').src = embed(`veterinary clinic near ${area}`); $('#mapAll').hidden = true; };
  const showClinic = (v) => { $('#vetMap').src = embed(v.lat && v.lng ? `${v.name} @${v.lat},${v.lng}` : `${v.name} ${v.address}`); $('#mapAll').hidden = false; };

  const km = (d) => (d === undefined || d === null ? '' : d < 1 ? `${Math.round(d * 1000)} m away` : `${d.toFixed(1)} km away`);
  const itemHTML = (v, i) => `<li><button class="vet-item" type="button" data-i="${i}" aria-label="Show ${esc(v.name)} on the map">
      <span class="vet-rank">${i + 1}</span>
      <span class="vet-body"><b>${esc(v.name)}</b>
        <span class="small muted">${esc(v.address || 'Address on the map')}</span>
        <span class="vet-meta">${v.distanceKm !== undefined ? `<span>${icons.pin}${esc(km(v.distanceKm))}</span>` : ''}${v.rating ? `<span>${icons.star}${v.rating} (${v.reviews})</span>` : ''}${v.openNow === true ? '<span class="badge badge-sage">Open now</span>' : v.openNow === false ? '<span class="badge">Closed now</span>' : ''}${v.hours ? `<span>${icons.clock}${esc(v.hours.length > 38 ? `${v.hours.slice(0, 36)}…` : v.hours)}</span>` : ''}</span>
      </span></button>
      <span class="vet-actions">${v.phone ? `<a class="btn btn-sm" href="tel:${esc(v.phone.replace(/[^\d+]/g, ''))}">${icons.phone}Call</a>` : ''}${v.mapsUrl ? `<a class="btn btn-sm" href="${esc(v.mapsUrl)}" target="_blank" rel="noopener">${icons.arrowRight}Directions</a>` : ''}${v.website ? `<a class="btn btn-sm btn-ghost" href="${esc(v.website)}" target="_blank" rel="noopener">${icons.external}Website</a>` : ''}</span></li>`;

  function renderList() {
    const list = showAll ? results : results.slice(0, TOP);
    $('#vetList').innerHTML = list.map(itemHTML).join('');
    $('#vetMore').hidden = results.length <= TOP;
    $('#vetMore').textContent = showAll ? 'Show top 3 only' : `Show ${results.length - TOP} more clinics`;
    $('#vetHeading').textContent = showAll ? `${results.length} nearby clinics` : `Top ${Math.min(TOP, results.length)} nearest clinics`;
  }

  async function search(q, lat, lng) {
    area = lat ? `${lat},${lng}` : (q || 'Melbourne VIC');
    showArea();
    showAll = false;
    $('#vetWhere').textContent = lat ? 'Near your location' : `Near ${q || 'Melbourne VIC'}`;
    $('#vetList').innerHTML = '<li class="skeleton" style="height:96px"></li>'.repeat(3);
    $('#vetMore').hidden = true; $('#vetSource').textContent = '';
    try {
      const r = await PawPalAPI.get('/vets', { q, lat, lng });
      results = r.results || [];
      if (r.center?.label && !lat) $('#vetWhere').textContent = `Near ${r.center.label}`;
      if (!results.length) {
        $('#vetList').innerHTML = `<li class="card card-pad small">${icons.info} ${esc(r.error || 'We couldn\'t list clinics for that search — the map shows the vets around it. Tap one on the map for directions and opening hours.')}</li>`;
        $('#vetHeading').textContent = 'Nearby clinics';
        return;
      }
      renderList();
      $('#vetSource').textContent = r.source === 'google' ? 'Clinic details from Google.' : 'Clinic details © OpenStreetMap contributors. Opening hours can change — call before visiting.';
    } catch (err) {
      $('#vetList').innerHTML = `<li>${PawPal.errorHTML(err.message)}</li>`;
    }
  }

  $('#vetList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-i]'); if (!b) return;
    document.querySelectorAll('.vet-item[aria-current]').forEach((x) => x.removeAttribute('aria-current'));
    b.setAttribute('aria-current', 'true');
    showClinic(results[Number(b.dataset.i)]);
    if (window.innerWidth < 900) $('.vet-map').scrollIntoView({ behavior: PawPal.reduceMotion ? 'auto' : 'smooth', block: 'start' });
  });
  $('#mapAll').addEventListener('click', () => { document.querySelectorAll('.vet-item[aria-current]').forEach((x) => x.removeAttribute('aria-current')); showArea(); });
  $('#vetMore').addEventListener('click', () => { showAll = !showAll; renderList(); });
  $('#vetForm').addEventListener('submit', (e) => { e.preventDefault(); const q = $('#vetQ').value.trim(); if (q) search(q); else $('#vetQ').focus(); });
  $('#nearMe').addEventListener('click', () => {
    if (!navigator.geolocation) return PawPal.toast('Location isn\'t available in this browser.', 'error');
    navigator.geolocation.getCurrentPosition((p) => search('', p.coords.latitude.toFixed(4), p.coords.longitude.toFixed(4)), () => PawPal.toast('We couldn\'t get your location. Try searching by suburb.', 'error'));
  });
  const start = PawPal.params.get('q') || 'Melbourne VIC';
  $('#vetQ').value = PawPal.params.get('q') || '';
  search(start);
})();
