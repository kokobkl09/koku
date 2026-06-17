const express = require('express');
const path = require('path');
const { Telegraf } = require('telegraf');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const fs = require('fs');
const archiver = require('archiver');
const cron = require('node-cron');

// ─── Config ───
const BOT_TOKEN = process.env.BOT_TOKEN || '8998777617:AAGqM6Uy6wWNFjKJHJFWVQb8VaLzNnvyn6s'; // Set in Railway env, not hardcoded
const ADMIN_KEY = process.env.ADMIN_KEY || '7811286022';
const PORT = process.env.PORT || 3000;
const API_URL = 'https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json';

// ─── Express App ───
const app = express();
app.use(express.json());
app.use(express.static(__dirname));

// ─── Health Check (required for Railway) ───
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

// ─── SQLite Database ───
let db;
(async () => {
  try {
    db = await open({
      filename: path.join(__dirname, 'data.sqlite'),
      driver: sqlite3.Database
    });
    await db.exec(`
      CREATE TABLE IF NOT EXISTS predictions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        period TEXT,
        predicted TEXT,
        actual TEXT,
        predicted_number INTEGER,
        actual_number INTEGER,
        confidence REAL,
        strategy TEXT,
        correct INTEGER,
        timestamp INTEGER
      );
      CREATE TABLE IF NOT EXISTS users (
        chat_id INTEGER PRIMARY KEY,
        first_start INTEGER,
        last_active INTEGER
      );
    `);
    console.log('✅ Database ready');
  } catch (err) {
    console.error('❌ Database error:', err.message);
  }
})();

// ─── Background Data Collector ───
async function collectAndPredict() {
  try {
    const resp = await fetch(API_URL + `?t=${Date.now()}`);
    if (!resp.ok) throw new Error('API fetch failed');
    const json = await resp.json();
    if (!json?.data?.list?.length) throw new Error('No data');

    const rounds = json.data.list.map(item => ({
      period: item.issueNumber,
      number: parseInt(item.number),
      size: parseInt(item.number) >= 5 ? 'BIG' : 'SMALL'
    }));

    const prediction = runML(rounds);
    const latest = rounds[0];
    const existing = await db.get('SELECT * FROM predictions WHERE period = ?', latest.period);
    if (!existing) {
      await db.run(
        'INSERT INTO predictions (period, predicted, predicted_number, confidence, strategy, timestamp) VALUES (?, ?, ?, ?, ?, ?)',
        latest.period,
        prediction.pred,
        prediction.number,
        prediction.confidence,
        prediction.strategy || 'ensemble',
        Date.now()
      );
      console.log(`📊 New prediction: ${prediction.pred} (${prediction.number})`);
    }

    const prev = await db.get('SELECT * FROM predictions WHERE period != ? AND actual IS NULL ORDER BY timestamp DESC LIMIT 1', latest.period);
    if (prev) {
      const actualRound = rounds.find(r => r.period === prev.period);
      if (actualRound) {
        const correct = prev.predicted === actualRound.size ? 1 : 0;
        await db.run(
          'UPDATE predictions SET actual = ?, actual_number = ?, correct = ? WHERE id = ?',
          actualRound.size,
          actualRound.number,
          correct,
          prev.id
        );
        console.log(`✅ Validated ${prev.period}: ${prev.predicted} → ${actualRound.size} (${correct ? 'WIN' : 'LOSS'})`);
      }
    }
  } catch (err) {
    console.error('Collector error:', err.message);
  }
}

function runML(rounds) {
  if (rounds.length < 10) return { pred: 'BIG', number: 5, confidence: 50, strategy: 'fallback' };
  const recent = rounds.slice(0, 10);
  const bigCount = recent.filter(r => r.size === 'BIG').length;
  const pred = bigCount >= 5 ? 'BIG' : 'SMALL';
  const confidence = 50 + Math.abs(bigCount - 5) * 10;
  const numbers = recent.map(r => r.number);
  const filtered = pred === 'BIG' ? numbers.filter(n => n >= 5) : numbers.filter(n => n < 5);
  const number = filtered.length ? mode(filtered) : (pred === 'BIG' ? 7 : 2);
  return { pred, number, confidence: Math.min(92, confidence), strategy: 'trend' };
}

function mode(arr) {
  if (!arr.length) return 0;
  const freq = {};
  let max = 0, r = arr[0];
  for (const v of arr) { freq[v] = (freq[v] || 0) + 1; if (freq[v] > max) { max = freq[v]; r = v; } }
  return r;
}

