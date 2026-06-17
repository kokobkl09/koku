// ============================================================
// STREAKAI BACKEND – ADAPTIVE ENGINE + RESEND ALERTS
// - Includes streak-continuation rule for streaks ≥ 3
// - Resend email alerts (your domain & API)
// - One‑time startup email after 5 minutes
// - Persistent storage in data/history.json
// ============================================================

const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const fetch = require('node-fetch');

// ─── CONFIG ────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

// Resend credentials (set these or use environment variables)
const RESEND_API_KEY = process.env.RESEND_API_KEY || 're_3R13fyxC_6UStikC6Vsnn9RZECcqPYuUo';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'jurohan38@gmail.com';
const FROM_EMAIL = process.env.FROM_EMAIL || 'StreakAI <alerts@jurohan38@gmail.com>';

// Engine constants
const MIN_SAMPLES = 20;
const SIGNIFICANCE_THRESHOLD = 0.05;
const MAX_HISTORY = 200;
const STRATEGIES = ['trend', 'reversal', 'pattern', 'markov', 'bayesian', 'streak', 'ensemble'];

// ─── ENGINE CLASS ──────────────────────────────────────────
class StreakEngine {
  constructor() {
    this.history = [];
    this.streakData = {};
    this.totalStreakSamples = 0;
    this.transitions = { BIG: { BIG: 0, SMALL: 0 }, SMALL: { BIG: 0, SMALL: 0 } };
    this.strategyStats = {};
    for (const s of STRATEGIES) {
      this.strategyStats[s] = {
        weight: 1.0,
        evidence: 0.5,
        samples: 0,
        pValue: 0.5,
        retired: false,
        performance: [],
        regimePerformance: {}
      };
    }
    this.totalEvidenceScore = 0.5;
    this.lastResult = null;
    this.lastPrediction = null;
    this.lastPredictionNumber = null;
    this.lastConfidence = 0;
    this.lastRisk = '--';
    this.lastRegime = 'NORMAL';
    this.lastStrategy = 'ensemble';
    this.lastPeriod = null;
    this.marketRegime = { state: 'NORMAL', confidence: 0.5 };
    this.lastRegimeChange = Date.now();
    this.predictions = [];
    this.patterns = [];
    this.rules = [];
  }

  // ─── HELPERS ──────────────────────────────────────────────
  getSize(n) { return n >= 5 ? 'BIG' : 'SMALL'; }
  clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  mean(arr) { return arr.length ? arr.reduce((a,b) => a+b, 0) / arr.length : 0; }
  mode(arr) { if (!arr.length) return 0; const f={}; let m=arr[0],c=0; for(const v of arr){ f[v]=(f[v]||0)+1; if(f[v]>c){c=f[v];m=v;}} return m; }

  // ─── STREAK DATA MANAGEMENT ──────────────────────────────
  recordStreak(length, direction, wasContinued) {
    if (length === 0) return;
    const key = length;
    if (!this.streakData[key]) this.streakData[key] = { continuations: 0, reversals: 0 };
    if (wasContinued) this.streakData[key].continuations++;
    else this.streakData[key].reversals++;
    this.totalStreakSamples++;
  }

  getCurrentStreak(historyArr) {
    if (!historyArr.length) return { length: 0, direction: null };
    let len = 1, dir = historyArr[historyArr.length-1].size;
    for (let i = historyArr.length-2; i >= 0; i--) {
      if (historyArr[i].size === dir) len++;
      else break;
    }
    return { length: len, direction: dir };
  }

  rebuildStreakData(historyArr) {
    this.streakData = {};
    this.totalStreakSamples = 0;
    this.transitions = { BIG: { BIG: 0, SMALL: 0 }, SMALL: { BIG: 0, SMALL: 0 } };
    if (historyArr.length < 2) return;
    let streakLen = 1, streakDir = historyArr[0].size;
    for (let i = 1; i < historyArr.length; i++) {
      const current = historyArr[i].size;
      if (current === streakDir) {
        streakLen++;
      } else {
        this.recordStreak(streakLen, streakDir, false);
        streakLen = 1;
        streakDir = current;
      }
      const prev = historyArr[i-1].size;
      this.transitions[prev][current] = (this.transitions[prev][current] || 0) + 1;
    }
  }

