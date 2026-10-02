// FR-11 Find Nearby Veterinary Clinics.
// With GOOGLE_MAPS_API_KEY: clinic list from Google Places API (New).
// Without a key: free OpenStreetMap data — Nominatim finds the suburb, Overpass lists veterinary clinics around it.
// Either way the page also shows the Google Maps embed with every surrounding clinic, and results are sorted by distance.
const config = require('../config');

const mapsEnabled = Boolean(config.mapsKey);
let fetchImpl = (...args) => fetch(...args); // swapped out by the tests (no network there)
const setFetch = (fn) => { fetchImpl = fn; };

// OpenStreetMap services ask apps to identify themselves and to cache — results are kept for an hour
const userAgent = () => `PawPal/1.0 (pet adoption; ${config.contactEmail})`;
const cache = new Map();
const cached = async (key, fn) => {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 60 * 60 * 1000) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return value;
};

// Great-circle distance in km
function distanceKm(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}
const directions = (v) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(v.lat && v.lng ? `${v.name} ${v.lat},${v.lng}` : `${v.name} ${v.address}`)}`;

async function googleVets({ query, lat, lng }) {
  const body = { textQuery: query ? `veterinary clinic near ${query}` : 'veterinary clinic', includedType: 'veterinary_care', maxResultCount: 10 };
  if (lat && lng) body.locationBias = { circle: { center: { latitude: Number(lat), longitude: Number(lng) }, radius: 8000 } };
  const res = await fetchImpl('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': config.mapsKey,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.nationalPhoneNumber,places.currentOpeningHours.openNow,places.googleMapsUri,places.location',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Google Places error ${res.status}`);
  const data = await res.json();
  const center = lat && lng ? { lat: Number(lat), lng: Number(lng) } : null;
  const results = (data.places || []).map((p) => ({
    id: p.id, name: p.displayName?.text || 'Veterinary clinic', address: p.formattedAddress || '',
    rating: p.rating || null, reviews: p.userRatingCount || 0, phone: p.nationalPhoneNumber || '',
    openNow: p.currentOpeningHours?.openNow ?? null, mapsUrl: p.googleMapsUri || '', lat: p.location?.latitude, lng: p.location?.longitude,
  }));
  if (center) results.forEach((r) => { if (r.lat) r.distanceKm = Math.round(distanceKm(center, r) * 10) / 10; });
  return { enabled: true, source: 'google', center, results };
}

// Suburb, postcode or address → coordinates (Australia only)
async function geocode(query) {
  return cached(`geo:${query.toLowerCase()}`, async () => {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=au&q=${encodeURIComponent(query)}`;
    const res = await fetchImpl(url, { headers: { 'User-Agent': userAgent(), 'Accept-Language': 'en' }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`Geocoding error ${res.status}`);
    const [hit] = await res.json();
    return hit ? { lat: Number(hit.lat), lng: Number(hit.lon), label: String(hit.display_name || query).split(',').slice(0, 2).join(',') } : null;
  });
}

const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
async function overpass(queryText) {
  let lastErr;
  for (const url of OVERPASS) {
    try {
      const res = await fetchImpl(url, { method: 'POST', headers: { 'User-Agent': userAgent(), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(queryText)}`, signal: AbortSignal.timeout(15000) });
      if (res.ok) return res.json();
      lastErr = new Error(`Overpass error ${res.status}`);
    } catch (err) { lastErr = err; }
  }
  throw lastErr;
}

// Veterinary clinics around a point, widening the search until there are at least three
async function osmVets(center) {
  return cached(`vets:${center.lat.toFixed(3)},${center.lng.toFixed(3)}`, async () => {
    let found = [];
    for (const radius of [4000, 12000, 30000]) {
      const data = await overpass(`[out:json][timeout:20];nwr["amenity"="veterinary"](around:${radius},${center.lat},${center.lng});out center tags 60;`);
      found = (data.elements || []).map((el) => {
        const t = el.tags || {};
        const lat = el.lat ?? el.center?.lat; const lng = el.lon ?? el.center?.lon;
        const street = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ');
        const address = [street, t['addr:suburb'] || t['addr:city'], t['addr:state'], t['addr:postcode']].filter(Boolean).join(', ');
        const v = { id: `osm-${el.type}-${el.id}`, name: t.name || '', address, phone: t.phone || t['contact:phone'] || '',
          website: t.website || t['contact:website'] || '', hours: t.opening_hours || '', lat, lng, rating: null, openNow: null };
        return lat && lng ? { ...v, distanceKm: Math.round(distanceKm(center, { lat, lng }) * 10) / 10, mapsUrl: directions(v) } : null;
      }).filter((v) => v && v.name);
      if (found.length >= 3) break;
    }
    return found.sort((a, b) => a.distanceKm - b.distanceKm).slice(0, 10);
  });
}

async function findVets({ query, lat, lng }) {
  if (mapsEnabled) return googleVets({ query, lat, lng });
  const center = lat && lng ? { lat: Number(lat), lng: Number(lng), label: 'your location' } : await geocode(query || 'Melbourne VIC');
  if (!center || !Number.isFinite(center.lat)) return { enabled: true, source: 'openstreetmap', center: null, results: [], error: `We couldn't find "${query}". Try a suburb name or postcode.` };
  return { enabled: true, source: 'openstreetmap', center, results: await osmVets(center) };
}

module.exports = { findVets, mapsEnabled, distanceKm, setFetch };