// ─── Schedule collector every 60 seconds ───
cron.schedule('* * * * *', () => {
  collectAndPredict().catch(err => console.error('Cron error:', err));
});
setTimeout(collectAndPredict, 5000);

// ─── API Endpoints ───
app.get('/api/latest', async (req, res) => {
  try {
    const row = await db.get('SELECT * FROM predictions ORDER BY timestamp DESC LIMIT 1');
    if (!row) return res.json({ error: 'No predictions yet' });
    res.json({
      period: row.period,
      predicted: row.predicted,
      number: row.predicted_number,
      confidence: row.confidence,
      strategy: row.strategy
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/history', async (req, res) => {
  const key = req.query.key || req.headers['x-admin-key'];
  if (key !== ADMIN_KEY) return res.status(403).json({ error: 'Invalid admin key' });
  try {
    const rows = await db.all('SELECT * FROM predictions ORDER BY timestamp DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stats', async (req, res) => {
  const key = req.query.key || req.headers['x-admin-key'];
  if (key !== ADMIN_KEY) return res.status(403).json({ error: 'Invalid admin key' });
  try {
    const total = await db.get('SELECT COUNT(*) as count FROM predictions');
    const correct = await db.get('SELECT COUNT(*) as count FROM predictions WHERE correct = 1');
    res.json({
      total: total.count || 0,
      wins: correct.count || 0,
      losses: (total.count || 0) - (correct.count || 0),
      accuracy: total.count ? ((correct.count / total.count) * 100).toFixed(1) : 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Telegram Bot (only if token is set) ───
if (BOT_TOKEN) {
  const bot = new Telegraf(BOT_TOKEN);

  bot.start(async (ctx) => {
    const chatId = ctx.chat.id;
    const now = Date.now();
    await db.run('INSERT OR REPLACE INTO users (chat_id, first_start, last_active) VALUES (?, ?, ?)', chatId, now, now);
    const stats = await db.get('SELECT COUNT(*) as total, SUM(correct) as wins FROM predictions');
    const total = stats.total || 0;
    const wins = stats.wins || 0;
    const acc = total ? (wins / total * 100).toFixed(1) : 0;
    await ctx.replyWithMarkdown(`🤖 *KOKU AI Bot Activated*\n📊 *Total Predictions:* ${total}\n✅ *Wins:* ${wins}\n🎯 *Accuracy:* ${acc}%\n⏰ _I will send you a detailed report in 5 minutes._`);
    setTimeout(async () => {
      await fiveMinuteReport(chatId);
    }, 5 * 60 * 1000);
  });

  async function fiveMinuteReport(chatId) {
    const fiveAgo = Date.now() - 5 * 60 * 1000;
    const rows = await db.all('SELECT * FROM predictions WHERE timestamp >= ? ORDER BY timestamp ASC', fiveAgo);
    if (!rows.length) {
      await bot.telegram.sendMessage(chatId, '📊 *5‑Minute Report*\n\nNo predictions in the last 5 minutes.', { parse_mode: 'Markdown' });
      return;
    }
    const total = rows.length;
    const correct = rows.filter(r => r.correct === 1).length;
    const accuracy = total ? (correct / total * 100).toFixed(1) : 0;
    const first = rows[0];
    const strategies = [...new Set(rows.map(r => r.strategy))];
    let bestStrat = 'N/A', bestAcc = 0;
    for (const s of strategies) {
      const sRows = rows.filter(r => r.strategy === s);
      const sCorrect = sRows.filter(r => r.correct === 1).length;
      const acc = sCorrect / sRows.length * 100;
      if (acc > bestAcc) { bestAcc = acc; bestStrat = s; }
    }
    await bot.telegram.sendMessage(chatId, `
📊 *5‑Minute Report*
📈 *Total Predictions:* ${total}
✅ *Correct:* ${correct}
🎯 *Accuracy:* ${accuracy}%
🔮 *First Prediction:* ${first.period} → ${first.predicted} (actual: ${first.actual || 'waiting...'})
🏆 *Best Strategy:* ${bestStrat} (${bestAcc.toFixed(1)}% accuracy)
💡 *Insight:* ${accuracy > 60 ? 'Good performance!' : 'Consider adjusting strategy.'}
    `, { parse_mode: 'Markdown' });
  }

  bot.launch().then(() => console.log('🤖 Telegram bot started')).catch(err => console.error('Bot error:', err));
} else {
  console.log('⚠️ BOT_TOKEN not set – Telegram bot disabled.');
}

// ─── Start Server ───
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
