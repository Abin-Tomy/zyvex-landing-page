// api/submit-lead.js — Vercel serverless function
// Handles: Meta CAPI (server-side Lead event) + Zoho CRM lead creation.
// No credentials are returned to the browser; all secrets live in env vars.

'use strict';

const crypto = require('crypto');

/* --- helpers ---------------------------------------------------------------- */

/** SHA-256 hex digest of a normalised string (lowercase, trimmed). */
function sha256(value) {
  if (!value) return undefined;
  return crypto
    .createHash('sha256')
    .update(String(value).trim().toLowerCase())
    .digest('hex');
}

/** Normalise a phone number to E.164: strip non-digits, ensure leading +. */
function normalisePhone(raw) {
  if (!raw) return '';
  const stripped = String(raw).replace(/[^\d+]/g, '');
  return stripped.startsWith('+') ? stripped : '+' + stripped;
}

/* --- Meta CAPI -------------------------------------------------------------- */

/**
 * Fire a server-side "Lead" event to the Meta Conversions API.
 * https://developers.facebook.com/docs/marketing-api/conversions-api
 */
async function sendMetaCapi(payload, req) {
  const pixelId   = process.env.META_PIXEL_ID;
  const capiToken = process.env.META_CAPI_TOKEN;

  if (!pixelId || !capiToken) {
    console.warn('[CAPI] META_PIXEL_ID or META_CAPI_TOKEN not set -- skipping');
    return;
  }

  const { service, event_id, attribution = {} } = payload;

  const eventName = service === 'shopify'
    ? 'ShopifyLead'
    : 'FullStackLead';

  const clientIp = (
    req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || ''
  ).split(',')[0].trim();

  const userAgent = req.headers['user-agent'] || '';

  const fbclid = attribution.fbclid || '';
  const fbc    = fbclid ? `fb.1.${Date.now()}.${fbclid}` : undefined;

  const userData = {
    em: [sha256(payload.email)].filter(Boolean),
    ph: [sha256(normalisePhone(payload.phone))].filter(Boolean),
  };
  if (clientIp)  userData.client_ip_address  = clientIp;
  if (userAgent) userData.client_user_agent  = userAgent;
  if (fbc)       userData.fbc                = fbc;
  if (attribution.fbp) userData.fbp          = attribution.fbp;

  const eventPayload = {
    data: [
      {
        event_name:       eventName,
        event_time:       Math.floor(Date.now() / 1000),
        event_id:         event_id,
        action_source:    'website',
        event_source_url: 'https://in.zyvextech.co' + (payload.page || '/'),
        user_data:        userData,
        custom_data: {
          content_name: service || payload.form || 'unknown',
          value:        25000,
          currency:     'INR',
        },
      },
    ],
  };

  const url =
    'https://graph.facebook.com/v19.0/' +
    pixelId +
    '/events?access_token=' +
    capiToken;

  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(eventPayload),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error('[CAPI] Graph API error:', res.status, text);
  } else {
    const json = await res.json();
    console.info('[CAPI] Success:', JSON.stringify(json));
  }
}

/* --- Zoho CRM --------------------------------------------------------------- */

/** Exchange the stored refresh token for a short-lived access token. */
async function getZohoAccessToken() {
  const params = new URLSearchParams({
    refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    client_id:     process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    grant_type:    'refresh_token',
  });

  const res = await fetch(
    'https://accounts.zoho.in/oauth/v2/token?' + params.toString(),
    { method: 'POST' }
  );

  if (!res.ok) {
    throw new Error('[Zoho] Token refresh failed: HTTP ' + res.status);
  }

  const json = await res.json();
  if (json.error) throw new Error('[Zoho] Token refresh error: ' + json.error);

  return json.access_token;
}

/** Maps the frontend `service` value to the Zoho Lead_Type picklist label. */
const LEAD_TYPE_MAP = {
  full_stack_marketing: 'Full Stack Marketing',
  shopify:             'Shopify Builds',
};

/**
 * Create a Lead record in Zoho CRM (Leads module).
 * Required env vars: ZOHO_REFRESH_TOKEN, ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET.
 */