  getStreakProbabilities(length) {
    const data = this.streakData[length];
    if (!data) return { contProb: 0.5, revProb: 0.5, sampleSize: 0 };
    const total = data.continuations + data.reversals;
    if (total < MIN_SAMPLES) return { contProb: 0.5, revProb: 0.5, sampleSize: total };
    return {
      contProb: data.continuations / total,
      revProb: data.reversals / total,
      sampleSize: total
    };
  }

  // ─── STRATEGIES ───────────────────────────────────────────
  stratTrend(f) {
    const r = f.bigRatio_10 || 0.5;
    return { pred: r > 0.5 ? 'BIG' : 'SMALL', conf: this.clamp(50 + Math.abs(r - 0.5) * 80, 20, 88) };
  }
  stratReversal(f) {
    const s = f.streak || 1;
    if (s >= 3) { const opp = f.streakDir === 1 ? 'SMALL' : 'BIG'; return { pred: opp, conf: this.clamp(55 + s * 4, 50, 82) }; }
    const r = f.bigRatio_20 || 0.5;
    if (r > 0.65) return { pred: 'SMALL', conf: 62 };
    if (r < 0.35) return { pred: 'BIG', conf: 62 };
    return { pred: 'BIG', conf: 50 };
  }
  stratPattern(f, recent) {
    if (!this.patterns.length || recent.length < 2) return { pred: 'BIG', conf: 50 };
    const lastTwo = recent.slice(0, 2).map(r => r.size);
    for (const p of this.patterns.slice(0, 10)) {
      const seq = p.sequence;
      if (seq.length <= lastTwo.length) {
        let match = true;
        for (let i = 0; i < seq.length; i++) { if (lastTwo[i] !== seq[i]) { match = false; break; } }
        if (match) {
          const pred = p.nextBig > p.nextSmall ? 'BIG' : 'SMALL';
          return { pred, conf: this.clamp(p.confidence * 100, 40, 85) };
        }
      }
    }
    return { pred: 'BIG', conf: 50 };
  }
  stratMarkov(f, recent) {
    if (recent.length < 2) return { pred: 'BIG', conf: 50 };
    const last = recent[0].size;
    let bigAfter = 0, smallAfter = 0;
    for (let i = 1; i < Math.min(recent.length, 40); i++) {
      if (recent[i-1].size === last) {
        if (recent[i].size === 'BIG') bigAfter++;
        else smallAfter++;
      }
    }
    const total = bigAfter + smallAfter;
    if (total > 5) {
      const pBig = bigAfter / total;
      if (pBig > 0.55) return { pred: 'BIG', conf: 50 + pBig * 28 };
      if (pBig < 0.45) return { pred: 'SMALL', conf: 50 + (1 - pBig) * 28 };
    }
    return { pred: 'BIG', conf: 50 };
  }
  stratBayesian(f) {
    const s = f.streak || 1, r = f.bigRatio_10 || 0.5;
    let scoreBig = 0.5, scoreSmall = 0.5;
    if (s >= 3) { if (f.streakDir === 1) scoreSmall += 0.25; else scoreBig += 0.25; }
    if (r > 0.55) scoreBig += (r - 0.5) * 1.2;
    if (r < 0.45) scoreSmall += (0.5 - r) * 1.2;
    const total = scoreBig + scoreSmall;
    const pBig = scoreBig / total;
    return { pred: pBig > 0.5 ? 'BIG' : 'SMALL', conf: this.clamp(Math.abs(pBig - 0.5) * 160 + 30, 30, 85) };
  }

  // ─── NEW: STREAK-CONTINUATION STRATEGY ──────────────────
  stratStreakContinuation(features, currentStreak) {
    const len = currentStreak.length;
    const dir = currentStreak.direction;
    if (len >= 3 && dir) {
      let conf = 55 + Math.min(len - 3, 4) * 5;
      conf = Math.min(conf, 75);
      return { pred: dir, conf: conf };
    }
    return { pred: 'BIG', conf: 50 };
  }

