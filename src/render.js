/*
 * Render layer (isolated world). Builds the profile-dashboard overlay and draws it with Chart.js.
 * Scoped under .e7rta so it can't collide with the host page.
 *
 *   E7Render.mount(rootEl, { onClose })
 *   E7Render.update(data, profile)   // data = { meta, views }, profile = page-extracted player card
 */
(function () {
	'use strict';

	var ROOT = null, TIP = null, OPTS = {};
	var CHARTS = {};
	var pending = [];
	var raf = window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : function (f) { return setTimeout(f, 16); };
	var state = { data: null, profile: null, view: null, session: 0, tab: 'matches', heroOpen: null, matchOpen: null, matchShown: 60, sig: null, renderTimer: null, loading: false };
	var COL = {}, EL = {}, RANK_COLORS = {};
	/* every user-visible string goes through T(); the dictionary lives in i18n.js */
	var T = function (k, p) { return E7I18n.t(k, p); };
	var localeOf = function () { return E7I18n.lang() === 'vi' ? 'vi-VN' : 'en-US'; };
	var weekday = function (i) { return T('day.' + i); };

	var $ = function (s) { return ROOT ? ROOT.querySelector(s) : null; };
	var signed = function (n) { return (n > 0 ? '+' : '') + n; };
	var fmtDate = function (t) { return new Date(t).toLocaleDateString(localeOf(), { month: 'short', day: 'numeric' }); };
	var fmtTime = function (t) { return new Date(t).toLocaleTimeString(localeOf(), { hour: '2-digit', minute: '2-digit', hour12: false }); };
	var fmtDateTime = function (t) { return new Date(t).toLocaleString(localeOf(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); };
	var cap = function (s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; };
	/** "2357 Victory Points / Top0.4 %" -> "2357 VP · Top 0.4%" */
	function fmtScore(s) {
		if (!s) return '';
		var pts = /([\d,]+)\s*(?:VP|Victory Points)/i.exec(s);
		var top = /Top\s*([\d.]+)/i.exec(s);
		var out = [];
		if (pts) out.push(pts[1] + ' VP');
		if (top) out.push('Top ' + top[1] + '%');
		return out.join(' · ') || String(s).replace(/\s+/g, ' ').trim();
	}
	var elColor = function (e) { return EL[String(e || '').toLowerCase()] || COL.faint; };
	function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
	function clear(node) { if (node) node.textContent = ''; }

	var THEME_KEYS = ['unranked', 'bronze', 'silver', 'gold', 'master', 'challenger', 'champion', 'warlord', 'emperor', 'legend'];
	/** The rank drives the whole card's theme — hue-tinted neutrals, accent, glows and chart lines. */
	function applyTheme(tierKey) {
		for (var i = 0; i < THEME_KEYS.length; i++) ROOT.classList.remove('e7rta--' + THEME_KEYS[i]);
		ROOT.classList.add('e7rta--' + (THEME_KEYS.indexOf(tierKey) >= 0 ? tierKey : 'unranked'));
		// chart colours are read from CSS vars, so re-read them for the new theme
		setupChartDefaults();
	}

	/* ---------- tooltip ---------- */
	function place(ev) {
		var pad = 14, r = TIP.getBoundingClientRect();
		var x = ev.clientX + pad, y = ev.clientY + pad;
		if (x + r.width > window.innerWidth - 8) x = ev.clientX - r.width - pad;
		if (y + r.height > window.innerHeight - 8) y = ev.clientY - r.height - pad;
		TIP.style.left = Math.max(8, x) + 'px';
		TIP.style.top = Math.max(8, y) + 'px';
	}
	function showTip(html, ev) { TIP.innerHTML = html; TIP.hidden = false; place(ev); }
	function hideTip() { TIP.hidden = true; }
	function bindTip(node, fn) {
		node.addEventListener('pointerenter', function (ev) { showTip(fn(), ev); });
		node.addEventListener('pointermove', place);
		node.addEventListener('pointerleave', hideTip);
		node.addEventListener('focus', function () { var r = node.getBoundingClientRect(); showTip(fn(), { clientX: r.left + r.width / 2, clientY: r.top }); });
		node.addEventListener('blur', hideTip);
	}

	/* ---------- chart plumbing ---------- */
	function setupChartDefaults() {
		var cs = getComputedStyle(ROOT);
		COL = {
			win: cs.getPropertyValue('--e7rta-win').trim(), loss: cs.getPropertyValue('--e7rta-loss').trim(),
			accent: cs.getPropertyValue('--e7rta-accent').trim(), accentSoft: cs.getPropertyValue('--e7rta-accent-soft').trim(),
			ink: cs.getPropertyValue('--e7rta-ink').trim(),
			muted: cs.getPropertyValue('--e7rta-muted').trim(), faint: cs.getPropertyValue('--e7rta-faint').trim(),
			line: cs.getPropertyValue('--e7rta-line').trim(), lineSoft: cs.getPropertyValue('--e7rta-line-soft').trim(),
			panel: cs.getPropertyValue('--e7rta-panel').trim()
		};
		EL = {
			fire: cs.getPropertyValue('--e7rta-fire').trim(), ice: cs.getPropertyValue('--e7rta-ice').trim(),
			earth: cs.getPropertyValue('--e7rta-earth').trim(), light: cs.getPropertyValue('--e7rta-light').trim(),
			dark: cs.getPropertyValue('--e7rta-dark').trim()
		};
		RANK_COLORS = {
			bronze: '#bd7f47', silver: '#c9d3de', gold: '#e0b64f', master: '#3ecf88', challenger: '#4a90e2',
			champion: '#ffdf8a', warlord: '#b06ce8', emperor: '#e8324f', legend: '#6fd7ff', unranked: '#8a8f98'
		};
		Chart.defaults.color = COL.faint;
		Chart.defaults.borderColor = COL.lineSoft;
		Chart.defaults.font.family = 'ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif';
		Chart.defaults.font.size = 11;
		/* Chart.js's own entrance tweening is left on (defaults). */
		/* Chart.js's responsive mode attaches a ResizeObserver to the chart's container. If anything in
		   that arrangement feeds size back into the container, the observer fires again on every
		   observation and the chart redraws forever — a permanent frame loop that never idles. Charts
		   are instead sized explicitly from their box (see sizeChart), so no observer exists at all. */
		Chart.defaults.responsive = false;
		Chart.defaults.maintainAspectRatio = false;
		Chart.defaults.plugins.legend.display = false;
		Chart.defaults.plugins.tooltip.backgroundColor = 'rgba(16,16,20,0.97)';
		Chart.defaults.plugins.tooltip.borderColor = COL.line;
		Chart.defaults.plugins.tooltip.borderWidth = 1;
		Chart.defaults.plugins.tooltip.padding = 9;
		Chart.defaults.plugins.tooltip.titleColor = COL.ink;
		Chart.defaults.plugins.tooltip.bodyColor = COL.muted;
		/* the tooltip now lives on <body>, outside .e7rta, so the rank theme has to be carried over */
		if (TIP) {
			TIP.style.setProperty('--e7rta-line', COL.line);
			TIP.style.setProperty('--e7rta-ink', COL.ink);
		}
	}
	function destroyCharts() { pending.length = 0; for (var k in CHARTS) { try { CHARTS[k].destroy(); } catch (e) {} delete CHARTS[k]; } }
	function flush() { var q = pending; pending = []; q.forEach(function (f) { try { f(); } catch (e) {} }); }
	function scheduleFlush() { if (ROOT) void ROOT.offsetHeight; raf(flush); }
	/* Charts are queued and created after layout so canvases have a real size (avoids a 0x0 first paint). */
	function make(id, cfg) {
		if (CHARTS[id]) { try { CHARTS[id].destroy(); } catch (e) {} delete CHARTS[id]; }
		pending.push(function () {
			var cv = ROOT && ROOT.querySelector('#' + id);
			if (!cv) return;
			try {
				var chart = new Chart(cv.getContext('2d'), cfg);
				CHARTS[id] = chart;
				sizeChart(chart);
			} catch (e) {}
		});
		return true;
	}
	/** Size a chart's drawing buffer to its container — the job Chart.js's observer would otherwise do. */
	function sizeChart(chart) {
		var cv = chart && chart.canvas, box = cv && cv.parentNode;
		if (!box) return;
		try {
			chart.resize(Math.max(1, Math.round(box.clientWidth)), Math.max(1, Math.round(box.clientHeight)));
		} catch (e) {}
	}
	/* containers only change size on a window resize or a tab switch, so react to that directly */
	var resizeTimer = null;
	window.addEventListener('resize', function () {
		clearTimeout(resizeTimer);
		resizeTimer = setTimeout(function () { for (var k in CHARTS) sizeChart(CHARTS[k]); }, 150);
	});
	var axis = function (extra) {
		var o = { grid: { color: COL.lineSoft, drawTicks: false }, border: { display: false }, ticks: { color: COL.faint, font: { size: 10 } } };
		for (var k in (extra || {})) o[k] = extra[k];
		return o;
	};

	/* ---------- banner + rail ---------- */
	function renderBanner() {
		var m = state.data.meta, p = state.profile || {};
		var v = state.view;
		// The page's player card lags a battle or two behind, so the rank is read from the newest match
		// (meta.latestRank); the card is only the fallback when the latest match carries no usable grade.
		var fromMatch = m.latestRank && m.latestRank !== 'unranked' ? m.latestRank : null;
		var tierKey = fromMatch || E7Aggregate.rankKey(p.tier || '');
		var tierName = fromMatch ? cap(fromMatch) : (p.tier || T('banner.unranked'));

		var emblem = $('#e7rta-emblem');
		emblem.src = fromMatch ? E7Aggregate.emblemUrl(tierKey) : (p.emblem || E7Aggregate.emblemUrl(tierKey));
		emblem.alt = tierName + ' emblem';

		var avatar = $('#e7rta-avatar');
		if (p.avatar) { avatar.src = p.avatar; avatar.hidden = false; } else { avatar.hidden = true; }

		var who = p.name || (m.nick ? T('banner.player', { n: m.nick }) : T('banner.unknown'));
		$('#e7rta-name').textContent = who;
		$('#e7rta-meta').textContent = [p.server, p.clan].filter(Boolean).join(' · ') || (m.world || '');

		applyTheme(tierKey);
		$('#e7rta-tiername').textContent = tierName;
		$('#e7rta-points').textContent = p.score ? fmtScore(p.score) : (v ? v.summary.lastScore + ' ' + T('unit.pts') : '');
		$('#e7rta-identity').textContent = [p.name || (m.nick ? T('banner.player', { n: m.nick }) : ''), m.world, m.battleCount != null ? T('sub.gamesCaptured', { n: m.battleCount }) : ''].filter(Boolean).join(' · ');
	}

	function renderSummary() {
		var v = state.view, s = v.summary, host = $('#e7rta-summary');
		clear(host);
		var rows = [
			[T('sum.record'), s.wins + '–' + s.losses, s.winRate >= 50 ? 'pos' : 'neg'],
			[T('sum.winRate'), s.winRate + '%', ''],
			[T('sum.net'), signed(s.netDelta), s.netDelta >= 0 ? 'pos' : 'neg'],
			[T('sum.score'), String(s.lastScore), ''],
			[T('sum.peakLow'), s.peak + ' / ' + s.trough, ''],
			[T('sum.sessions'), String(s.sessions), '']
		];
		rows.forEach(function (r) {
			var dt = el('dt', null, r[0]);
			var dd = el('dd', r[2] ? 'e7rta-' + r[2] : null, r[1]);
			host.appendChild(dt); host.appendChild(dd);
		});
	}

	/* A pill list running to twenty tags is noise. Take the strongest from each category first so one
	   category can't crowd out the rest, then fill the remainder by impact strength. */
	var TAG_CAP = 7;
	var TAG_ORDER = { good: 0, neutral: 1, bad: 2 };

	/** Wry rules carry a straight fallback for weak signals, so the joke has to be earned. */
	function tagDetail(t) {
		var base = 'tag.' + t.key;
		var wry = T(base + '.detail', t.params);
		var dry = T(base + '.detailDry', t.params);
		var hasWry = wry !== base + '.detail';
		var hasDry = dry !== base + '.detailDry';
		if (t.impact >= 0.6 && hasWry) return wry;
		return hasDry ? dry : wry;
	}

	function renderTags() {
		var host = $('#e7rta-tags');
		clear(host);
		var all = state.view.tags.slice();

		// expand params that need a translated word before they hit the template
		all.forEach(function (t) {
			if (!t.params || !t.params.elem) return;
			var p = {};
			for (var k in t.params) p[k] = t.params[k];
			p.elem = T('elem.' + t.params.elem);
			t.params = p;
		});

		var picked = [], used = {};
		['playstyle', 'session', 'heroes'].forEach(function (c) {
			var best = null;
			all.forEach(function (t) { if (t.category === c && (!best || t.impact > best.impact)) best = t; });
			if (best) { picked.push(best); used[best.key] = 1; }
		});
		all.slice().sort(function (a, b) { return b.impact - a.impact; }).forEach(function (t) {
			if (picked.length < TAG_CAP && !used[t.key]) { picked.push(t); used[t.key] = 1; }
		});
		picked.sort(function (a, b) { return (TAG_ORDER[a.tone] - TAG_ORDER[b.tone]) || (b.impact - a.impact); });

		picked.forEach(function (t) {
			var label = T('tag.' + t.key + '.label', t.params);
			var detail = tagDetail(t);
			var heroes = (t.params && t.params.heroes) || [];
			var b = el('button', 'e7rta-tag e7rta-tag--' + t.tone + (heroes.length ? ' e7rta-tag--hero' : ''));
			b.type = 'button';
			heroes.forEach(function (h) { b.appendChild(icon(E7Aggregate.heroPortrait(h.code), h.name, 'e7rta-tag-icon')); });
			b.appendChild(document.createTextNode(label));
			b.setAttribute('aria-label', label + ': ' + detail);
			bindTip(b, function () { return '<b>' + label + '</b><br>' + detail; });
			host.appendChild(b);
		});
	}

	/* ---------- recent form + knobs ---------- */
	function renderRecent() {
		var v = state.view, r = v.recent;
		$('#e7rta-recent-sub').textContent = T('sub.lastGames', { n: r.n });
		var strip = $('#e7rta-formstrip');
		clear(strip);
		// most recent game first, so the current run leads the strip
		var form = r.form.slice().reverse();
		form.forEach(function (w, i) {
			var d = el('span', 'e7rta-pip ' + (w ? 'e7rta-pip--win' : 'e7rta-pip--loss'));
			d.title = T('sess.gameN', { n: form.length - i }) + ': ' + (w ? T('match.win') : T('match.loss'));
			strip.appendChild(d);
		});
		var boxHost = $('#e7rta-recent-boxes');
		clear(boxHost);
		var cur = v.streaks.current;
		// the glow on each tile scales with its own metric; the extremes shimmer
		var boxes = [
			{ k: T('box.winRate'), v: r.winRate + '%', heat: heat(r.winRate, 50, 70), shimmer: r.winRate >= 70 },
			{ k: T('box.net'), v: signed(r.net) },
			{ k: T('box.avg'), v: signed(r.avgDelta) },
			{ k: T('box.streak'), v: (cur.win ? 'W' : 'L') + cur.length, heat: cur.win ? heat(cur.length, 2, 5) : 0, shimmer: cur.win && cur.length >= 5 }
		];
		boxes.forEach(function (b) {
			var box = el('div', 'e7rta-box');
			if (b.heat > 0) {
				box.classList.add('e7rta-box--hot');
				box.style.setProperty('--e7rta-heat', b.heat.toFixed(2));
			}
			if (b.shimmer) box.classList.add('e7rta-box--shimmer');
			box.appendChild(el('span', 'e7rta-box-v', b.v));
			box.appendChild(el('span', 'e7rta-box-k', b.k));
			boxHost.appendChild(box);
		});
	}

	/** Normalises a metric onto 0-1 so the glow can scale with it. */
	function heat(value, lo, hi) { return Math.max(0, Math.min(1, (value - lo) / (hi - lo))); }

	function renderKnobs() {
		var pl = state.view.playstyle, host = $('#e7rta-knobs');
		clear(host);
		var knobs = [
			{ title: T('knob.lineup'), left: T('knob.forcer'), right: T('knob.flexible'), value: pl.flex.value, note: pl.flex.n ? T('knob.lineupNote', { v: pl.flex.value, n: pl.flex.n }) : T('knob.noneGames') },
			{ title: T('knob.length'), left: T('knob.siege'), right: T('knob.blitz'), value: pl.tempo.value, note: pl.tempo.n ? T('knob.lengthNote', { turns: pl.tempo.avgTurns }) : T('knob.noTurns') },
			{ title: T('knob.turn'), left: T('knob.reaction'), right: T('knob.initiative'), value: pl.initiative.value, note: pl.initiative.n ? T('knob.turnNote', { v: pl.initiative.value, n: pl.initiative.n }) : T('knob.noGauge') }
		];
		knobs.forEach(function (k) {
			var wrap = el('div', 'e7rta-knob');
			var head = el('div', 'e7rta-knob-head');
			head.appendChild(el('span', 'e7rta-knob-title', k.title));
			head.appendChild(el('span', 'e7rta-knob-note', k.note));
			wrap.appendChild(head);
			var scale = el('div', 'e7rta-knob-scale');
			scale.appendChild(el('span', 'e7rta-knob-end', k.left));
			var track = el('div', 'e7rta-knob-track');
			var mark = el('i');
			mark.style.left = Math.max(0, Math.min(100, k.value)) + '%';
			track.appendChild(mark);
			scale.appendChild(track);
			scale.appendChild(el('span', 'e7rta-knob-end', k.right));
			wrap.appendChild(scale);
			host.appendChild(wrap);
		});
	}

	/* ---------- charts ---------- */
	function renderRankPoints() {
		var rec = state.view.series.slice(-40);
		$('#e7rta-rankpoints-sub').textContent = T('sub.lastMatches', { n: rec.length });
		make('e7rta-c-rankpts', {
			type: 'bar',
			data: {
				labels: rec.map(function (_, i) { return i + 1; }),
				datasets: [{ data: rec.map(function (r) { return r.delta; }), backgroundColor: rec.map(function (r) { return r.win ? COL.win : COL.loss; }), borderRadius: 3, barPercentage: 0.72, categoryPercentage: 0.9 }]
			},
			options: {
				plugins: { tooltip: { callbacks: { title: function (c) { return T('hero.message', { i: c[0].label }); }, label: function (c) { return signed(c.raw) + ' ' + T('sess.points'); } } } },
				scales: { x: axis({ display: false }), y: axis({ ticks: { color: COL.faint, font: { size: 10 }, callback: function (v) { return v > 0 ? '+' + v : v; } } }) }
			}
		});
	}

	function renderJourney() {
		var rec = state.view.series;
		var colors = rec.map(function (r) { return RANK_COLORS[r.rank] || RANK_COLORS.unranked; });
		var win = Math.max(6, Math.min(20, Math.round(rec.length / 5)));
		make('e7rta-c-journey', {
			type: 'line',
			data: {
				labels: rec.map(function (_, i) { return i + 1; }),
				datasets: [
					{
						data: rec.map(function (r) { return r.score; }),
						borderWidth: 2, pointRadius: 0, tension: 0.28, fill: true,
						borderColor: COL.accent, yAxisID: 'y',
						backgroundColor: function (c) {
							var a = c.chart.chartArea; if (!a) return 'transparent';
							var g = c.chart.ctx.createLinearGradient(0, a.top, 0, a.bottom);
							/* the rank's own accent, so the fill follows the tier */
							g.addColorStop(0, COL.accentSoft || 'transparent'); g.addColorStop(1, 'transparent');
							return g;
						},
						segment: { borderColor: function (c) { return colors[c.p1DataIndex] || COL.accent; } }
					},
					/* rolling win rate — deliberately quiet: dashed, unfilled, on its own 0-100 axis */
					{
						data: rollingAligned(rec, win),
						borderColor: COL.faint, borderWidth: 1.2, borderDash: [4, 4],
						pointRadius: 0, tension: 0.3, fill: false, yAxisID: 'y1'
					}
				]
			},
			options: {
				interaction: { intersect: false, mode: 'index' },
				plugins: {
					tooltip: {
						callbacks: {
							title: function (c) { return T('hero.message', { i: c[0].label }); },
							label: function (c) {
								if (c.datasetIndex === 1) return c.raw == null ? undefined : T('hero.winRateWindow', { n: win, pct: c.raw });
								var r = rec[c.dataIndex];
								return T('hero.ptsRank', { score: r.score, rank: cap(r.rank || 'unranked') });
							}
						}
					}
				},
				scales: {
					x: axis({ display: false }),
					y: axis({ ticks: { color: COL.faint, font: { size: 10 } } }),
					y1: axis({ position: 'right', min: 0, max: 100, grid: { display: false }, ticks: { color: COL.faint, font: { size: 10 }, callback: function (v) { return v + '%'; } } })
				}
			}
		});
	}
	/* View-level draft edge: win rate holding first pick vs second pick. Bar length is the number of
	   games in that category (so the two rows scale against each other), split green/red by result;
	   the win rate itself lives in the tooltip. */
	function firstPickCfg(f) {
		var rows = [
			{ k: T('hero.firstPick'), w: f.me.wins, l: f.me.games - f.me.wins, n: f.me.games, rate: f.me.winRate },
			{ k: T('hero.secondPick'), w: f.opp.wins, l: f.opp.games - f.opp.wins, n: f.opp.games, rate: f.opp.winRate }
		];
		return {
			type: 'bar',
			data: {
				labels: rows.map(function (r) { return r.k; }),
				datasets: [
					{ label: T('sess.playedWin'), data: rows.map(function (r) { return r.w; }), backgroundColor: COL.win, stack: 's', borderRadius: 3, barPercentage: 0.36, categoryPercentage: 0.86 },
					{ label: T('sess.playedLoss'), data: rows.map(function (r) { return r.l; }), backgroundColor: COL.loss, stack: 's', borderRadius: 3, barPercentage: 0.36, categoryPercentage: 0.86 }
				]
			},
			options: {
				indexAxis: 'y',
				plugins: {
					tooltip: {
						filter: function (item) { return item.datasetIndex === 0; },
						callbacks: {
							title: function (c) { return rows[c[0].dataIndex].k; },
							label: function (c) {
								var r = rows[c.dataIndex];
								return [T('hero.fpTip', { pct: r.rate, games: r.n }), T('hero.split', { w: r.w, l: r.l })];
							}
						}
					}
				},
				scales: {
					x: axis({ stacked: true, min: 0, ticks: { color: COL.faint, font: { size: 10 }, precision: 0 } }),
					y: axis({ stacked: true, grid: { display: false } })
				}
			}
		};
	}
	function renderFirstPick() {
		make('e7rta-c-fp', firstPickCfg(state.view.firstPickAdvantage));
	}

	function rolling(records, win) {
		var out = [];
		for (var i = win - 1; i < records.length; i++) { var w = 0; for (var j = i - win + 1; j <= i; j++) if (records[j].win) w++; out.push({ i: i, v: (100 * w) / win }); }
		return out;
	}
	function renderSessions() {
		var S = state.view.sessions;
		var stats = $('#e7rta-session-stats');
		clear(stats);
		if (!S.length) { stats.appendChild(el('span', 'e7rta-chip', T('chip.noSessions'))); return; }
		var best = S.slice().sort(function (a, b) { return b.netDelta - a.netDelta; })[0];
		var pool = S.filter(function (s) { return s.battles >= 8; });
		var worst = (pool.length ? pool : S).slice().sort(function (a, b) { return a.winRate - b.winRate; })[0];
		[[T('chip.sessions'), String(state.view.summary.sessions)], [T('chip.avgLength'), state.view.summary.avgSessionGames + ' ' + T('unit.games')], [T('chip.best'), 'S' + best.i + ' ' + signed(best.netDelta)], [T('chip.toughest'), 'S' + worst.i + ' ' + worst.winRate + '%']]
			.forEach(function (c) { var s = el('span', 'e7rta-chip'); s.appendChild(el('b', null, c[1])); var t = document.createTextNode(' ' + c[0]); s.appendChild(t); stats.appendChild(s); });
		var sel = state.view.sessions[state.session];
		var nav = $('#e7rta-session-nav');
		clear(nav);
		if (sel) {
			nav.appendChild(el('span', 'e7rta-chip e7rta-chip--' + (sel.winRate >= 50 ? 'win' : 'loss'), T('chip.session', { i: sel.i, w: sel.wins, l: sel.losses, pct: sel.winRate, net: signed(sel.netDelta) })));
			nav.appendChild(el('span', 'e7rta-chip', fmtDate(sel.start) + ' ' + fmtTime(sel.start) + '–' + fmtTime(sel.end) + ' · ' + sel.durationMin + T('unit.minShort')));
		}
		var bar = make('e7rta-c-sessions', {
			type: 'bar',
			data: {
				labels: S.map(function (s) { return 'S' + s.i; }),
				datasets: [
					{ data: S.map(function (s) { return s.winRate; }), backgroundColor: S.map(function (s, i) { return i === state.session ? COL.accent : (s.winRate >= 50 ? COL.win : COL.loss); }), borderRadius: 4, barPercentage: 0.55, yAxisID: 'y' },
					{ type: 'line', data: S.map(function (s) { return s.netDelta; }), borderColor: COL.muted, borderWidth: 1.5, pointRadius: 0, tension: 0.3, yAxisID: 'y1' }
				]
			},
			options: {
				plugins: { tooltip: { callbacks: {
					title: function (c) { var s = S[c[0].dataIndex]; return T('chip.sessions') + ' ' + s.i + ' · ' + fmtDate(s.start) + ' ' + fmtTime(s.start); },
					label: function (c) { var s = S[c.dataIndex]; return [T('hero.split', { w: s.wins, l: s.losses }) + ' (' + s.winRate + '%)', T('sum.net') + ' ' + signed(s.netDelta), s.battles + ' ' + T('unit.games') + ' · ' + s.durationMin + T('unit.minShort')]; }
				} } },
				onClick: function (evt, els) {
					if (els && els.length) {
						var idx = els[0].index;
						// defer: rebuilding the chart from inside its own click handler tears down the
						// plugin registry while Chart.js is still dispatching the event
						setTimeout(function () {
							state.session = idx;
							renderSessions();
							if (state.tab === 'sessions') renderTab();
							scheduleFlush();
						}, 0);
					}
				},
				scales: {
					x: axis({ grid: { display: false } }),
					y: axis({ min: 0, max: 100, ticks: { color: COL.faint, font: { size: 10 }, callback: function (v) { return v + '%'; } } }),
					y1: axis({ position: 'right', grid: { display: false }, ticks: { color: COL.faint, font: { size: 10 } } })
				}
			}
		});
		return bar;
	}

	/* ---------- bottom tabs ---------- */
	function buildTablist() {
		var host = $('#e7rta-tablist');
		clear(host);
		[['matches', T('tab.matches')], ['heroes', T('tab.heroes')], ['sessions', T('tab.sessions')]].forEach(function (t) {
			var b = el('button', 'e7rta-tab', t[1]);
			b.type = 'button'; b.setAttribute('role', 'tab');
			b.setAttribute('aria-selected', String(state.tab === t[0]));
			b.addEventListener('click', function () { state.tab = t[0]; buildTablist(); renderTab(); scheduleFlush(); });
			host.appendChild(b);
		});
	}
	function renderTab() {
		var host = $('#e7rta-panel');
		clear(host);
		if (state.tab === 'sessions') sessionsTab(host);
		else if (state.tab === 'matches') matchesTab(host);
		else heroesTab(host);
	}

	function chartBlock(host, id, cls) {
		var wrap = el('div', 'e7rta-canvaswrap ' + (cls || ''));
		var cv = el('canvas'); cv.id = id;
		wrap.appendChild(cv); host.appendChild(wrap);
		return wrap;
	}

	var IMGS = {};
	var portraitsRegistered = false;
	function registerPortraitPlugin() {
		if (portraitsRegistered) return;
		portraitsRegistered = true;
		Chart.register({
			id: 'e7rtaPortraits',
			afterDatasetsDraw: function (chart) {
				var opts = (chart.options.plugins || {}).e7rtaPortraits;
				var codes = opts && opts.codes;
				if (!codes || !chart.chartArea) return;
				var meta = chart.getDatasetMeta(0);
				if (!meta || !meta.data) return;
				var ctx = chart.ctx;
				/* horizontal bars carry their labels in the left gutter; vertical ones keep them below */
				var side = chart.options.indexAxis === 'y';
				var size = side ? 20 : 28;
				var drawn = 0;
				meta.data.forEach(function (bar, i) {
					var x = side ? chart.chartArea.left - size - 6 : bar.x - size / 2;
					var y = side ? bar.y - size / 2 : chart.chartArea.bottom + 7;
					var radius = side ? 4 : 6;
					var img = IMGS[codes[i]];
					ctx.save();
					ctx.beginPath();
					if (ctx.roundRect) ctx.roundRect(x, y, size, size, radius); else ctx.rect(x, y, size, size);
					ctx.clip();
					/* the CDN sends no CORS headers, so drawing these taints the canvas — fine for display */
					if (img && img.complete && img.naturalWidth) { ctx.drawImage(img, x, y, size, size); drawn++; }
					else { ctx.fillStyle = 'rgba(255,255,255,.07)'; ctx.fillRect(x, y, size, size); }
					ctx.restore();
					ctx.strokeStyle = 'rgba(255,255,255,.14)';
					ctx.lineWidth = 1;
					ctx.beginPath();
					if (ctx.roundRect) ctx.roundRect(x, y, size, size, radius); else ctx.rect(x, y, size, size);
					ctx.stroke();
				});
				chart.$e7PortraitsDrawn = drawn;
			}
		});
	}
	function preloadPortraits(heroes, done) {
		var cache = {}, left = heroes.length;
		if (!left) { done(cache); return; }
		heroes.forEach(function (h) {
			var img = new Image();
			img.onload = img.onerror = function () { if (--left <= 0) done(cache); };
			img.src = h.portrait;
			cache[h.code] = img;
		});
	}
	function fmtInt(n) { return Math.round(Number(n) || 0).toLocaleString(); }
	function ordinal(n) { return n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'; }
	/** Vietnamese doesn't take English ordinal suffixes on pick slots. */
	function slotName(n) { return E7I18n.lang() === 'vi' ? String(n) : n + ordinal(n); }
	/* Chart.js builds its tooltip model against the live chart, which can outrun the array a callback
	   closed over — so an indexed lookup is never trusted to be in range. */
	function at(list, i) { return (list && i >= 0 && i < list.length) ? list[i] : null; }
	function icon(src, label, cls) {
		var img = el('img', cls);
		img.src = src;
		img.alt = label || '';
		img.loading = 'lazy';
		img.addEventListener('error', function () {
			var fb = el('span', 'e7rta-icon-fb', String(label || '?').slice(0, 2).toUpperCase());
			if (img.parentNode) img.parentNode.replaceChild(fb, img);
		});
		return img;
	}
	function iconStrip(list, max) {
		var wrap = el('div', 'e7rta-iconstrip');
		if (!list || !list.length) { wrap.appendChild(el('span', 'e7rta-sub', '—')); return wrap; }
		list.slice(0, max).forEach(function (x) {
			var im = icon(x.icon, x.name, 'e7rta-iconstrip-img');
			bindTip(im, function () { return '<b>' + x.name + '</b><br>' + T('d.iconMeta', { games: x.games, pct: x.pct }); });
			wrap.appendChild(im);
		});
		return wrap;
	}
	function tile(k, v) {
		var d = el('div', 'e7rta-hd-tile');
		d.appendChild(el('span', 'e7rta-hd-tilev', String(v)));
		d.appendChild(el('span', 'e7rta-hd-tilek', k));
		return d;
	}
	function iconList(list, emptyMsg) {
		var box = el('div', 'e7rta-hd-icons');
		if (!list.length) { box.appendChild(el('span', 'e7rta-sub', emptyMsg)); return box; }
		list.slice(0, 10).forEach(function (x) {
			var row = el('div', 'e7rta-hd-icon');
			row.appendChild(icon(x.icon, x.name, 'e7rta-hd-iconimg'));
			var txt = el('div', 'e7rta-hd-icontext');
			txt.appendChild(el('span', 'e7rta-hd-iconname', x.name));
			txt.appendChild(el('span', 'e7rta-hd-iconmeta', T('d.iconMeta', { games: x.games, pct: x.pct })));
			row.appendChild(txt);
			box.appendChild(row);
		});
		return box;
	}
	function heroDetail(h) {
		var d = el('div', 'e7rta-hdetail');

		// left — compact stat cards, sets and artifacts
		var left = el('div', 'e7rta-hd-left');
		var head = el('div', 'e7rta-hd-head');
		head.appendChild(icon(h.portrait, h.name, 'e7rta-hd-portrait'));
		var who = el('div', 'e7rta-hd-who');
		who.appendChild(el('strong', 'e7rta-hd-name', h.name));
		who.appendChild(el('span', 'e7rta-hd-role', [(h.element || ''), h.role || ''].filter(Boolean).join(' · ')));
		head.appendChild(who);
		left.appendChild(head);

		var t1 = el('div', 'e7rta-hd-tiles e7rta-hd-tiles--sm');
		[[T('t.games'), h.games], [T('d.winShort'), h.winRate + '%'], [T('d.mvp'), h.mvpRate + '%'], [T('d.avgPts'), signed(h.avgDelta)], [T('d.pick'), h.pickRate + '%'], [T('d.ban'), h.banRate + '%']].forEach(function (x) { t1.appendChild(tile(x[0], x[1])); });
		left.appendChild(t1);

		var t2 = el('div', 'e7rta-hd-tiles e7rta-hd-tiles--sm');
		[[T('d.dmg'), fmtInt(h.avgDamage)], [T('d.taken'), fmtInt(h.avgDamageTaken)], [T('d.heal'), fmtInt(h.avgRecovery)], [T('d.kills'), h.avgKills], [T('d.respawns'), h.avgRespawn], [T('d.cr'), h.avgCR == null ? '—' : h.avgCR]].forEach(function (x) { t2.appendChild(tile(x[0], x[1])); });
		left.appendChild(t2);

		var setBlock = el('div', 'e7rta-hd-block');
		setBlock.appendChild(el('h5', 'e7rta-hd-h5', T('hero.itemSets')));
		setBlock.appendChild(iconList(h.setsList, T('d.noSets')));
		left.appendChild(setBlock);

		var artBlock = el('div', 'e7rta-hd-block');
		artBlock.appendChild(el('h5', 'e7rta-hd-h5', T('hero.artifacts')));
		artBlock.appendChild(iconList(h.artifactsList, T('d.noArtifacts')));
		left.appendChild(artBlock);
		d.appendChild(left);

		// right — this hero's draft position and first/second-pick record, as charts
		var right = el('div', 'e7rta-hd-right');
		right.appendChild(el('h5', 'e7rta-hd-h5', T('hero.pickPosition')));
		var sw = el('div', 'e7rta-canvaswrap e7rta-canvaswrap--hd');
		var sc = el('canvas'); sc.id = 'e7rta-c-hd-slots';
		sw.appendChild(sc); right.appendChild(sw);
		right.appendChild(el('h5', 'e7rta-hd-h5', T('hero.companions')));
		if (!h.companions || !h.companions.length) {
			right.appendChild(el('p', 'e7rta-sub', T('hero.noCompanions')));
		} else {
			var cw = el('div', 'e7rta-canvaswrap e7rta-canvaswrap--hd-comp');
			var cc = el('canvas'); cc.id = 'e7rta-c-hd-comp';
			cw.appendChild(cc); right.appendChild(cw);
		}
		right.appendChild(el('h5', 'e7rta-hd-h5', T('hero.firstVsSecond')));
		var fw = el('div', 'e7rta-canvaswrap e7rta-canvaswrap--hd-sm');
		var fc = el('canvas'); fc.id = 'e7rta-c-hd-fp';
		fw.appendChild(fc); right.appendChild(fw);
		d.appendChild(right);

		return d;
	}

	/* ---------- matches tab ---------- */
	var MATCH_PAGE = 60;

	/* The game's own formation, read off the draft rows: position 1 sits nearest the enemy, 4 at the
	   back, with 3 above and 2 below in the middle column. The right-hand team is the mirror of that,
	   so 1 lands leftmost and 4 rightmost. */
	function posColumn(pos, mirror) {
		var col = pos === 4 ? 1 : pos === 1 ? 3 : 2;
		return mirror ? 4 - col : col;
	}
	function posRow(pos) { return pos === 3 ? '1' : pos === 2 ? '2' : '1 / span 2'; }
	function fmtClock(sec) {
		var s = Math.round(Number(sec) || 0);
		return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
	}

	function matchesTab(host) {
		var all = state.view.series;
		if (!all.length) { host.appendChild(el('p', 'e7rta-sub', T('match.none'))); return; }

		var head = el('div', 'e7rta-hsection');
		head.appendChild(el('h4', 'e7rta-h4', T('tab.matches')));
		head.appendChild(el('p', 'e7rta-sub', T('match.order', { n: all.length })));
		host.appendChild(head);

		var list = el('div', 'e7rta-matches');
		var shown = Math.min(state.matchShown, all.length);
		for (var i = all.length - 1; i >= all.length - shown; i--) list.appendChild(matchRow(all[i]));
		host.appendChild(list);

		var left = all.length - shown;
		if (left > 0) {
			var more = el('button', 'e7rta-more', T('match.more') + ' (' + left + ')');
			more.type = 'button';
			more.addEventListener('click', function () { state.matchShown += MATCH_PAGE; renderTab(); });
			host.appendChild(more);
		}
	}

	function agoOf(t) {
		var mins = Math.round((Date.now() - new Date(t).getTime()) / 60000);
		if (mins < 1) return T('ago.now');
		if (mins < 60) return T('ago.min', { n: mins });
		var hrs = Math.round(mins / 60);
		if (hrs < 24) return T('ago.hour', { n: hrs });
		return T('ago.day', { n: Math.round(hrs / 24) });
	}

	function heroTip(r) {
		return function () {
			if (r.banned) return '<b>' + r.name + '</b><br>' + T('match.banned');
			return '<b>' + r.name + '</b><br>' +
				T('match.score') + ': ' + fmtInt(r.mvpPoint) + '<br>' +
				T('match.dealt') + ': ' + fmtInt(r.damage) + '<br>' +
				T('match.suffered') + ': ' + fmtInt(r.taken) + '<br>' +
				T('match.recovered') + ': ' + fmtInt(r.recovery) + '<br>' +
				T('match.revived') + ': ' + r.respawn + '<br>' +
				T('d.kills') + ': ' + r.kills;
		};
	}
	function gearIcon(src, label) {
		var im = icon(src, label, 'e7rta-hstat-ico');
		bindTip(im, function () { return '<b>' + label + '</b>'; });
		return im;
	}
	function heroStatCard(row) {
		var c = el('div', 'e7rta-hstat' + (row.banned ? ' e7rta-hstat--ban' : '') + (row.mvp ? ' e7rta-hstat--mvp' : ''));
		var top = el('div', 'e7rta-hstat-top');
		top.appendChild(icon(row.portrait, row.name, 'e7rta-hstat-img'));
		var who = el('div', 'e7rta-hstat-who');
		who.appendChild(el('span', 'e7rta-hstat-name', row.name));
		var tags = [];
		if (row.level) tags.push(T('match.levelN', { n: row.level }));
		if (row.mvp) tags.push('MVP');
		tags.push(row.position >= 1 && row.position <= 4 ? T('match.slotN', { n: slotName(row.position) }) : T('match.banned'));
		who.appendChild(el('span', 'e7rta-hstat-tags', tags.join(' · ')));
		top.appendChild(who);
		top.appendChild(el('span', 'e7rta-hstat-score', fmtInt(row.mvpPoint)));
		c.appendChild(top);

		if (!row.banned) {
			/* one cell per stat in a two-column grid, with the gear tucked into the last cell —
			   keeps the card three rows tall instead of six */
			var stats = el('div', 'e7rta-hstat-stats');
			[[T('d.dmg'), row.damage], [T('d.taken'), row.taken], [T('d.heal'), row.recovery], [T('d.respawns'), row.respawn], [T('d.kills'), row.kills]].forEach(function (p) {
				var cell = el('span', 'e7rta-hstat-stat');
				cell.appendChild(el('i', null, p[0]));
				cell.appendChild(el('b', null, fmtInt(p[1])));
				stats.appendChild(cell);
			});
			var gear = el('span', 'e7rta-hstat-gear');
			(row.setIcons || []).forEach(function (s) { gear.appendChild(gearIcon(s.icon, s.name)); });
			if (row.artifactIco) gear.appendChild(gearIcon(row.artifactIco, row.artifactName || row.artifact));
			if (gear.childNodes.length) stats.appendChild(gear);
			c.appendChild(stats);
		}
		bindTip(c, heroTip(row));
		return c;
	}
	/** A side's heroes as a stack of performance cards. */
	function cardColumn(rows, label) {
		var box = el('div', 'e7rta-mcol');
		box.appendChild(el('h6', 'e7rta-team-title', label));
		var cards = el('div', 'e7rta-mcards');
		// a banned hero never took a turn, so it gets no performance card
		rows.filter(function (row) { return !row.banned; }).forEach(function (row) { cards.appendChild(heroStatCard(row)); });
		box.appendChild(cards);
		return box;
	}

	/** One side of the formation. Bans are rendered in a sibling row, not here, so this box is exactly
	    the formation's height and the VS beside it centres on the formation rather than on the bans. */
	function formationHalf(rows, mirror) {
		var box = el('div', 'e7rta-mhalf' + (mirror ? ' e7rta-mhalf--foe' : ''));
		var grid = el('div', 'e7rta-form');
		var placed = rows.filter(function (x) { return x.position >= 1 && x.position <= 4; });
		[1, 2, 3, 4].forEach(function (p) {
			var row = null;
			for (var i = 0; i < placed.length; i++) if (placed[i].position === p) { row = placed[i]; break; }
			if (!row) return;
			var cell = unitCell(row);
			cell.style.gridColumn = String(posColumn(p, mirror));
			cell.style.gridRow = posRow(p);
			grid.appendChild(cell);
		});
		box.appendChild(grid);
		return box;
	}

	/** Anything without a formation slot: the ban, or an opponent payload we could not parse. */
	function sideBans(rows) { return rows.filter(function (x) { return !(x.position >= 1 && x.position <= 4); }); }
	function banChips(rows, mirror) {
		var wrap = el('div', 'e7rta-team-bans' + (mirror ? ' e7rta-team-bans--foe' : ''));
		rows.forEach(function (row) {
			var im = icon(row.portrait, row.name, 'e7rta-mstrip-img e7rta-mstrip-img--ban');
			bindTip(im, heroTip(row));
			wrap.appendChild(im);
		});
		return wrap;
	}

	/** Middle column: the match metadata and pre-bans on top, then formations, bans and the gauge. */
	function midColumn(r) {
		var box = el('div', 'e7rta-mmid');

		var meta = el('div', 'e7rta-mmeta');
		var top = el('div', 'e7rta-mmeta-top');
		top.appendChild(el('span', 'e7rta-mmeta-res', r.win ? T('match.win') : T('match.loss')));
		top.appendChild(el('span', 'e7rta-mmeta-delta', signed(r.delta)));
		top.appendChild(el('span', 'e7rta-mmeta-score', T('match.scoreLine', { from: r.before, to: r.score }) + (r.rank ? ' · ' + cap(r.rank) : '')));
		meta.appendChild(top);
		meta.appendChild(el('span', 'e7rta-mmeta-when', agoOf(r.t) + ' · ' + fmtDateTime(r.t)));

		var chips = el('div', 'e7rta-mmeta-chips');
		if (r.turns != null) chips.appendChild(el('span', 'e7rta-mmeta-chip', T('match.turnsN', { n: r.turns })));
		if (r.seconds != null) chips.appendChild(el('span', 'e7rta-mmeta-chip', T('match.timeN', { t: fmtClock(r.seconds) })));
		// the draft has exactly two roles — first pick and second pick — so state which one we hold
		var fpChip = el('span', 'e7rta-mmeta-chip' + (r.fp === 'me' ? ' e7rta-mmeta-chip--ours' : ''),
			T('match.you') + ': ' + (r.fp === 'me' ? T('match.firstPick') : T('match.secondPick')));
		chips.appendChild(fpChip);
		if (r.openingRule) chips.appendChild(el('span', 'e7rta-mmeta-chip', T('rule.' + r.openingRule)));
		meta.appendChild(chips);

		var players = el('div', 'e7rta-mplayers');
		players.appendChild(el('span', null, T('match.you')));
		players.appendChild(el('span', null, (r.foeNick ? T('banner.player', { n: r.foeNick }) : T('match.opponent')) + (r.foeWorld ? ' · ' + String(r.foeWorld).replace(/^world_/, '') : '')));
		meta.appendChild(players);

		var pre = prebanStrip(r);
		if (pre) meta.appendChild(pre);
		box.appendChild(meta);

		var form = el('div', 'e7rta-mform');
		form.appendChild(formationHalf(r.myRows, false));
		form.appendChild(el('span', 'e7rta-mform-vs', T('match.vs')));
		form.appendChild(formationHalf(r.foeRows, true));
		box.appendChild(form);

		var mine = sideBans(r.myRows), theirs = sideBans(r.foeRows);
		if (mine.length || theirs.length) {
			// same three columns as the formation, so each ban sits under its own side
			var bans = el('div', 'e7rta-mbans');
			bans.appendChild(mine.length ? banChips(mine, false) : el('span'));
			bans.appendChild(el('span'));
			bans.appendChild(theirs.length ? banChips(theirs, true) : el('span'));
			box.appendChild(bans);
		}

		var gauge = energyGauge(r);
		if (gauge) box.appendChild(gauge);
		return box;
	}

	/** Opening combat readiness on a single straight line. The axis spans the observed range — the
	    leftmost hero is the lowest energy and the rightmost the highest — so the spread is readable
	    even though opening energies cluster tightly. Overlapping portraits are intentional. */
	function energyGauge(r) {
		var list = (r.readiness || []).slice();
		if (!list.length) return null;
		var box = el('div', 'e7rta-gauge');
		box.appendChild(el('h6', 'e7rta-team-title', T('match.readiness')));

		list.sort(function (a, b) { return a.energy - b.energy; });
		var minE = list[0].energy, maxE = list[list.length - 1].energy;
		var span = maxE - minE;

		var track = el('div', 'e7rta-gauge-track');
		list.forEach(function (h) {
			var pos = span ? (100 * (h.energy - minE)) / span : 50;
			var im = icon(h.portrait, h.name, 'e7rta-gauge-img' + (h.mine ? '' : ' e7rta-gauge-img--foe'));
			im.style.left = pos + '%';
			bindTip(im, function () { return '<b>' + h.name + '</b><br>' + h.energy + '%'; });
			track.appendChild(im);
		});
		box.appendChild(track);

		var axis = el('div', 'e7rta-gauge-axis');
		axis.appendChild(el('span', null, minE + '%'));
		axis.appendChild(el('span', null, maxE + '%'));
		box.appendChild(axis);
		return box;
	}
	function prebanStrip(r) {
		var rows = (r.prebanRows || []).concat(r.foePrebanRows || []);
		if (!rows.length) return null;
		var box = el('div', 'e7rta-mpre');
		box.appendChild(el('span', 'e7rta-mpre-label', T('match.prebans')));
		rows.forEach(function (p) {
			var im = icon(p.portrait, p.name, 'e7rta-mpre-img');
			bindTip(im, function () { return '<b>' + p.name + '</b>'; });
			box.appendChild(im);
		});
		return box;
	}
	function sideStrip(rows) {
		var box = el('div', 'e7rta-mstrip-side');
		rows.forEach(function (row) {
			var cls = 'e7rta-mstrip-img' + (row.banned ? ' e7rta-mstrip-img--ban' : '') + (row.mvp ? ' e7rta-mstrip-img--mvp' : '');
			var im = icon(row.portrait, row.name, cls);
			bindTip(im, heroTip(row));
			box.appendChild(im);
		});
		return box;
	}

	function matchRow(r) {
		var open = state.matchOpen === r.seq;
		var card = el('div', 'e7rta-match ' + (r.win ? 'e7rta-match--win' : 'e7rta-match--loss') + (open ? ' e7rta-match--open' : ''));
		var head = el('button', 'e7rta-match-head');
		head.type = 'button';
		head.setAttribute('aria-expanded', String(open));
		head.setAttribute('aria-label', T('match.openMatch'));

		var badge = el('div', 'e7rta-match-badge');
		badge.appendChild(el('span', 'e7rta-match-res', r.win ? T('match.win') : T('match.loss')));
		badge.appendChild(el('span', 'e7rta-match-delta', signed(r.delta)));
		head.appendChild(badge);

		var strip = el('div', 'e7rta-mstrip');
		strip.appendChild(sideStrip(r.myRows));
		strip.appendChild(el('span', 'e7rta-mstrip-vs', T('match.vs')));
		strip.appendChild(sideStrip(r.foeRows));
		head.appendChild(strip);

		var meta = el('div', 'e7rta-match-meta');
		meta.appendChild(el('span', 'e7rta-match-when', agoOf(r.t) + ' · ' + fmtDateTime(r.t)));
		var facts = [];
		if (r.turns != null) facts.push(T('match.turnsN', { n: r.turns }));
		if (r.seconds != null) facts.push(T('match.timeN', { t: fmtClock(r.seconds) }));
		facts.push(T('match.scoreLine', { from: r.before, to: r.score }));
		meta.appendChild(el('span', 'e7rta-match-facts', facts.join(' · ')));

		// meta + chevron share the right column so the team-vs-team strip can sit dead centre
		var tail = el('div', 'e7rta-match-tail');
		tail.appendChild(meta);
		tail.appendChild(el('span', 'e7rta-match-chev', open ? '▴' : '▾'));
		head.appendChild(tail);
		head.addEventListener('click', function () { state.matchOpen = open ? null : r.seq; renderTab(); });
		card.appendChild(head);
		if (open) card.appendChild(matchDetail(r));
		return card;
	}

	function unitCell(row) {
		var cell = el('div', 'e7rta-unit' + (row.banned ? ' e7rta-unit--ban' : '') + (row.mvp ? ' e7rta-unit--mvp' : ''));
		cell.appendChild(icon(row.portrait, row.name, 'e7rta-unit-img'));
		cell.appendChild(el('span', 'e7rta-unit-name', row.name));
		bindTip(cell, heroTip(row));
		return cell;
	}

	function matchDetail(r) {
		var d = el('div', 'e7rta-mdetail');

		/* three columns: your cards, the match itself (metadata + formation + gauge), their cards */
		var body = el('div', 'e7rta-mbody');
		body.appendChild(cardColumn(r.myRows, T('match.myTeam')));
		body.appendChild(midColumn(r));
		body.appendChild(cardColumn(r.foeRows, T('match.foeTeam')));
		d.appendChild(body);

		return d;
	}

	function heroesTab(host) {
		var v = state.view;
		var heroes = v.heroes.filter(function (h) { return h.games > 0; });

		// row 1 — stacked win/loss columns (expands to fit, scrolls only when it overflows)
		var s1 = el('div', 'e7rta-hsection');
		s1.appendChild(el('h4', 'e7rta-h4', T('hero.byRecord')));
		var scroll = el('div', 'e7rta-scroll');
		var inner = el('div', 'e7rta-scroll-inner');
		inner.style.minWidth = (heroes.length * 34) + 'px';
		inner.style.height = '296px';
		var cv1 = el('canvas'); cv1.id = 'e7rta-c-heroes';
		inner.appendChild(cv1); scroll.appendChild(inner); s1.appendChild(scroll);
		host.appendChild(s1);

		// row 2 — ledger table with an expanding per-hero panel
		var s3 = el('div', 'e7rta-hsection');
		s3.appendChild(el('h4', 'e7rta-h4', T('hero.ledger')));
		var tableHost = el('div');
		tableHost.id = 'e7rta-hero-table';
		s3.appendChild(tableHost);
		host.appendChild(s3);
		buildHeroTable(tableHost, heroes);

		// charts (images first, so the portrait plugin can draw them)
		registerPortraitPlugin();
		preloadPortraits(heroes, function (cache) {
			IMGS = cache;
			make('e7rta-c-heroes', heroChartCfg(heroes));
			scheduleFlush();
		});
	}

	/** Per-hero pick position: bar LENGTH is the number of games drafted in that slot. */
	function hdSlotsCfg(h) {
		return {
			type: 'bar',
			data: {
				labels: h.slots.map(function (s) { return slotName(s.slot); }),
				datasets: [
					{ label: 'Won', data: h.slots.map(function (s) { return s.wins; }), backgroundColor: COL.win, stack: 's', borderRadius: 3 },
					{ label: 'Lost', data: h.slots.map(function (s) { return s.losses; }), backgroundColor: COL.loss, stack: 's', borderRadius: 3 }
				]
			},
			options: {
				indexAxis: 'y',
				plugins: {
					tooltip: {
						/* nearest + intersect resolves one segment, so this tooltip was never duplicated —
						   do NOT switch to index mode here: on a horizontal chart it resolves the index
						   from x, which pins the tooltip to a single slot. */
						callbacks: {
							label: function (c) {
								var s = h.slots[c.dataIndex];
								return T('hero.slotTip', { games: s.games, pct: s.winRate, w: s.wins, l: s.losses });
							}
						}
					}
				},
				scales: {
					x: axis({ stacked: true, ticks: { color: COL.faint, font: { size: 10 }, precision: 0 }, title: { display: true, text: T('hero.slotsAxis'), color: COL.faint, font: { size: 10 } } }),
					y: axis({ stacked: true, grid: { display: false } })
				}
			}
		};
	}
	function hdFpCfg(h) {
		return {
			type: 'bar',
			data: { labels: [T('hero.firstPick'), T('hero.secondPick')], datasets: [{ data: [h.firstPickWinRate, h.secondPickWinRate], backgroundColor: [COL.accent, COL.faint], borderRadius: 4, barPercentage: 0.6 }] },
			options: {
				indexAxis: 'y',
				plugins: {
					tooltip: {
						callbacks: {
							label: function (c) {
								var g = c.dataIndex === 0 ? h.firstPickGames : h.secondPickGames;
								return T('hero.fpTip', { pct: c.raw, games: g });
							}
						}
					}
				},
				scales: { x: axis({ min: 0, max: 100, ticks: { color: COL.faint, font: { size: 10 }, callback: function (x) { return x + '%'; } } }), y: axis({ grid: { display: false } }) }
			}
		};
	}


	/** Who this hero gets drafted alongside: bar length is the games together, the split is the
	    record. Portraits label the rows, drawn by the shared e7rtaPortraits plugin. */
	function hdCompCfg(h) {
		var cs = h.companions || [];
		return {
			type: 'bar',
			data: {
				labels: cs.map(function (c) { return c.name; }),
				datasets: [
					{ label: 'Won', data: cs.map(function (c) { return c.wins; }), backgroundColor: COL.win, stack: 'c', borderRadius: 2, barPercentage: 0.34, categoryPercentage: 0.92 },
					{ label: 'Lost', data: cs.map(function (c) { return c.games - c.wins; }), backgroundColor: COL.loss, stack: 'c', borderRadius: 2, barPercentage: 0.34, categoryPercentage: 0.92 }
				]
			},
			options: {
				indexAxis: 'y',
				interaction: { mode: 'index', intersect: false },
				plugins: {
					e7rtaPortraits: { codes: cs.map(function (c) { return c.code; }) },
					tooltip: {
						/* one entry only: the two datasets are halves of the same bar, so printing the
						   record per dataset shows the same lines twice */
						filter: function (item) { return item.datasetIndex === 0; },
						callbacks: {
							title: function (c) { return cs[c[0].dataIndex].name; },
							label: function (c) {
								var k = cs[c.dataIndex];
								return [T('hero.compTip', { games: k.games, pct: k.winRate }), T('hero.split', { w: k.wins, l: k.games - k.wins })];
							}
						}
					}
				},
				scales: {
					x: axis({ stacked: true, ticks: { color: COL.faint, font: { size: 10 }, precision: 0 } }),
					/* the tick text is hidden, but the axis keeps a fixed width so the portraits get a gutter */
					y: axis({ stacked: true, grid: { display: false }, ticks: { display: false }, afterFit: function (sc) { sc.width = 30; } })
				}
			}
		};
	}


	function heroChartCfg(heroes) {
		return {
			type: 'bar',
			data: {
				labels: heroes.map(function (h) { return h.name; }),
				datasets: [
					{ label: 'Wins', data: heroes.map(function (h) { return h.wins; }), backgroundColor: COL.win, stack: 's', borderRadius: 3, barPercentage: 0.72, categoryPercentage: 0.86 },
					{ label: 'Losses', data: heroes.map(function (h) { return h.games - h.wins; }), backgroundColor: COL.loss, stack: 's', borderRadius: 3, barPercentage: 0.72, categoryPercentage: 0.86 }
				]
			},
			options: {
				layout: { padding: { bottom: 40 } },
				interaction: { mode: 'index', intersect: false },
				plugins: {
					e7rtaPortraits: { codes: heroes.map(function (h) { return h.code; }) },
					tooltip: {
						/* one entry only: Wins and Losses are two halves of one bar, so printing the
						   record once per dataset shows the exact same three lines twice */
						filter: function (item) { return item.datasetIndex === 0; },
						callbacks: {
							title: function (c) { return heroes[c[0].dataIndex].name; },
							label: function (c) {
								var h = heroes[c.dataIndex];
								var lines = [T('hero.record', { games: h.games, pct: h.winRate }), T('hero.split', { w: h.wins, l: h.games - h.wins })];
								if (h.avgDamage != null) lines.push(T('hero.avgLine', { dmg: fmtInt(h.avgDamage), pts: signed(h.avgDelta) }));
								return lines;
							}
						}
					}
				},
				scales: {
					x: axis({ stacked: true, grid: { display: false }, ticks: { display: false } }),
					y: axis({ stacked: true, ticks: { color: COL.faint, font: { size: 10 }, precision: 0 } })
				}
			}
		};
	}
	function buildHeroTable(host, heroes) {
		clear(host);
		var wrap = el('div', 'e7rta-tablewrap');
		var tbl = el('table', 'e7rta-ledger');
		var thead = el('thead'); var tr = el('tr');
		[T('t.hero'), T('t.games'), T('t.winPct'), T('t.mvpPct'), T('t.avgDmg'), T('t.avgTaken'), T('t.avgHeal'), T('t.kills'), T('t.slot'), T('t.cr'), T('t.sets'), T('t.artifact')].forEach(function (h) { tr.appendChild(el('th', null, h)); });
		thead.appendChild(tr); tbl.appendChild(thead);
		var tb = el('tbody');
		heroes.forEach(function (h) {
			var row = el('tr', 'e7rta-hrow');
			row.tabIndex = 0;
			row.setAttribute('role', 'button');
			row.setAttribute('aria-expanded', String(state.heroOpen === h.code));
			var td0 = el('td', 'e7rta-hero-cell');
			td0.appendChild(icon(h.portrait, h.name, 'e7rta-portrait'));
			td0.appendChild(document.createTextNode(h.name));
			row.appendChild(td0);
			var best = h.slots.slice().sort(function (a, b) { return b.games - a.games; })[0];
			[h.games, h.winRate + '%', h.mvpRate + '%', fmtInt(h.avgDamage), fmtInt(h.avgDamageTaken), fmtInt(h.avgRecovery), h.avgKills, best && best.games ? slotName(best.slot) + ' · ' + pctOf(best.games, h.games) + '%' : '—', h.avgCR == null ? '—' : String(h.avgCR)].forEach(function (t) { row.appendChild(el('td', null, String(t))); });
			var setCell = el('td', 'e7rta-iconcell');
			setCell.appendChild(iconStrip(h.setsList, 3));
			row.appendChild(setCell);
			var artCell = el('td', 'e7rta-iconcell');
			artCell.appendChild(iconStrip(h.artifactsList, 2));
			row.appendChild(artCell);
			var toggle = (function (code) { return function () { state.heroOpen = state.heroOpen === code ? null : code; buildHeroTable(host, heroes); }; })(h.code);
			row.addEventListener('click', toggle);
			row.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
			tb.appendChild(row);
			if (state.heroOpen === h.code) {
				var dr = el('tr', 'e7rta-hdetailrow');
				var dc = el('td'); dc.colSpan = 12;
				dc.appendChild(heroDetail(h));
				dr.appendChild(dc); tb.appendChild(dr);
			}
		});
		tbl.appendChild(tb); wrap.appendChild(tbl); host.appendChild(wrap);
		if (state.heroOpen) {
			var open = null;
			for (var i = 0; i < heroes.length; i++) if (heroes[i].code === state.heroOpen) { open = heroes[i]; break; }
			if (open) {
				make('e7rta-c-hd-slots', hdSlotsCfg(open));
				make('e7rta-c-hd-fp', hdFpCfg(open));
				scheduleFlush();
				if (open.companions && open.companions.length) {
					// portraits first, so the plugin can draw them as the columns' labels
					registerPortraitPlugin();
					preloadPortraits(open.companions, function (cache) {
						/* merge rather than assign: the heroes chart at the top of this tab shares the cache */
						for (var k in cache) IMGS[k] = cache[k];
						make('e7rta-c-hd-comp', hdCompCfg(open));
						scheduleFlush();
					});
				}
			}
		}
	}
	function pctOf(w, n) { return n ? Math.round((100 * w) / n) : 0; }


	/** Rolling win-rate series aligned to the match index (leading nulls while the window fills). */
	function rollingAligned(records, win) {
		var out = [], count = 0;
		for (var i = 0; i < records.length; i++) {
			if (records[i].win) count++;
			if (i >= win && records[i - win].win) count--;
			out.push(i >= win - 1 ? Math.round((1000 * count) / win) / 10 : null);
		}
		return out;
	}

	/** The selected session: journey and stats, plus the warm-up / fatigue curve. */
	function sessionsTab(host) {
		var v = state.view;
		var S = v.sessions;
		var sel = S[state.session];
		if (!sel) { host.appendChild(el('p', 'e7rta-sub', T('sess.none'))); return; }

		var s1 = el('div', 'e7rta-hsection');
		s1.appendChild(el('h4', 'e7rta-h4', T('sess.header', { i: sel.i, n: S.length, date: fmtDate(sel.start), from: fmtTime(sel.start), to: fmtTime(sel.end) })));
		var tiles = el('div', 'e7rta-sess-tiles');
		[[T('sess.games'), sel.battles], [T('sess.record'), T('hero.split', { w: sel.wins, l: sel.losses })], [T('sess.winRate'), sel.winRate + '%'], [T('sess.net'), signed(sel.netDelta)], [T('sess.length'), T('sess.minutes', { n: sel.durationMin })], [T('sess.score'), sel.startScore + ' → ' + sel.endScore]]
			.forEach(function (x) { tiles.appendChild(tile(x[0], x[1])); });
		s1.appendChild(tiles);
		var cw = el('div', 'e7rta-canvaswrap e7rta-canvaswrap--sess');
		var cv = el('canvas'); cv.id = 'e7rta-c-sess-journey';
		cw.appendChild(cv); s1.appendChild(cw);
		s1.appendChild(el('p', 'e7rta-sub', T('sess.scoreNote')));
		host.appendChild(s1);

		var s2 = el('div', 'e7rta-hsection');
		s2.appendChild(el('h4', 'e7rta-h4', T('hero.gameByGame')));
		var strip = el('div', 'e7rta-strip');
		sel.games.forEach(function (g, i) {
			var cell = el('div', 'e7rta-cell ' + (g.win ? 'e7rta-cell--win' : 'e7rta-cell--loss'));
			cell.setAttribute('role', 'listitem');
			cell.innerHTML = '<span class="e7rta-cell-pts" aria-hidden="true">' + signed(g.delta) + '</span><span class="e7rta-cell-n" aria-hidden="true">' + (i + 1) + '</span><span class="e7rta-sr">' + T('sess.gameN', { n: i + 1 }) + ': ' + (g.win ? T('sess.playedWin') : T('sess.playedLoss')) + ', ' + signed(g.delta) + ' ' + T('sess.points') + '</span>';
			bindTip(cell, (function (gg, ii) {
				return function () {
					return '<b>' + T('sess.gameN', { n: ii + 1 }) + '</b> ' + fmtTime(gg.t) + '<dl><dt>' + T('sess.result') + '</dt><dd>' + (gg.win ? T('sess.playedWin') : T('sess.playedLoss')) + '</dd><dt>' + T('sess.points') + '</dt><dd>' + signed(gg.delta) + '</dd><dt>' + T('sess.turns') + '</dt><dd>' + (gg.turns == null ? '—' : gg.turns) + '</dd><dt>' + T('sess.team') + '</dt><dd>' + (gg.played.join(', ') || '—') + '</dd></dl>';
				};
			})(g, i));
			strip.appendChild(cell);
		});
		s2.appendChild(strip);
		host.appendChild(s2);

		var s3 = el('div', 'e7rta-hsection');
		s3.appendChild(el('h4', 'e7rta-h4', T('hero.usedThisSession')));
		var hscroll = el('div', 'e7rta-scroll');
		var hinner = el('div', 'e7rta-scroll-inner');
		hinner.style.minWidth = (sel.heroes.length * 34) + 'px';
		hinner.style.height = '240px';
		var hcv = el('canvas'); hcv.id = 'e7rta-c-sess-heroes';
		hinner.appendChild(hcv); hscroll.appendChild(hinner); s3.appendChild(hscroll);
		s3.appendChild(el('p', 'e7rta-sub', T('hero.usedNote', { heroes: sel.heroes.length, games: sel.battles })));
		host.appendChild(s3);

		var s4 = el('div', 'e7rta-hsection');
		s4.appendChild(el('h4', 'e7rta-h4', T('hero.warmup')));
		var ww = el('div', 'e7rta-canvaswrap e7rta-canvaswrap--warmup');
		var wc = el('canvas'); wc.id = 'e7rta-c-warmup';
		ww.appendChild(wc); s4.appendChild(ww);
		s4.appendChild(el('p', 'e7rta-sub', T('hero.warmupNote')));
		host.appendChild(s4);

		make('e7rta-c-sess-journey', sessJourneyCfg(sel));
		make('e7rta-c-warmup', warmupChartCfg(v.byBucket));
		registerPortraitPlugin();
		preloadPortraits(sel.heroes, function (cache) {
			IMGS = cache;
			make('e7rta-c-sess-heroes', heroChartCfg(sel.heroes));
			scheduleFlush();
		});
	}

	function sessJourneyCfg(s) {
		return {
			type: 'line',
			data: {
				labels: s.games.map(function (_, i) { return i + 1; }),
				datasets: [{
					data: s.games.map(function (g) { return g.score; }),
					borderColor: COL.accent, borderWidth: 2, pointRadius: 3.5, tension: 0.25, fill: false,
					pointBackgroundColor: s.games.map(function (g) { return g.win ? COL.win : COL.loss; }),
					pointBorderColor: s.games.map(function (g) { return g.win ? COL.win : COL.loss; })
				}]
			},
			options: {
				plugins: {
					tooltip: {
						callbacks: {
							title: function (c) {
								var g = at(s.games, c[0] && c[0].dataIndex);
								return T('sess.gameN', { n: c[0] && c[0].label }) + (g ? ' · ' + fmtTime(g.t) : '');
							},
							label: function (c) {
								var g = at(s.games, c.dataIndex);
								if (!g) return '';
								return [(g.win ? T('sess.playedWin') : T('sess.playedLoss')) + ' ' + signed(g.delta), T('sess.score') + ' ' + g.score, (g.turns == null ? '—' : g.turns) + ' ' + T('unit.turns')];
							}
						}
					}
				},
				scales: {
					x: axis({ grid: { display: false }, title: { display: true, text: T('sess.axis'), color: COL.faint, font: { size: 10 } } }),
					y: axis({ ticks: { color: COL.faint, font: { size: 10 } } })
				}
			}
		};
	}
	function warmupChartCfg(byBucket) {
		return {
			type: 'bar',
			data: {
				labels: byBucket.map(function (b) { return b.label; }),
				datasets: [{ data: byBucket.map(function (b) { return b.winRate; }), backgroundColor: byBucket.map(function (b) { return b.winRate >= 50 ? COL.win : COL.loss; }), borderRadius: 4, barPercentage: 0.7 }]
			},
			options: {
				plugins: {
					tooltip: {
						callbacks: {
							label: function (c) { var b = byBucket[c.dataIndex]; return [b.winRate + '% win rate', 'n=' + b.battles + ' · net ' + signed(b.netDelta)]; }
						}
					}
				},
				scales: { x: axis({ grid: { display: false } }), y: axis({ min: 0, max: 100, ticks: { color: COL.faint, font: { size: 10 }, callback: function (x) { return x + '%'; } } }) }
			}
		};
	}

	/* ---------- season filter ---------- */
	function renderSeasonFilter() {
		var host = $('#e7rta-season');
		clear(host);
		state.data.views.forEach(function (v) {
			var b = el('button', null, v.label);
			b.type = 'button';
			b.setAttribute('aria-pressed', String(state.view.key === v.key));
			b.addEventListener('click', function () {
				state.view = v; state.session = v.sessions.length ? v.sessions.length - 1 : 0;
				Array.prototype.forEach.call(host.querySelectorAll('button'), function (x) { x.setAttribute('aria-pressed', 'false'); });
				b.setAttribute('aria-pressed', 'true');
				render();
			});
			host.appendChild(b);
		});
	}

	/* ---------- orchestration ---------- */
	/* Three overlay states: 'data' (the dashboard), 'loading' (spinner while the history streams in),
	   and 'empty' (nothing captured for this player). */
	function setState(mode) {
		renderChrome();
		var rail = $('.e7rta-rail'), main = $('.e7rta-main'), tabs = $('.e7rta-tabs'),
			emp = $('#e7rta-empty'), load = $('#e7rta-loading');
		var showData = mode === 'data';
		if (main) main.hidden = !showData;
		if (tabs) tabs.hidden = !showData;
		if (emp) emp.hidden = mode !== 'empty';
		if (load) load.hidden = mode !== 'loading';
		if (rail) rail.hidden = mode === 'loading';   // the spinner takes the whole card
		if (!showData) {
			destroyCharts();
			['#e7rta-summary', '#e7rta-tags', '#e7rta-formstrip', '#e7rta-recent-boxes', '#e7rta-knobs', '#e7rta-session-stats', '#e7rta-session-nav', '#e7rta-tabpanel'].forEach(function (s) { clear($(s)); });
			renderBanner();
		}
	}
	function render() {
		if (state.loading) { setState('loading'); return; }   // never reveal a half-streamed board
		if (!state.view) { setState('empty'); return; }
		setState('data');
		renderBanner();
		renderSummary();
		renderTags();
		renderRecent();
		renderKnobs();
		destroyCharts();
		buildTablist();
		renderTab();
		renderRankPoints();
		renderJourney();
		renderFirstPick();
		renderSessions();
		scheduleFlush();
	}

	function mount(rootEl, opts) {
		ROOT = rootEl; OPTS = opts || {};
		rootEl.classList.add('e7rta');
		rootEl.innerHTML =
			'<header class="e7rta-top"><div class="e7rta-brand"><span class="e7rta-brand-icon" aria-hidden="true"></span><p class="e7rta-sub" id="e7rta-identity"></p></div>' +
			'<div class="e7rta-topctl"><div class="e7rta-seg e7rta-seg--lang" id="e7rta-lang" role="group"></div><div class="e7rta-seg" id="e7rta-season" role="group"></div><button class="e7rta-close" id="e7rta-close" type="button">✕</button></div></header>' +
			'<div class="e7rta-layout">' +
				'<aside class="e7rta-rail">' +
					'<section class="e7rta-banner" id="e7rta-banner"><img class="e7rta-avatar" id="e7rta-avatar" alt="" /><div class="e7rta-who"><h2 class="e7rta-name" id="e7rta-name"></h2><p class="e7rta-meta" id="e7rta-meta"></p></div><img class="e7rta-emblem" id="e7rta-emblem" alt="" /><div class="e7rta-tierbox"><span class="e7rta-tiername" id="e7rta-tiername"></span><span class="e7rta-points" id="e7rta-points"></span></div></section>' +
					'<section class="e7rta-card"><h3 class="e7rta-cardtitle" id="e7rta-t-summary"></h3><dl class="e7rta-stats" id="e7rta-summary"></dl></section>' +
					'<section class="e7rta-card"><h3 class="e7rta-cardtitle" id="e7rta-t-tags"></h3><div class="e7rta-taglist" id="e7rta-tags"></div></section>' +
				'</aside>' +
				'<main class="e7rta-main">' +
					'<div class="e7rta-col">' +
						'<section class="e7rta-card"><h3 class="e7rta-cardtitle"><span id="e7rta-t-recent"></span><em id="e7rta-recent-sub"></em></h3><div class="e7rta-formstrip" id="e7rta-formstrip"></div><div class="e7rta-boxes" id="e7rta-recent-boxes"></div><div class="e7rta-knobs" id="e7rta-knobs"></div></section>' +
						'<section class="e7rta-card"><h3 class="e7rta-cardtitle" id="e7rta-t-sessions"></h3><p class="e7rta-sub" id="e7rta-sessions-hint"></p><div class="e7rta-chips" id="e7rta-session-stats"></div><div class="e7rta-canvaswrap e7rta-canvaswrap--sessions"><canvas id="e7rta-c-sessions"></canvas></div><div class="e7rta-chips" id="e7rta-session-nav"></div></section>' +
					'</div>' +
					'<div class="e7rta-col">' +
						'<section class="e7rta-card"><h3 class="e7rta-cardtitle"><span id="e7rta-t-rankpts"></span><em id="e7rta-rankpoints-sub"></em></h3><div class="e7rta-canvaswrap e7rta-canvaswrap--sm"><canvas id="e7rta-c-rankpts"></canvas></div></section>' +
						'<section class="e7rta-card"><h3 class="e7rta-cardtitle" id="e7rta-t-journey"></h3><div class="e7rta-canvaswrap e7rta-canvaswrap--journey"><canvas id="e7rta-c-journey"></canvas></div></section>' +
						'<section class="e7rta-card"><h3 class="e7rta-cardtitle" id="e7rta-t-fp"></h3><div class="e7rta-canvaswrap e7rta-canvaswrap--fp"><canvas id="e7rta-c-fp"></canvas></div></section>' +
					'</div>' +
				'</main>' +
				'<div class="e7rta-empty" id="e7rta-empty" hidden><p id="e7rta-empty-title"></p><p class="e7rta-sub" id="e7rta-empty-hint"></p></div>' +
				'<div class="e7rta-loading" id="e7rta-loading" hidden><div class="e7rta-loader" aria-hidden="true"><span class="e7rta-loader-glow"></span><span class="e7rta-loader-ring"></span><span class="e7rta-loader-ring e7rta-loader-ring--2"></span><span class="e7rta-loader-mark"></span></div><p id="e7rta-loading-title"></p><p class="e7rta-sub" id="e7rta-loading-hint"></p></div>' +
			'</div>' +
			'<section class="e7rta-tabs"><div class="e7rta-tablist" role="tablist" id="e7rta-tablist"></div><div class="e7rta-tabpanel" id="e7rta-panel" role="tabpanel"></div></section>' +
			'<div class="e7rta-tooltip" id="e7rta-tooltip" hidden></div>';

		TIP = $('#e7rta-tooltip');
		/* The overlay carries a backdrop-filter, and a filtered ancestor becomes the containing block
		   for fixed-position descendants — so a tooltip parked inside it gets positioned against the
		   scrolling panel instead of the viewport. Reparent it to <body> to escape that. */
		if (TIP && TIP.parentNode !== document.body) document.body.appendChild(TIP);
		setupChartDefaults();
		renderLang();
		$('#e7rta-close').addEventListener('click', function () { hideTip(); if (OPTS.onClose) OPTS.onClose(); });
	}

	/** Static chrome: everything in the markup that isn't rebuilt by the data renderers. */
	function renderChrome() {
		$('#e7rta-t-summary').textContent = T('card.summary');
		$('#e7rta-t-tags').textContent = T('card.tags');
		$('#e7rta-t-recent').textContent = T('card.recentForm');
		$('#e7rta-t-sessions').textContent = T('card.sessions');
		$('#e7rta-t-rankpts').textContent = T('card.rankPoints');
		$('#e7rta-t-journey').textContent = T('card.journey');
		$('#e7rta-t-fp').textContent = T('hero.firstVsSecond');
		$('#e7rta-sessions-hint').textContent = T('sub.sessionsHint');
		$('#e7rta-empty-title').textContent = T('empty.title');
		$('#e7rta-empty-hint').textContent = T('empty.hint');
		var loadTitle = $('#e7rta-loading-title'), loadHint = $('#e7rta-loading-hint');
		var soFar = state.data && state.data.meta.battleCount;
		if (loadTitle) loadTitle.textContent = T('load.title');
		if (loadHint) loadHint.textContent = soFar ? T('load.count', { n: soFar }) : T('load.hint');
		var close = $('#e7rta-close');
		if (close) close.setAttribute('aria-label', T('close.label'));
		var season = $('#e7rta-season');
		if (season) season.setAttribute('aria-label', T('season.label'));
	}

	/** Language switch in the header. */
	function renderLang() {
		var host = $('#e7rta-lang');
		if (!host) return;
		host.setAttribute('aria-label', T('lang.label'));
		clear(host);
		E7I18n.langs().forEach(function (l) {
			var b = el('button', null, E7I18n.label(l));
			b.type = 'button';
			b.setAttribute('aria-pressed', String(E7I18n.lang() === l));
			b.addEventListener('click', function () { E7I18n.setLang(l); });
			host.appendChild(b);
		});
	}

	function update(data, profile, loading) {
		state.loading = !!loading;
		var prev = state.data && state.data.meta;
		/* A rebuild destroys and recreates every chart, so do nothing at all unless something that
		   actually affects the view moved. The host page's card churns constantly. Only the *display
		   mode* is part of the signature, so a loading→empty hand-off repaints while a sync starting
		   mid-view does not. */
		var p = profile || state.profile || {};
		var mode = state.loading ? 'loading' : (data.views.length ? 'data' : 'empty');
		var sig = [data.meta.battleCount, data.meta.world, data.meta.nick, data.meta.latestGrade,
			p.name, p.tier, p.score, p.emblem, p.avatar, mode].join('|');
		if (sig === state.sig) return;
		state.sig = sig;

		/* The host page's profile observer fires constantly, so an update is usually just a refresh of
		   the same player. Resetting the UI state every time would close whatever the user opened — only
		   a genuine player change should reset the season, tab and expanded rows. */
		var samePlayer = !!(prev && state.view && prev.world === data.meta.world && prev.nick === data.meta.nick);
		var prevKey = samePlayer ? state.view.key : null;
		var prevSession = state.session;

		state.data = data;
		if (profile !== undefined) state.profile = profile;

		var preferred = null;
		for (var i = 0; i < data.views.length; i++) {
			if (prevKey && data.views[i].key === prevKey) { preferred = data.views[i]; break; }
			if (!prevKey && !preferred && data.views[i].key !== 'all') preferred = data.views[i];
		}
		state.view = preferred || data.views[0] || null;

		var count = state.view && state.view.sessions.length ? state.view.sessions.length : 0;
		state.session = samePlayer
			? Math.max(0, Math.min(prevSession, count - 1))
			: Math.max(0, count - 1);

		if (!samePlayer) {
			state.tab = 'matches';
			state.matchOpen = null;
			state.matchShown = 60;
			state.heroOpen = null;
		}
		/* Battle pages stream in bursts. Rebuilding re-creates every chart, so coalesce the burst
		   instead of tearing the whole board down once per page. */
		if (!prev) { renderSeasonFilter(); render(); return; }
		clearTimeout(state.renderTimer);
		state.renderTimer = setTimeout(function () {
			state.renderTimer = null;
			renderSeasonFilter();
			render();
		}, 150);
	}

	/* switching language re-renders everything that carries text, including the launcher (content.js) */
	E7I18n.onChange(function () {
		renderLang();
		if (state.data) render(); else setState(state.loading ? 'loading' : 'empty');
	});

	/* Dashboard entrance: order the components by their on-screen top, hand each a stagger index, and
	   let the CSS animations run — they replay on every open, since the overlay is display:none while
	   closed. Called by content.js when the launcher opens the dashboard. */
	function playEntrance() {
		if (!ROOT) return;
		var nodes = Array.prototype.slice.call(
			ROOT.querySelectorAll('.e7rta-top, .e7rta-banner, .e7rta-card, .e7rta-tabs, .e7rta-empty')
		).filter(function (el) { return el.offsetParent !== null; });
		ROOT.classList.remove('e7rta--enter');
		void ROOT.offsetWidth;
		nodes.sort(function (a, b) { return a.getBoundingClientRect().top - b.getBoundingClientRect().top; });
		nodes.forEach(function (el, i) {
			el.style.setProperty('--i', i);
			el.classList.remove('e7rta-anim');
		});
		void ROOT.offsetWidth;
		ROOT.classList.add('e7rta--enter');
		nodes.forEach(function (el) { el.classList.add('e7rta-anim'); });
	}

	window.E7Render = { mount: mount, update: update, hideTip: hideTip, enter: playEntrance };
})();
