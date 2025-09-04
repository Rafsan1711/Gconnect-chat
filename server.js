// server.js (CommonJS)
// হালকা আপডেট: system instruction inject, history trimming, youtube detection in response

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
const DEFAULT_SYSTEM_INSTRUCTION = `You are "Gconnect assistant". Behave as a friendly, helpful assistant. Keep conversational context between messages: remember previous messages in this chat and use them when answering. When a user mentions or pastes a YouTube link or asks about a YouTube video, respond by returning an embedded iframe link (use embed URL like https://www.youtube.com/embed/VIDEO_ID) and keep a short textual context. Keep answers concise and friendly. Do not invent personal data.`;

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
  // trim to last MAX_HISTORY messages (keep system at start)
  // if system was added, we want to keep system + last (MAX_HISTORY - 1) user/assistant entries
  let startIndex = 0;
  if (msgs.length > MAX_HISTORY) {
    // preserve the first element only if it is system
    if (msgs[0] && msgs[0].role === 'system') {
      const keep = Math.max(1, MAX_HISTORY);
      const tail = msgs.slice(- (keep - 1)); // last keep-1 items
      return [msgs[0], ...tail];
    } else {
      return msgs.slice(-MAX_HISTORY);
    }
  }
  return msgs;
}

// utility: parse HF response into a reply text (robust)
function extractReplyText(hfResp) {
  let replyText = '';
  try {
    if (hfResp && hfResp.choices && hfResp.choices[0] && hfResp.choices[0].message && hfResp.choices[0].message.content) {
      replyText = hfResp.choices[0].message.content;
    } else if (hfResp && hfResp.output && Array.isArray(hfResp.output) && hfResp.output[0] && hfResp.output[0].content) {
      replyText = hfResp.output[0].content;
    } else if (hfResp && hfResp.choices && hfResp.choices[0] && hfResp.choices[0].text) {
      replyText = hfResp.choices[0].text;
    } else {
      replyText = JSON.stringify(hfResp).slice(0, 2000);
    }
  } catch (e) {
    replyText = 'Unable to parse HF response';
  }
  return replyText;
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
    const replyText = extractReplyText(hfResp);

    // detect youtube embed url (if any) from replyText
    const embedUrl = detectYouTubeEmbed(replyText);

    // Also, optionally, if HF returned structured fields, include them
    const responsePayload = { result: hfResp, replyText };
    if (embedUrl) responsePayload.embedUrl = embedUrl;

    return res.json(responsePayload);
  } catch (err) {
    console.error('Error /api/query:', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Server error' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log(`Gconnect proxy listening on ${PORT}`));
