// ============================================================
// ADAPTIVE STREAK INTELLIGENCE ENGINE – NODE.JS BACKEND
// - Persists history in data/history.json
// - HTTP API: POST /outcome, GET /prediction, GET /status, POST /alert, POST /reset
// - Resend email alerts
// - Sends one startup email after 5 minutes
// ============================================================

const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const fetch = require('node-fetch');

// ============ CONFIGURATION ============
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

// Resend API – use environment variable or fallback (modified key provided)
const RESEND_API_KEY = process.env.RESEND_API_KEY || 're_3R13fyxC_6UStikC6Vsnn9RZECcqPYuUo';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'jurohan38@gmail.com'; // CHANGE THIS

// ============ ENGINE CLASS ============
class StreakEngine {
  constructor() {
    this.history = [];
    this.streakData = {};
    this.totalStreakSamples = 0;
    this.minSamples = 20;
    this.lastResult = null;
    this.currentStreak = 0;
    this.currentDirection = null;
    this.prediction = null;
    this.confidence = 0;
    this.evidenceScore = 0;
    this.transitions = { BIG: { BIG: 0, SMALL: 0 }, SMALL: { BIG: 0, SMALL: 0 } };
  }

  // Load history from file
  async loadHistory() {
    try {
      const data = await fs.readFile(HISTORY_FILE, 'utf-8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) {
        this.history = parsed;
        this._rebuildFromHistory();
      }
    } catch (err) {
      this.history = [];
    }
  }

  // Save history to file
  async saveHistory() {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(HISTORY_FILE, JSON.stringify(this.history, null, 2));
  }

  _rebuildFromHistory() {
    this.streakData = {};
    this.totalStreakSamples = 0;
    this.transitions = { BIG: { BIG: 0, SMALL: 0 }, SMALL: { BIG: 0, SMALL: 0 } };
    if (this.history.length === 0) {
      this.lastResult = null;
      this.currentStreak = 0;
      this.currentDirection = null;
      return;
    }

    let streakLen = 1;
    let streakDir = this.history[0];
    for (let i = 1; i < this.history.length; i++) {
      const current = this.history[i];
      if (current === streakDir) {
        streakLen++;
      } else {
        this._recordStreak(streakLen, streakDir, false);
        streakLen = 1;
        streakDir = current;
      }
      const prev = this.history[i-1];
      if (!this.transitions[prev]) this.transitions[prev] = { BIG: 0, SMALL: 0 };
      this.transitions[prev][current] = (this.transitions[prev][current] || 0) + 1;
    }

    this.lastResult = this.history[this.history.length - 1];
    let len = 1, dir = this.lastResult;
    for (let i = this.history.length - 2; i >= 0; i--) {
      if (this.history[i] === dir) len++;
      else break;
    }
    this.currentStreak = len;
    this.currentDirection = dir;
  }

  _recordStreak(length, direction, wasContinued) {
    if (length === 0) return;
    const key = length;
    if (!this.streakData[key]) {
      this.streakData[key] = { continuations: 0, reversals: 0 };
    }
    if (wasContinued) this.streakData[key].continuations++;
    else this.streakData[key].reversals++;
    this.totalStreakSamples++;
  }

  async addOutcome(outcome) {
    if (outcome !== 'BIG' && outcome !== 'SMALL') return;

    if (this.lastResult === outcome) {
      this.currentStreak++;
    } else {
      if (this.currentStreak > 0 && this.lastResult) {
        this._recordStreak(this.currentStreak, this.lastResult, false);
      }
      this.currentStreak = 1;
      this.currentDirection = outcome;
    }

    if (this.lastResult) {
      if (!this.transitions[this.lastResult]) this.transitions[this.lastResult] = { BIG: 0, SMALL: 0 };
      this.transitions[this.lastResult][outcome] = (this.transitions[this.lastResult][outcome] || 0) + 1;
    }

    this.history.push(outcome);
    this.lastResult = outcome;

    await this.saveHistory();
    this.predict();
  }

