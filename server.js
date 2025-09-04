// server.js (CommonJS)
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

app.get('/', (req, res) => res.json({ ok: true, service: 'gconnect-proxy' }));

app.post('/api/query', async (req, res) => {
  try {
    if (!process.env.HF_TOKEN) return res.status(500).json({ error: 'HF_TOKEN not set on server' });

    const body = req.body || {};
    let messages = [];
    if (Array.isArray(body.messages) && body.messages.length) messages = body.messages;
    else if (body.message && typeof body.message === 'string') messages = [{ role: 'user', content: body.message }];
    else return res.status(400).json({ error: 'Provide messages array or message string' });

    const payload = Object.assign({}, body);
    payload.messages = messages;
    payload.model = payload.model || 'openai/gpt-oss-120b:together';

    const hfResp = await query(payload);

    // extract reply
    let replyText = '';
    try {
      if (hfResp.choices && hfResp.choices[0] && hfResp.choices[0].message && hfResp.choices[0].message.content) {
        replyText = hfResp.choices[0].message.content;
      } else if (hfResp.output && Array.isArray(hfResp.output) && hfResp.output[0] && hfResp.output[0].content) {
        replyText = hfResp.output[0].content;
      } else if (hfResp.choices && hfResp.choices[0] && hfResp.choices[0].text) {
        replyText = hfResp.choices[0].text;
      } else {
        replyText = JSON.stringify(hfResp).slice(0, 2000);
      }
    } catch (e) {
      replyText = 'Unable to parse HF response';
    }

    return res.json({ result: hfResp, replyText });
  } catch (err) {
    console.error('Error /api/query:', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Server error' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log(`Gconnect proxy listening on ${PORT}`));