  // ─── FEATURE EXTRACTION ──────────────────────────────────
  extractFeatures(historyArr, idx) {
    const f = {};
    const w = [3,5,10,20];
    for (const win of w) {
      const slice = historyArr.slice(Math.max(0, idx - win + 1), idx + 1);
      const nums = slice.map(r => r.number);
      const sizes = slice.map(r => r.size === 'BIG' ? 1 : 0);
      f[`bigRatio_${win}`] = sizes.reduce((a,b) => a+b, 0) / win;
      f[`mean_${win}`] = nums.reduce((a,b) => a+b, 0) / win;
      f[`std_${win}`] = Math.sqrt(nums.reduce((s, v) => s + (v - f[`mean_${win}`]) ** 2, 0) / win);
      const p1 = f[`bigRatio_${win}`];
      f[`entropy_${win}`] = -p1 * Math.log2(p1+0.001) - (1-p1) * Math.log2(1-p1+0.001);
    }
    let streak = 1;
    for (let i = idx; i > 0 && i > idx-12; i--) {
      if (historyArr[i]?.size === historyArr[i-1]?.size) streak++;
      else break;
    }
    f.streak = streak;
    f.streakDir = historyArr[idx]?.size === 'BIG' ? 1 : 0;
    return f;
  }

  // ─── PREDICT NUMBER ──────────────────────────────────────
  predictNumber(historyArr, size) {
    if (historyArr.length < 5) return 5;
    const nums = historyArr.slice(0, 15).map(r => r.number);
    const filtered = size === 'BIG' ? nums.filter(n => n >= 5) : nums.filter(n => n < 5);
    if (!filtered.length) return size === 'BIG' ? 7 : 2;
    return this.mode(filtered);
  }

  // ─── REGIME DETECTION ────────────────────────────────────
  detectRegime(historyArr) {
    if (historyArr.length < 20) return { state: 'NORMAL', confidence: 0.5 };
    const sizes = historyArr.slice(0, 20).map(r => r.size);
    let maxStreak = 1, cur = 1;
    for (let i = 1; i < sizes.length; i++) {
      if (sizes[i] === sizes[i-1]) cur++;
      else { maxStreak = Math.max(maxStreak, cur); cur = 1; }
    }
    maxStreak = Math.max(maxStreak, cur);
    let vol = 0;
    for (let i = 1; i < Math.min(historyArr.length, 20); i++) {
      vol += Math.abs(historyArr[i].number - historyArr[i-1].number);
    }
    vol = vol / Math.min(20, historyArr.length-1) / 9;
    const bigs = sizes.filter(s => s === 'BIG').length / sizes.length;
    const ent = -bigs * Math.log2(bigs+0.001) - (1-bigs) * Math.log2(1-bigs+0.001);

    let state = 'NORMAL', conf = 0.55;
    if (maxStreak >= 5 && vol < 0.4) { state = 'TRENDING'; conf = 0.7; }
    else if (vol > 0.65) { state = 'VOLATILE'; conf = 0.7; }
    else if (ent > 0.9) { state = 'RANDOM'; conf = 0.75; }
    else if (maxStreak >= 3 && vol < 0.5) { state = 'CYCLIC'; conf = 0.6; }

    if (state !== this.marketRegime.state && Date.now() - this.lastRegimeChange > 120000) {
      this.lastRegimeChange = Date.now();
      this.marketRegime = { state, confidence: conf };
    } else {
      this.marketRegime.confidence = this.marketRegime.confidence * 0.8 + conf * 0.2;
    }
    return this.marketRegime;
  }

  // ─── RISK ──────────────────────────────────────────────────
  calcRisk(confidence, volatility, streak, regime) {
    let score = 40 + (100 - confidence) * 0.4 + volatility * 25;
    if (streak > 4) score += 10;
    if (streak > 7) score += 10;
    if (regime === 'VOLATILE') score += 15;
    if (regime === 'RANDOM') score += 20;
    score = this.clamp(score, 8, 96);
    if (score < 35) return { level: 'LOW', advice: 'Favorable' };
    if (score < 65) return { level: 'MEDIUM', advice: 'Moderate' };
    return { level: 'HIGH', advice: 'Unfavorable' };
  }

