// server.js (CommonJS)
// Updated to avoid the model refusing to reply and to give friendly conversational behavior.
// - Uses a clear system instruction that tells the model to ALWAYS respond helpfully as "Gconnect assistant".
// - Trims history to MAX_HISTORY.
// - Avoids returning raw HF JSON as the reply text; uses a safe fallback if the model returns empty content.
// - Detects YouTube links and returns embedUrl.
// - If DEBUG=true in env, raw HF result is also returned (useful for debugging); otherwise not included.

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fetch = require('node-fetch'); // node-fetch v2
require('dotenv').config();

const app = express();
app.use(cors({
  origin: process.env.FRONTEND_ORIGIN || '*' // আপনি ডিপ্লয় শেষে FRONTEND_ORIGIN দিয়ে সীমাবদ্ধ করতে পারেন
}));
app.use(bodyParser.json({ limit: '512kb' }));

// Configuration
const MAX_HISTORY = 20; // সর্বোচ্চ বার্তা যা আমরা HF এ পাঠাবো (সংক্ষিপ্ত ইতিহাস)
const DEFAULT_SYSTEM_INSTRUCTION = `You are "Gconnect assistant", a friendly and helpful conversational assistant. Always respond directly and helpfully to user messages, keeping context from previous messages in this chat. Do not refuse to respond just because a message is short or casual (for example "hello"). Never output raw internal JSON, tool calls, or metadata in the assistant response — produce only a natural-language reply (and optionally structured fields like an embedUrl for YouTube). If the user asks about a YouTube video or a YouTube link appears in context, provide a short helpful answer and include the embed URL (https://www.youtube.com/embed/VIDEO_ID) when appropriate. Keep responses concise, polite, and relevant.`;

// your provided query function (uses process.env.HF_TOKEN)
async function query(data) {
  const response = await fetch(
    "https://router.huggingface.co/v1/chat/completions",
    {
      headers: {
        Authorization: `Bearer ${process.env.HF_TOKEN}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      body: JSON.stringify(data),
    }
  );
  const result = await response.json();
  return result;
}

// utility: ensure there's a system instruction at the start
function prepareMessages(incomingMessages) {
  const msgs = Array.isArray(incomingMessages) ? incomingMessages.slice() : [];
  const hasSystem = msgs.some(m => m && m.role === 'system');
  if (!hasSystem) {
    // prepend system instruction
    msgs.unshift({ role: 'system', content: DEFAULT_SYSTEM_INSTRUCTION });
  }
  // trim to last MAX_HISTORY messages (preserve system at index 0)
  if (msgs.length > MAX_HISTORY) {
    if (msgs[0] && msgs[0].role === 'system') {
      const keep = Math.max(1, MAX_HISTORY);
      const tail = msgs.slice(- (keep - 1)); // last keep-1 items (user/assistant)
      return [msgs[0], ...tail];
    } else {
      return msgs.slice(-MAX_HISTORY);
    }
  }
  return msgs;
}

// utility: parse HF response into a reply text (robust)
function extractReplyText(hfResp) {
  try {
    if (hfResp && hfResp.choices && hfResp.choices[0] && hfResp.choices[0].message && hfResp.choices[0].message.content) {
      const txt = hfResp.choices[0].message.content;
      if (txt && String(txt).trim().length > 0) return String(txt).trim();
      return null;
    } else if (hfResp && hfResp.output && Array.isArray(hfResp.output) && hfResp.output[0] && hfResp.output[0].content) {
      const txt = hfResp.output[0].content;
      if (txt && String(txt).trim().length > 0) return String(txt).trim();
      return null;
    } else if (hfResp && hfResp.choices && hfResp.choices[0] && hfResp.choices[0].text) {
      const txt = hfResp.choices[0].text;
      if (txt && String(txt).trim().length > 0) return String(txt).trim();
      return null;
    } else {
      return null;
    }
  } catch (e) {
    return null;
  }
}

// utility: detect youtube video id and return embed url or null
function detectYouTubeEmbed(text) {
  if (!text || typeof text !== 'string') return null;
  const ytRegex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{11})/i;
  const m = text.match(ytRegex);
  if (m && m[1]) {
    return `https://www.youtube.com/embed/${m[1]}`;
  }
  return null;
}

app.get('/', (req, res) => res.json({ ok: true, service: 'gconnect-proxy' }));

app.post('/api/query', async (req, res) => {
  try {
    if (!process.env.HF_TOKEN) return res.status(500).json({ error: 'HF_TOKEN not set on server' });

    const body = req.body || {};
    // Accept either body.messages (array) or body.message (string)
    let messages = [];
    if (Array.isArray(body.messages) && body.messages.length) {
      messages = body.messages;
    } else if (body.message && typeof body.message === 'string') {
      messages = [{ role: 'user', content: body.message }];
    } else {
      return res.status(400).json({ error: 'Provide messages array or message string' });
    }

    // Prepare messages: inject default system instruction if missing, and trim history
    const prepared = prepareMessages(messages);

    // Build payload for HF
    const payload = Object.assign({}, body);
    payload.messages = prepared;
    payload.model = payload.model || 'openai/gpt-oss-120b:together';

    // Make request to HF router
    const hfResp = await query(payload);

    // extract reply
    let replyText = extractReplyText(hfResp);

    // If model returned no text, provide a safe fallback (avoid sending raw HF JSON to users)
    if (!replyText) {
      // fallback message
      replyText = "দুঃখিত — আপাতত সঠিক উত্তর পাওয়া যাচ্ছে না। অনুগ্রহ করে একটু ভিন্নভাবে জিজ্ঞাসা করুন।";
    }

    // detect youtube embed url (if any) from replyText
    const embedUrl = detectYouTubeEmbed(replyText);

    // Build response payload
    const responsePayload = { replyText };
    if (embedUrl) responsePayload.embedUrl = embedUrl;

    // Optionally include raw result if DEBUG=true (do not expose in production)
    if (process.env.DEBUG === 'true') {
      responsePayload.result = hfResp;
    }

    return res.json(responsePayload);
  } catch (err) {
    console.error('Error /api/query:', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Server error' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log(`Gconnect proxy listening on ${PORT}`));
