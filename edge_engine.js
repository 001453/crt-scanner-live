/**
 * CRT Scanner — Probability Edge Engine (TR saat, seans, 2020-2025 bias)
 * Browser: window.CrtEdgeEngine | Node: require('./edge_engine')
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.CrtEdgeEngine = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const TR_OFFSET = 3;
  const DAYS_TR = ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'];
  const MONTHS_TR = ['', 'Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];

  function getLondonOffset(d) {
    const y = d.getUTCFullYear();
    const mar31 = new Date(Date.UTC(y, 2, 31));
    const marSun = new Date(mar31);
    marSun.setUTCDate(31 - (mar31.getUTCDay() === 0 ? 7 : mar31.getUTCDay()));
    const oct31 = new Date(Date.UTC(y, 9, 31));
    const octSun = new Date(oct31);
    octSun.setUTCDate(31 - (oct31.getUTCDay() === 0 ? 7 : oct31.getUTCDay()));
    const bstStart = new Date(marSun);
    bstStart.setUTCHours(1);
    const bstEnd = new Date(octSun);
    bstEnd.setUTCHours(1);
    return d >= bstStart && d < bstEnd ? 1 : 0;
  }

  function getNyOffset(d) {
    const y = d.getUTCFullYear();
    const mar1 = new Date(Date.UTC(y, 2, 1));
    const daysToSun = (7 - mar1.getUTCDay()) % 7;
    const mar2ndSun = new Date(mar1);
    mar2ndSun.setUTCDate(1 + daysToSun + 7);
    const nov1 = new Date(Date.UTC(y, 10, 1));
    const daysToSunNov = (7 - nov1.getUTCDay()) % 7;
    const nov1stSun = new Date(nov1);
    nov1stSun.setUTCDate(1 + daysToSunNov);
    const edtStart = new Date(mar2ndSun);
    edtStart.setUTCHours(7);
    const edtEnd = new Date(nov1stSun);
    edtEnd.setUTCHours(6);
    return d >= edtStart && d < edtEnd ? -4 : -5;
  }

  function getTRHour(d) {
    return ((d.getUTCHours() + TR_OFFSET) % 24 + 24) % 24;
  }

  function getTRDayName(d) {
    const trDate = new Date(d.getTime() + TR_OFFSET * 3600000);
    const dow = trDate.getUTCDay();
    return DAYS_TR[dow === 0 ? 6 : dow - 1];
  }

  function getTRMonthName(d) {
    const trDate = new Date(d.getTime() + TR_OFFSET * 3600000);
    return MONTHS_TR[trDate.getUTCMonth() + 1];
  }

  function getTRSessions(d = new Date()) {
    const ldOff = getLondonOffset(d);
    const utcTm = d.getUTCHours() * 60 + d.getUTCMinutes();
    const sess = [];
    if (utcTm < 9 * 60) sess.push('TK');
    if (utcTm >= 8 * 60 && utcTm < 17 * 60) sess.push('LD');
    if (utcTm >= 13 * 60 && utcTm < 22 * 60) sess.push('NY');
    if (utcTm >= 13 * 60 && utcTm < 17 * 60) sess.push('OV');
    const ldOpenTR = (8 - ldOff + TR_OFFSET + 24) % 24;
    const ldCloseTR = (17 - ldOff + TR_OFFSET + 24) % 24;
    const nyOpenTR = (13 + getNyOffset(d) + TR_OFFSET + 24) % 24;
    const nyCloseTR = (22 + getNyOffset(d) + TR_OFFSET + 24) % 24;
    return {
      active: sess.length ? sess : ['OFF'],
      ldOpenTR: `${String(ldOpenTR).padStart(2, '0')}:00`,
      ldCloseTR: `${String(ldCloseTR).padStart(2, '0')}:00`,
      nyOpenTR: `${String(nyOpenTR).padStart(2, '0')}:00`,
      nyCloseTR: `${String(nyCloseTR).padStart(2, '0')}:00`,
      tkOpenTR: '03:00',
      tkCloseTR: '12:00',
      ovOpenTR: `${String(nyOpenTR).padStart(2, '0')}:00`,
      ovCloseTR: `${String(ldCloseTR).padStart(2, '0')}:00`,
      ldOff,
      nyOff: getNyOffset(d),
      isSummer: ldOff === 1
    };
  }

  function normId(s) {
    return String(s || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  }

  function resolveEdgeRecord(pairId, category, db) {
    if (!db || !db.pairs) return { edge: null, source: 'none' };
    const id = normId(pairId);
    if (db.pairs[id]) return { edge: db.pairs[id], source: 'direct', templateId: id };
    const aliases = db.pairAliases || {};
    for (const [alias, target] of Object.entries(aliases)) {
      if (id.includes(alias) && db.pairs[target]) {
        return { edge: db.pairs[target], source: `alias:${alias}`, templateId: target };
      }
    }
    const profiles = db.categoryProfiles || {};
    const cat = String(category || 'forex').toLowerCase();
    const templateId = profiles[cat] || profiles.default || 'EURUSD';
    const edge = db.pairs[templateId] || null;
    return { edge, source: edge ? `category:${cat}` : 'none', templateId };
  }

  function computeEdgeBias(pairId, now, db, category) {
    const { edge, source, templateId } = resolveEdgeRecord(pairId, category, db);
    const neutral = {
      pair: pairId,
      bias: 'NÖTR',
      bullPct: 50,
      conf: 0,
      quality: 'C',
      signals: [],
      source,
      templateId: templateId || null,
      sessions: getTRSessions(now).active
    };
    if (!edge) return neutral;

    const si = getTRSessions(now);
    const dayName = getTRDayName(now);
    const monthName = getTRMonthName(now);
    const trHour = getTRHour(now);
    const signals = [];

    const hb = edge.hourlyTR && edge.hourlyTR[trHour];
    if (hb !== undefined) {
      signals.push({ id: 'hourly', bull: hb, w: 1.5, label: `${String(trHour).padStart(2, '0')}:xx TR` });
    }
    const wb = edge.weekly && edge.weekly[dayName];
    if (wb !== undefined) {
      signals.push({ id: 'weekly', bull: wb, w: 1.5, label: dayName });
    }
    const mb = edge.monthly && edge.monthly[monthName];
    if (mb && mb.b !== undefined) {
      signals.push({ id: 'monthly', bull: mb.b, w: 1.0, label: monthName });
    }
    if (si.active.includes('LD') || si.active.includes('NY')) {
      const h2 = edge.h2 || {};
      signals.push({ id: 'ny_ld', bull: h2.v || 50, w: 2.0, label: 'NY-LD' });
    }
    if (si.active.includes('NY') && now.getUTCHours() === 13 && edge.h1) {
      signals.push({ id: 'ny30', bull: edge.h1, w: 2.5, label: 'NY30' });
    }
    for (const s of si.active.filter((x) => x !== 'OFF')) {
      const bull = s === 'TK' ? 52 : s === 'LD' ? 53 : 54;
      signals.push({ id: `s_${s}`, bull, w: 0.8, label: s });
    }

    let tw = 0;
    let bs = 0;
    for (const s of signals) {
      tw += s.w;
      bs += (s.bull / 100) * s.w;
    }
    const bullPct = tw > 0 ? Math.round((bs / tw) * 1000) / 10 : 50;
    const bias = bullPct >= 55 ? 'LONG' : bullPct <= 45 ? 'SHORT' : 'NÖTR';
    const conf = Math.round(Math.abs(bullPct - 50) * 2);
    const quality = conf > 30 ? 'A' : conf > 18 ? 'B' : 'C';

    return {
      pair: pairId,
      bias,
      bullPct,
      conf,
      quality,
      signals,
      source,
      templateId,
      sessions: si.active,
      monthBull: mb && mb.b,
      hourBull: hb,
      dayBull: wb,
      sessInfo: si
    };
  }

  function edgeAlignsCrt(crtSide, edge) {
    if (!edge || !crtSide) return { ok: true, reason: 'no_edge' };
    const side = String(crtSide).toUpperCase();
    if (!['LONG', 'SHORT'].includes(side)) return { ok: true, reason: 'no_crt_side' };
    if (edge.bias === 'NÖTR') return { ok: true, reason: 'edge_neutral' };
    if (edge.bias === side) return { ok: true, reason: 'aligned' };
    return { ok: false, reason: 'edge_conflict', detail: `edge_${edge.bias}_crt_${side}` };
  }

  function edgeGateForAuto(crtSide, edge, cfg) {
    cfg = cfg || {};
    if (!cfg.enabled) return { ok: true, reason: 'edge_filter_off' };
    const align = edgeAlignsCrt(crtSide, edge);
    if (!align.ok) {
      const minConf = Number(cfg.blockConflictMinConf || 22);
      if ((edge.conf || 0) >= minConf) {
        return { ok: false, reason: 'edge_conflict', detail: align.detail };
      }
    }
    const minAlign = Number(cfg.minBullAlign || 52);
    if (crtSide === 'LONG' && (edge.bullPct || 50) < minAlign) {
      return { ok: false, reason: 'edge_weak_long', detail: `bullPct=${edge.bullPct}` };
    }
    if (crtSide === 'SHORT' && (edge.bullPct || 50) > 100 - minAlign) {
      return { ok: false, reason: 'edge_weak_short', detail: `bullPct=${edge.bullPct}` };
    }
    if (cfg.blockWeakMonth !== false && edge.monthBull !== undefined && edge.monthBull !== null) {
      const weak = Number(cfg.weakMonthBelow || 42);
      if (crtSide === 'LONG' && edge.monthBull < weak) {
        return { ok: false, reason: 'edge_weak_month', detail: `month=${edge.monthBull}` };
      }
      if (crtSide === 'SHORT' && edge.monthBull > 100 - weak) {
        return { ok: false, reason: 'edge_weak_month', detail: `month=${edge.monthBull}` };
      }
    }
    if (cfg.requireGradeB && edge.quality === 'C' && (edge.conf || 0) < 15) {
      return { ok: false, reason: 'edge_grade_c', detail: 'low_conf' };
    }
    return { ok: true, reason: 'edge_ok' };
  }

  function edgeSummaryForAi(edge) {
    if (!edge || edge.source === 'none') return '';
    return `Edge(${edge.templateId || '?'},${edge.source}): ${edge.bias} bull%${edge.bullPct} conf%${edge.conf} grade${edge.quality} sess=${(edge.sessions || []).join('/')} month%${edge.monthBull ?? '-'}`;
  }

  return {
    TR_OFFSET,
    getTRSessions,
    getTRHour,
    getTRDayName,
    getTRMonthName,
    resolveEdgeRecord,
    computeEdgeBias,
    edgeAlignsCrt,
    edgeGateForAuto,
    edgeSummaryForAi
  };
});