async function createZohoLead(payload, req) {
  if (
    !process.env.ZOHO_REFRESH_TOKEN ||
    !process.env.ZOHO_CLIENT_ID     ||
    !process.env.ZOHO_CLIENT_SECRET
  ) {
    console.warn('[Zoho] Credentials not configured -- skipping CRM write');
    return;
  }

  const {
    name, email, phone, business, website,
    budget, budget_label, message, service,
    timeline,
    attribution = {},
  } = payload;

  const accessToken = await getZohoAccessToken();

  // Split full name into first / last (Zoho requires at least Last_Name)
  const parts    = (name || '').trim().split(/\s+/);
  const lastName  = parts.length > 1 ? parts.slice(1).join(' ') : (parts[0] || 'Unknown');
  const firstName = parts.length > 1 ? parts[0] : '';

  // Extract client IP, user agent, and fbc using existing logic
  const clientIp = (
    payload.client_ip ||
    (req && req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip']) || '')
  ).split(',')[0].trim();

  const userAgent = payload.user_agent || (req && req.headers && req.headers['user-agent']) || '';

  const fbclid = attribution.fbclid || '';
  const fbc    = attribution.fbc || payload.fbc || (fbclid ? `fb.1.${Date.now()}.${fbclid}` : undefined);

  // Description contains user message and undedicated attribution fields (no duplicate dedicated fields)
  const descParts = [];
  if (message && String(message).trim()) {
    descParts.push(String(message).trim());
  }
  if (attribution.utm_campaign && String(attribution.utm_campaign).trim()) {
    descParts.push('UTM Campaign: ' + String(attribution.utm_campaign).trim());
  }
  if (attribution.utm_medium && String(attribution.utm_medium).trim()) {
    descParts.push('UTM Medium: ' + String(attribution.utm_medium).trim());
  }
  if (attribution.utm_source && String(attribution.utm_source).trim()) {
    descParts.push('UTM Source: ' + String(attribution.utm_source).trim());
  }
  const description = descParts.length > 0 ? descParts.join('\n') : undefined;

  const record = {
    Last_Name:   lastName,
    First_Name:  firstName || undefined,
    Email:       email     || undefined,
    Mobile:      normalisePhone(phone) || phone || undefined,
    Company:     business  || undefined,
    Website:     website   || undefined,
    Lead_Source: 'Meta Ads',
    Lead_Status: 'Not Contacted',
    Lead_Type:   LEAD_TYPE_MAP[service] || undefined,
    Budget:      budget || budget_label || undefined,
    Meta_FBP:    attribution.fbp || undefined,
    Meta_FBCLID: fbclid || undefined,
    Meta_FBC:    fbc || undefined,
    Client_IP:   clientIp || undefined,
    User_Agent:  userAgent || undefined,
    Timeline:    timeline || undefined,
    Description: description,
  };

  // Strip undefined keys so we don't send null values to Zoho
  Object.keys(record).forEach(function(k) {
    if (record[k] === undefined) delete record[k];
  });

  const res = await fetch('https://www.zohoapis.in/crm/v2/Leads', {
    method:  'POST',
    headers: {
      Authorization:  'Zoho-oauthtoken ' + accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ data: [record] }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error('[Zoho] CRM API error:', res.status, text);
  } else {
    const json = await res.json();
    console.info('[Zoho] Lead created:', JSON.stringify(json && json.data && json.data[0]));
  }
}

/* --- Vercel handler --------------------------------------------------------- */

module.exports = async function handler(req, res) {
  // Only accept POST
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // Dynamic CORS: Allow production domain, vercel preview deployments, and local dev
  const origin = req.headers.origin || '';
  const isAllowedOrigin =
    origin === 'https://in.zyvextech.co' ||
    origin.endsWith('.zyvextech.co') ||
    origin.endsWith('.vercel.app') ||
    origin.startsWith('http://localhost:') ||
    origin.startsWith('http://127.0.0.1:');

  res.setHeader('Access-Control-Allow-Origin',  isAllowedOrigin ? origin : 'https://in.zyvextech.co');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  let body;
  try {
    body = typeof req.body === 'object' ? req.body : JSON.parse(req.body);
  } catch (err) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  // Derive service name from the form kind when the frontend does not pass it
  const enrichedPayload = Object.assign({}, body, {
    service:     body.service     || (body.form === 'shopify' ? 'shopify' : 'full_stack_marketing'),
    attribution: body.attribution || {},
  });

  // Fire both integrations concurrently; a failure in one never blocks the other
  const results = await Promise.allSettled([
    sendMetaCapi(enrichedPayload, req),
    createZohoLead(enrichedPayload, req),
  ]);

  results.forEach(function(r, i) {
    if (r.status === 'rejected') {
      console.error('[submit-lead] Integration', i, 'failed:', r.reason);
    }
  });

  return res.status(200).json({ ok: true });
};