  // ─── UPDATE STRATEGY EVIDENCE ────────────────────────────
  updateStrategyEvidence(strategy, correct, confidence, regime) {
    const s = this.strategyStats[strategy];
    if (!s || s.retired) return;
    s.samples++;
    s.performance.push(correct ? 1 : 0);
    if (s.performance.length > 200) s.performance.shift();
    if (!s.regimePerformance[regime]) s.regimePerformance[regime] = [];
    s.regimePerformance[regime].push(correct ? 1 : 0);
    if (s.regimePerformance[regime].length > 100) s.regimePerformance[regime].shift();

    const recent = s.performance.slice(-50);
    const acc = recent.length ? recent.reduce((a,b) => a+b, 0) / recent.length : 0.5;
    s.evidence = this.clamp((acc - 0.5) * 2 + 0.5, 0.1, 0.95);

    if (s.performance.length >= MIN_SAMPLES) {
      const m = this.mean(s.performance);
      const se = Math.sqrt(s.performance.reduce((sum, v) => sum + (v - m) ** 2, 0) / (s.performance.length - 1) / s.performance.length);
      const t = (m - 0.5) / (se || 0.001);
      const p = 2 * (1 - 0.5 * (1 + t / Math.sqrt(t * t + s.performance.length)));
      s.pValue = this.clamp(p, 0, 1);
    }

    if (s.performance.length >= MIN_SAMPLES && s.pValue < SIGNIFICANCE_THRESHOLD) {
      s.weight = this.clamp(s.evidence * 1.5, 0.3, 2.5);
    } else {
      s.weight = 0.8 + 0.4 * s.evidence;
    }

    const active = Object.keys(this.strategyStats).filter(k => !this.strategyStats[k].retired);
    const total = active.reduce((sum, k) => sum + this.strategyStats[k].weight, 0);
    for (const k of active) this.strategyStats[k].weight /= total;
    this.totalEvidenceScore = active.reduce((sum, k) => sum + this.strategyStats[k].evidence, 0) / (active.length || 1);
  }

  // ─── MANAGE RULES ──────────────────────────────────────────
  manageRules() {
    const active = Object.keys(this.strategyStats).filter(k => !this.strategyStats[k].retired);
    for (const s of active) {
      const stats = this.strategyStats[s];
      if (stats.performance.length >= MIN_SAMPLES) {
        const acc = stats.performance.reduce((a,b) => a+b, 0) / stats.performance.length;
        if (stats.pValue > 0.1 && acc < 0.45) {
          stats.retired = true;
        }
      }
    }
    for (const s of Object.keys(this.strategyStats)) {
      if (this.strategyStats[s].retired && this.strategyStats[s].performance.length >= MIN_SAMPLES) {
        const acc = this.strategyStats[s].performance.reduce((a,b) => a+b, 0) / this.strategyStats[s].performance.length;
        if (acc > 0.5 && this.strategyStats[s].pValue < 0.05) {
          this.strategyStats[s].retired = false;
        }
      }
    }
    this.rules = this.patterns.slice(0, 20).map(p => ({
      id: p.key,
      condition: `Pattern ${p.key}`,
      action: p.nextBig > p.nextSmall ? 'BIG' : 'SMALL',
      confidence: p.confidence,
      evidence: this.clamp(p.confidence * 0.7 + 0.3, 0.3, 0.95),
      active: (p.nextBig + p.nextSmall) >= 3
    }));
    this.rules.sort((a,b) => b.evidence - a.evidence);
  }

  // ─── LEARN PATTERNS ──────────────────────────────────────
  learnPatterns(historyArr) {
    if (historyArr.length < 10) return;
    const sizes = historyArr.map(r => r.size);
    for (let len = 2; len <= 4; len++) {
      for (let i = 0; i <= sizes.length - len; i++) {
        const key = sizes.slice(i, i+len).join(',');
        let cnt = 0;
        for (let j = 0; j <= sizes.length - len; j++) {
          if (sizes.slice(j, j+len).join(',') === key) cnt++;
        }
        if (cnt >= 2) {
          let nextBig = 0, nextSmall = 0;
          for (let j = 0; j <= sizes.length - len - 1; j++) {
            if (sizes.slice(j, j+len).join(',') === key) {
              if (sizes[j+len] === 'BIG') nextBig++;
              else nextSmall++;
            }
          }
          const conf = Math.max(nextBig, nextSmall) / (nextBig + nextSmall + 1e-6);
          const existing = this.patterns.find(p => p.key === key);
          if (existing) {
            existing.nextBig = nextBig;
            existing.nextSmall = nextSmall;
            existing.confidence = conf;
            existing.count = cnt;
          } else {
            this.patterns.push({ key, sequence: sizes.slice(i, i+len), count: cnt, nextBig, nextSmall, confidence: conf });
          }
        }
      }
    }
    this.patterns.sort((a,b) => b.confidence - a.confidence);
    if (this.patterns.length > 80) this.patterns = this.patterns.slice(0, 80);
  }

