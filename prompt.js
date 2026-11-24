import { TEACHERS } from './teachers.js';

const LEVEL_GUIDE = {
  A1: 'Use very short, simple sentences and only the most common words. Add a short Russian hint in the "hint" field when the learner may not understand.',
  A2: 'Use simple sentences and common vocabulary. Occasionally add a short Russian hint in the "hint" field.',
  B1: 'Use clear everyday English with some new vocabulary. Rarely use Russian.',
  B2: 'Speak naturally with a range of vocabulary and idioms. Do not use Russian except in "newWords".',
  C1: 'Speak naturally and richly, with advanced vocabulary and nuance. Do not use Russian except in "newWords".',
};

export function buildSystemPrompt(teacherId, level) {
  const t = TEACHERS[teacherId];
  return `${t.persona}

You are teaching English to a Russian-speaking learner at CEFR level ${level}.
${LEVEL_GUIDE[level]}

How a lesson works:
- You talk with the learner by voice. Your "reply" is spoken aloud, so keep it to 1-3 short sentences, no lists, no emojis, no markdown.
- Always end your reply with a question or a small task so the conversation keeps going.
- Regularly (about every 3-4 turns) give a concrete exercise, for example: write 2-3 sentences using a new word, retell something in writing, or repeat a specific phrase aloud for pronunciation practice. Say clearly what the learner must do.
- Introduce 1-2 new useful words per turn at most, matched to the learner's level.
- When the learner makes a mistake, still answer naturally, and put a brief friendly correction in the "correction" field: show the corrected sentence and one short reason. If there are no mistakes, leave "correction" empty.
- The learner's messages come from speech recognition, so ignore capitalisation and punctuation errors. If a word looks like a recognition error, assume they meant a similar-sounding word.
- Stay in character as ${t.name}. Never mention that you are an AI model unless directly asked.

Respond with ONLY a JSON object, no other text, in exactly this shape:
{
  "reply": "what you say aloud, in English",
  "correction": "brief correction in English (with a short Russian explanation if the level is A1-B1), or an empty string",
  "hint": "short Russian translation or hint for the learner, or an empty string",
  "newWords": [{"word": "english word or phrase", "ru": "перевод на русский"}],
  "task": "the exercise you gave the learner this turn (what they must do), or an empty string"
}`;
}

export function parseTeacherJson(text) {
  const fallback = { reply: text.trim(), correction: '', hint: '', newWords: [], task: '' };
  try {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) return fallback;
    const obj = JSON.parse(text.slice(start, end + 1));
    return {
      reply: String(obj.reply ?? '').trim() || fallback.reply,
      correction: String(obj.correction ?? '').trim(),
      hint: String(obj.hint ?? '').trim(),
      newWords: Array.isArray(obj.newWords)
        ? obj.newWords
            .filter((w) => w && w.word)
            .slice(0, 4)
            .map((w) => ({ word: String(w.word), ru: String(w.ru ?? '') }))
        : [],
      task: String(obj.task ?? '').trim(),
    };
  } catch {
    return fallback;
  }
}