  getCurrentStreak() {
    if (this.history.length === 0) return { length: 0, direction: null };
    let len = 1, dir = this.history[this.history.length - 1];
    for (let i = this.history.length - 2; i >= 0; i--) {
      if (this.history[i] === dir) len++;
      else break;
    }
    return { length: len, direction: dir };
  }

  predict() {
    const streak = this.getCurrentStreak();
    const length = streak.length;
    const direction = streak.direction;

    if (length === 0 || !direction) {
      this.prediction = 'NO_BET';
      this.confidence = 0;
      this.evidenceScore = 0;
      return { prediction: 'NO_BET', confidence: 0, evidence: 0 };
    }

    const data = this.streakData[length];
    let contProb = 0.5, revProb = 0.5, sampleSize = 0;

    if (data) {
      const total = data.continuations + data.reversals;
      if (total >= this.minSamples) {
        contProb = data.continuations / total;
        revProb = data.reversals / total;
        sampleSize = total;
      }
    }

    if (sampleSize < this.minSamples) {
      let totalTrans = 0;
      for (const prev of ['BIG', 'SMALL']) {
        const t = this.transitions[prev] || { BIG: 0, SMALL: 0 };
        totalTrans += t.BIG + t.SMALL;
      }
      if (totalTrans < this.minSamples) {
        this.prediction = 'NO_BET';
        this.confidence = 0;
        this.evidenceScore = totalTrans;
        return { prediction: 'NO_BET', confidence: 0, evidence: totalTrans };
      }
      let globalCont = 0, globalRev = 0;
      for (const prev of ['BIG', 'SMALL']) {
        const t = this.transitions[prev] || { BIG: 0, SMALL: 0 };
        const same = prev === 'BIG' ? t.BIG : t.SMALL;
        const opp = prev === 'BIG' ? t.SMALL : t.BIG;
        globalCont += same;
        globalRev += opp;
      }
      const total = globalCont + globalRev;
      if (total < this.minSamples) {
        this.prediction = 'NO_BET';
        this.confidence = 0;
        this.evidenceScore = total;
        return { prediction: 'NO_BET', confidence: 0, evidence: total };
      }
      const gCont = globalCont / total;
      const gRev = 1 - gCont;
      const margin = Math.abs(gCont - gRev);
      if (margin < 0.12) {
        this.prediction = 'NO_BET';
        this.confidence = margin * 100;
        this.evidenceScore = total;
        return { prediction: 'NO_BET', confidence: margin * 100, evidence: total };
      }
      if (gCont > gRev) this.prediction = direction;
      else this.prediction = (direction === 'BIG' ? 'SMALL' : 'BIG');
      this.confidence = Math.min(margin * 100, 90);
      this.evidenceScore = total;
      return { prediction: this.prediction, confidence: this.confidence, evidence: total };
    }

    const margin = Math.abs(contProb - revProb);
    if (margin < 0.12) {
      this.prediction = 'NO_BET';
      this.confidence = margin * 100;
      this.evidenceScore = sampleSize;
      return { prediction: 'NO_BET', confidence: margin * 100, evidence: sampleSize };
    }
    if (contProb > revProb) this.prediction = direction;
    else this.prediction = (direction === 'BIG' ? 'SMALL' : 'BIG');
    this.confidence = Math.min(margin * 100, 95);
    this.evidenceScore = sampleSize;
    return { prediction: this.prediction, confidence: this.confidence, evidence: sampleSize };
  }

  getStatus() {
    const streak = this.getCurrentStreak();
    const pred = this.predict();
    return {
      totalOutcomes: this.history.length,
      currentStreak: streak.length,
      lastResult: this.lastResult,
      prediction: pred.prediction,
      confidence: Math.round(pred.confidence),
      evidence: pred.evidence,
      history: this.history,
      streakData: this.streakData,
      transitions: this.transitions
    };
  }

