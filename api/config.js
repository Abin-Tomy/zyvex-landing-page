// api/config.js — Vercel serverless function
// Exposes non-secret, runtime-resolved client config.
// The Pixel ID is intentionally public (it is visible in every network
// request to facebook.net), but we keep it out of the source code so
// a single Vercel env-var update is all that is ever needed.

'use strict';

module.exports = function handler(req, res) {
  // Allow any origin — the response contains no secrets.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=300'); // cache 5 min

  res.status(200).json({
    pixelId: process.env.META_PIXEL_ID || '',
  });
};
