import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI, { toFile } from 'openai';
import { TEACHERS, LEVELS } from './teachers.js';
import { buildSystemPrompt, parseTeacherJson } from './prompt.js';

const PORT = process.env.PORT || 3000;
const APP_TOKEN = process.env.APP_TOKEN || '';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const AUDIO_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'teacher-audio-'));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Озвучка отдаётся по неугадываемой ссылке, поэтому раздаём её до проверки токена
// (плеер в приложении не умеет слать свои заголовки).
app.use('/audio', express.static(AUDIO_DIR, { maxAge: '10m' }));

// --- Защита: общий секрет + простое ограничение частоты запросов ---
app.use((req, res, next) => {
  if (APP_TOKEN && req.get('x-app-token') !== APP_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});

const hits = new Map();
app.use((req, res, next) => {
  const now = Date.now();
  const windowMs = 60_000;
  const limit = 40;
  const list = (hits.get(req.ip) || []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(req.ip, list);
  if (list.length > limit) return res.status(429).json({ error: 'too_many_requests' });
  next();
});

app.get('/health', (_req, res) => res.json({ ok: true }));

// --- Чат с учителем ---
app.post('/chat', async (req, res) => {
  try {
    const { teacherId, level = 'A2', messages = [] } = req.body || {};
    if (!TEACHERS[teacherId]) return res.status(400).json({ error: 'unknown_teacher' });
    if (!LEVELS.includes(level)) return res.status(400).json({ error: 'unknown_level' });

    // История с клиента: чередование assistant/user, начиная с приветствия учителя.
    let history = (Array.isArray(messages) ? messages : [])
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .slice(-24);
    if (history.length && history[0].role === 'user') history = history.slice(1);

    const apiMessages = [
      { role: 'user', content: 'Please start the lesson: greet me briefly and ask a first easy question.' },
      ...history.map((m) =>
        m.role === 'assistant'
          ? { role: 'assistant', content: JSON.stringify({ reply: m.content.trim(), correction: '', hint: '', newWords: [], task: '' }) }
          : { role: 'user', content: m.content.trim().slice(0, 2000) }
      ),
    ];

    const response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 700,
      system: buildSystemPrompt(teacherId, level),
      messages: apiMessages,
    });

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    res.json(parseTeacherJson(text));
  } catch (err) {
    console.error('chat error:', err?.message || err);
    res.status(500).json({ error: 'chat_failed' });
  }
});

// --- Речь -> текст ---
app.post('/transcribe', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'no_audio' });
    const ext = (req.file.originalname.split('.').pop() || 'm4a').toLowerCase();
    const file = await toFile(req.file.buffer, `speech.${ext}`, { type: req.file.mimetype || 'audio/m4a' });
    const result = await openai.audio.transcriptions.create({
      file,
      model: 'gpt-4o-mini-transcribe',
      language: 'en',
    });
    res.json({ text: (result.text || '').trim() });
  } catch (err) {
    console.error('transcribe error:', err?.message || err);
    res.status(500).json({ error: 'transcribe_failed' });
  }
});

// --- Текст -> голос учителя ---
app.post('/speak', async (req, res) => {
  try {
    const { teacherId, text } = req.body || {};
    const teacher = TEACHERS[teacherId];
    if (!teacher) return res.status(400).json({ error: 'unknown_teacher' });
    if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'no_text' });

    const speech = await openai.audio.speech.create({
      model: 'gpt-4o-mini-tts',
      voice: teacher.voice,
      input: text.trim().slice(0, 1000),
      instructions: teacher.ttsStyle,
      response_format: 'mp3',
    });
    const buffer = Buffer.from(await speech.arrayBuffer());
    const id = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(path.join(AUDIO_DIR, `${id}.mp3`), buffer);

    res.json({ url: `${req.protocol}://${req.get('host')}/audio/${id}.mp3` });
  } catch (err) {
    console.error('speak error:', err?.message || err);
    res.status(500).json({ error: 'speak_failed' });
  }
});

// Удаляем старые аудиофайлы каждые 5 минут
setInterval(() => {
  const cutoff = Date.now() - 10 * 60_000;
  for (const f of fs.readdirSync(AUDIO_DIR)) {
    const p = path.join(AUDIO_DIR, f);
    try {
      if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
    } catch {}
  }
}, 5 * 60_000).unref();

app.listen(PORT, () => console.log(`Teachers server on :${PORT} (model ${CLAUDE_MODEL})`));