  async reset() {
    this.history = [];
    this.streakData = {};
    this.totalStreakSamples = 0;
    this.lastResult = null;
    this.currentStreak = 0;
    this.currentDirection = null;
    this.prediction = null;
    this.confidence = 0;
    this.evidenceScore = 0;
    this.transitions = { BIG: { BIG: 0, SMALL: 0 }, SMALL: { BIG: 0, SMALL: 0 } };
    await this.saveHistory();
  }
}

// ============ INITIALIZE ENGINE ============
const engine = new StreakEngine();
(async () => {
  await engine.loadHistory();
  engine.predict();
  console.log(`🧠 Engine loaded: ${engine.history.length} outcomes`);
})();

// ============ RESEND NOTIFICATION ============
async function sendResendAlert(message) {
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'StreakAI <notifications@yourdomain.com>', // change to your verified domain
        to: [ADMIN_EMAIL],
        subject: 'StreakAI Prediction Alert',
        html: `<p><strong>${message}</strong></p><p>Time: ${new Date().toLocaleString()}</p>`
      })
    });
    if (!response.ok) {
      const errText = await response.text();
      console.error('Resend error:', errText);
      throw new Error(`Resend failed: ${response.status}`);
    }
    console.log('📧 Resend notification sent');
    return true;
  } catch (e) {
    console.error('Resend error:', e.message);
    return false;
  }
}

// ============ EXPRESS SERVER ============
const app = express();
app.use(express.json());
app.use(express.static(__dirname)); // serves index.html

// Health check
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Get current prediction
app.get('/prediction', (req, res) => {
  const status = engine.getStatus();
  res.json({
    prediction: status.prediction,
    confidence: status.confidence,
    evidence: status.evidence,
    currentStreak: status.currentStreak,
    lastResult: status.lastResult,
    totalOutcomes: status.totalOutcomes
  });
});

// Get full debug status
app.get('/status', (req, res) => {
  res.json(engine.getStatus());
});

// Add new outcome
app.post('/outcome', async (req, res) => {
  const { outcome } = req.body;
  if (!outcome || (outcome !== 'BIG' && outcome !== 'SMALL')) {
    return res.status(400).json({ error: 'outcome must be "BIG" or "SMALL"' });
  }
  await engine.addOutcome(outcome);
  const pred = engine.predict();
  res.json({
    added: outcome,
    prediction: pred.prediction,
    confidence: Math.round(pred.confidence),
    evidence: pred.evidence
  });
});

// Manual alert trigger
app.post('/alert', async (req, res) => {
  const status = engine.getStatus();
  const msg = `Prediction: ${status.prediction} | Confidence: ${status.confidence}% | Streak: ${status.currentStreak} | Last: ${status.lastResult}`;
  const sent = await sendResendAlert(msg);
  if (sent) res.json({ success: true, message: 'Alert sent' });
  else res.status(500).json({ success: false, error: 'Failed to send alert' });
});

// Reset
app.post('/reset', async (req, res) => {
  await engine.reset();
  res.json({ success: true, message: 'Engine reset' });
});

// Start server
const server = app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📧 Will send one startup email in 5 minutes...`);

  // ONE‑TIME EMAIL AFTER 5 MINUTES
  setTimeout(async () => {
    const status = engine.getStatus();
    const msg = `StreakAI started successfully.\nPrediction: ${status.prediction} | Confidence: ${status.confidence}% | Streak: ${status.currentStreak} | Total outcomes: ${status.totalOutcomes}`;
    const sent = await sendResendAlert(msg);
    if (sent) console.log('✅ Startup email sent.');
    else console.log('❌ Startup email failed.');
  }, 5 * 60 * 1000); // 5 minutes
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down...');
  await engine.saveHistory();
  server.close(() => process.exit(0));
});