  // ─── PREDICT (MAIN) ──────────────────────────────────────
  predict(historyArr) {
    if (historyArr.length < 5) {
      return { prediction: 'NO_BET', confidence: 0, evidence: 0, number: 5, risk: 'HIGH', regime: 'NORMAL', strategy: 'ensemble' };
    }
    const current = this.getCurrentStreak(historyArr);
    const length = current.length;
    const direction = current.direction;
    const probs = this.getStreakProbabilities(length);
    let contProb = probs.contProb;
    let revProb = probs.revProb;
    let sampleSize = probs.sampleSize;

    // Fallback if insufficient samples
    if (sampleSize < MIN_SAMPLES) {
      let totalTrans = 0;
      for (const p of ['BIG','SMALL']) totalTrans += this.transitions[p].BIG + this.transitions[p].SMALL;
      if (totalTrans < MIN_SAMPLES) {
        return { prediction: 'NO_BET', confidence: 0, evidence: 0, number: 5, risk: 'HIGH', regime: 'NORMAL', strategy: 'ensemble' };
      }
      let globalCont = 0, globalRev = 0;
      for (const prev of ['BIG','SMALL']) {
        const t = this.transitions[prev] || { BIG: 0, SMALL: 0 };
        const same = prev === 'BIG' ? t.BIG : t.SMALL;
        const opp = prev === 'BIG' ? t.SMALL : t.BIG;
        globalCont += same;
        globalRev += opp;
      }
      const total = globalCont + globalRev;
      if (total < MIN_SAMPLES) {
        return { prediction: 'NO_BET', confidence: 0, evidence: 0, number: 5, risk: 'HIGH', regime: 'NORMAL', strategy: 'ensemble' };
      }
      const gCont = globalCont / total;
      const gRev = 1 - gCont;
      const margin = Math.abs(gCont - gRev);
      if (margin < 0.12) {
        return { prediction: 'NO_BET', confidence: margin*100, evidence: total, number: 5, risk: 'HIGH', regime: 'NORMAL', strategy: 'ensemble' };
      }
      const pred = gCont > gRev ? direction : (direction === 'BIG' ? 'SMALL' : 'BIG');
      const conf = Math.min(margin*100, 85);
      const num = this.predictNumber(historyArr, pred);
      return { prediction: pred, confidence: conf, evidence: total, number: num, risk: 'MEDIUM', regime: 'NORMAL', strategy: 'ensemble' };
    }

    // ─── ENSEMBLE VOTE ────────────────────────────────────
    const features = this.extractFeatures(historyArr, 0);
    const votes = {};
    for (const s of STRATEGIES) {
      let result;
      switch(s) {
        case 'trend': result = this.stratTrend(features); break;
        case 'reversal': result = this.stratReversal(features); break;
        case 'pattern': result = this.stratPattern(features, historyArr.slice(0, 12)); break;
        case 'markov': result = this.stratMarkov(features, historyArr.slice(0, 12)); break;
        case 'bayesian': result = this.stratBayesian(features); break;
        case 'streak': result = this.stratStreakContinuation(features, current); break;
        case 'ensemble': result = { pred: 'BIG', conf: 50 }; break;
        default: result = { pred: 'BIG', conf: 50 };
      }
      votes[s] = result;
    }

    const active = Object.keys(this.strategyStats).filter(k => !this.strategyStats[k].retired);
    let finalVotes = { BIG: 0, SMALL: 0 };
    let totalWeight = 0;
    for (const s of active) {
      const v = votes[s];
      const w = this.strategyStats[s].weight;
      finalVotes[v.pred] += v.conf * w;
      totalWeight += w;
    }
    if (totalWeight === 0) { finalVotes = { BIG: votes.ensemble.conf, SMALL: 0 }; totalWeight = 1; }

    const pred = finalVotes.BIG > finalVotes.SMALL ? 'BIG' : 'SMALL';
    const rawConf = totalWeight > 0 ? (Math.max(finalVotes.BIG, finalVotes.SMALL) / totalWeight) * 100 : 50;
    const calibratedConf = this.clamp(rawConf * 0.6 + this.totalEvidenceScore * 40, 25, 94);

    let bestStrat = 'ensemble';
    let bestEv = -1;
    for (const s of active) {
      if (this.strategyStats[s].evidence > bestEv) {
        bestEv = this.strategyStats[s].evidence;
        bestStrat = s;
      }
    }

    const regime = this.detectRegime(historyArr);
    const risk = this.calcRisk(calibratedConf, 0.5, length, regime.state);
    const num = this.predictNumber(historyArr, pred);

    return {
      prediction: pred,
      confidence: calibratedConf,
      evidence: sampleSize,
      number: num,
      risk: risk.level,
      regime: regime.state,
      strategy: bestStrat
    };
  }

  // ─── ADD OUTCOME ──────────────────────────────────────────
  async addOutcome(outcome, number, period) {
    if (outcome !== 'BIG' && outcome !== 'SMALL') return;
    const entry = { period: period || `P${this.history.length+1}`, number: number || (outcome === 'BIG' ? 7 : 2), size: outcome };
    this.history.unshift(entry);
    if (this.history.length > MAX_HISTORY) this.history.pop();

    if (this.history.length >= 2) {
      const last = this.history[1]?.size;
      const current = this.history[0].size;
      if (last !== current) {
        const prevStreak = this.getCurrentStreak(this.history.slice(1));
        if (prevStreak.length > 0) {
          this.recordStreak(prevStreak.length, prevStreak.direction, false);
        }
      }
      if (last) this.transitions[last][current] = (this.transitions[last][current] || 0) + 1;
    }

    if (this.lastPrediction && this.lastPeriod !== period) {
      const correct = (this.lastPrediction === outcome);
      // update strategy evidence
      this.updateStrategyEvidence(this.lastStrategy, correct, this.lastConfidence, this.lastRegime);
      this.predictions.unshift({
        period: this.lastPeriod,
        predicted: this.lastPrediction,
        number: this.lastPredictionNumber,
        actual: outcome,
        actualNumber: number,
        confidence: this.lastConfidence,
        risk: this.lastRisk,
        regime: this.lastRegime,
        strategy: this.lastStrategy,
        correct
      });
      if (this.predictions.length > MAX_HISTORY) this.predictions.pop();
      this.manageRules();
      this.learnPatterns(this.history);
    }

    this.lastPeriod = period || `P${this.history.length}`;

    if (this.history.length >= 5) {
      const pred = this.predict(this.history);
      this.lastPrediction = pred.prediction;
      this.lastPredictionNumber = pred.number;
      this.lastConfidence = pred.confidence;
      this.lastRisk = pred.risk;
      this.lastRegime = pred.regime;
      this.lastStrategy = pred.strategy;
    }
    await this.saveHistory();
  }

  // ─── LOAD / SAVE ──────────────────────────────────────────
  async loadHistory() {
    try {
      const data = await fs.readFile(HISTORY_FILE, 'utf-8');
      const parsed = JSON.parse(data);
      if (parsed.history) this.history = parsed.history;
      if (parsed.predictions) this.predictions = parsed.predictions;
      if (parsed.patterns) this.patterns = parsed.patterns;
      if (parsed.rules) this.rules = parsed.rules;
      if (parsed.streakData) this.streakData = parsed.streakData;
      if (parsed.transitions) this.transitions = parsed.transitions;
      if (parsed.strategyStats) this.strategyStats = parsed.strategyStats;
      if (parsed.totalEvidenceScore !== undefined) this.totalEvidenceScore = parsed.totalEvidenceScore;
      if (parsed.lastPrediction) this.lastPrediction = parsed.lastPrediction;
      if (parsed.lastConfidence) this.lastConfidence = parsed.lastConfidence;
      if (parsed.lastPeriod) this.lastPeriod = parsed.lastPeriod;
      if (parsed.lastRegime) this.lastRegime = parsed.lastRegime;
      if (parsed.marketRegime) this.marketRegime = parsed.marketRegime;
      this.rebuildStreakData(this.history);
    } catch (err) {
      // file doesn't exist or invalid – start fresh
    }
  }

  async saveHistory() {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const data = {
      history: this.history.slice(0, 200),
      predictions: this.predictions.slice(0, 100),
      patterns: this.patterns,
      rules: this.rules,
      streakData: this.streakData,
      transitions: this.transitions,
      strategyStats: this.strategyStats,
      totalEvidenceScore: this.totalEvidenceScore,
      lastPrediction: this.lastPrediction,
      lastConfidence: this.lastConfidence,
      lastPeriod: this.lastPeriod,
      lastRegime: this.lastRegime,
      marketRegime: this.marketRegime
    };
    await fs.writeFile(HISTORY_FILE, JSON.stringify(data, null, 2));
  }

  // ─── GET STATUS ────────────────────────────────────────────
  getStatus() {
    return {
      totalOutcomes: this.history.length,
      currentStreak: this.getCurrentStreak(this.history).length,
      lastResult: this.history.length ? this.history[0].size : null,
      lastPeriod: this.lastPeriod,
      prediction: this.lastPrediction || 'NO BET',
      confidence: Math.round(this.lastConfidence || 0),
      evidence: this.totalEvidenceScore,
      regime: this.lastRegime,
      strategy: this.lastStrategy,
      wins: this.predictions.filter(p => p.correct).length,
      losses: this.predictions.filter(p => p.correct === false).length,
      accuracy: this.predictions.length ? (this.predictions.filter(p => p.correct).length / this.predictions.length * 100) : 0,
      patterns: this.patterns.length,
      rules: this.rules.filter(r => r.active).length,
      strategyStats: this.strategyStats
    };
  }

  // ─── RESET ──────────────────────────────────────────────────
  async reset() {
    this.history = [];
    this.predictions = [];
    this.patterns = [];
    this.rules = [];
    this.streakData = {};
    this.totalStreakSamples = 0;
    this.transitions = { BIG: { BIG: 0, SMALL: 0 }, SMALL: { BIG: 0, SMALL: 0 } };
    for (const s of STRATEGIES) {
      this.strategyStats[s] = {
        weight: 1.0,
        evidence: 0.5,
        samples: 0,
        pValue: 0.5,
        retired: false,
        performance: [],
        regimePerformance: {}
      };
    }
    this.totalEvidenceScore = 0.5;
    this.lastPrediction = null;
    this.lastConfidence = 0;
    this.lastPeriod = null;
    this.lastRegime = 'NORMAL';
    this.lastStrategy = 'ensemble';
    await this.saveHistory();
  }
}

// ─── INIT ENGINE ─────────────────────────────────────────────
const engine = new StreakEngine();
(async () => {
  await engine.loadHistory();
  if (engine.history.length >= 5) {
    engine.predict(engine.history);
  }
  console.log(`🧠 Engine loaded: ${engine.history.length} outcomes`);
})();

// ─── RESEND HELPER ──────────────────────────────────────────
async function sendResendAlert(message) {
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [ADMIN_EMAIL],
        subject: 'StreakAI Prediction Alert',
        html: `<p><strong>${message}</strong></p><p>Time: ${new Date().toLocaleString()}</p>`
      })
    });
    if (!response.ok) {
      const errText = await response.text();
      console.error('Resend error:', errText);
      return false;
    }
    console.log('📧 Resend notification sent');
    return true;
  } catch (e) {
    console.error('Resend error:', e.message);
    return false;
  }
}

// ─── EXPRESS SERVER ─────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(__dirname)); // serves static files (like index.html)

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
    totalOutcomes: status.totalOutcomes,
    regime: status.regime,
    strategy: status.strategy
  });
});

// Get full status (including strategyStats)
app.get('/status', (req, res) => {
  res.json(engine.getStatus());
});

// Add new outcome
app.post('/outcome', async (req, res) => {
  const { outcome, number, period } = req.body;
  if (!outcome || (outcome !== 'BIG' && outcome !== 'SMALL')) {
    return res.status(400).json({ error: 'outcome must be "BIG" or "SMALL"' });
  }
  await engine.addOutcome(outcome, number || (outcome === 'BIG' ? 7 : 2), period);
  const status = engine.getStatus();
  res.json({
    added: outcome,
    prediction: status.prediction,
    confidence: status.confidence,
    evidence: status.evidence
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

// ─── START SERVER ──────────────────────────────────────────
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
  }, 5 * 60 * 1000);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down...');
  await engine.saveHistory();
  server.close(() => process.exit(0));
});
