/*
 * Aggregation layer (isolated world). Pure functions over raw getBattleList records — the browser
 * twin of scratch/build_dashboard_data.ts, plus playstyle metrics and tag generation.
 * Resolves hero codes via window.E7_HEROES.
 *
 *   window.E7Aggregate.build(rawBattles, { gapMinutes }) -> DASH object
 */
(function () {
	'use strict';

	var HEROES = window.E7_HEROES || {};
	function heroOf(code) {
		var h = HEROES[code];
		return h ? { name: h[0], element: h[1], role: h[2] } : { name: code, element: null, role: null };
	}
	var ARTIFACTS = window.E7_ARTIFACTS || {};
	function artifactOf(code) {
		var a = ARTIFACTS[code];
		return a ? { code: code, name: a[0], role: a[1] || null, rarity: a[2] == null ? null : a[2] } : { code: code, name: code, role: null, rarity: null };
	}
	/** Gear-set codes have no name source in the repo — canonical alias table + prettified fallback. */
	var SET_NAMES = {
		set_speed: 'Speed', set_max_hp: 'Health', set_atk: 'Attack', set_def: 'Defense', set_cri: 'Crit Rate',
		set_cri_dmg: 'Crit Damage', set_acc: 'Effectiveness', set_res: 'Effect Resistance', set_hit: 'Hit Rate',
		set_penetrate: 'Penetration', set_counter: 'Counter', set_immune: 'Immunity', set_torrent: 'Torrent',
		set_chase: 'Pursuit', set_scar: 'Injury', set_shield: 'Protection', set_opener: 'Opening',
		set_revenant: 'Revenge', set_might: 'Rage', set_lifesteal: 'Lifesteal', set_reflect: 'Reflect', set_unit: 'Unity'
	};
	function setName(code) {
		if (SET_NAMES[code]) return SET_NAMES[code];
		return String(code || '').replace(/^set_/, '').replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
	}
	/** packed payload strings look like `"my_team":[…]` — wrap and parse. */
	function parseInner(s) {
		if (typeof s !== 'string') return null;
		try { return JSON.parse('{' + s + '}'); } catch (e) { return null; }
	}
	var CDN = 'https://static-pubcomm.onstove.com/event/live/epic7/guide/';
	function heroPortrait(code) { return CDN + 'images/hero/' + code + '_s.png'; }
	/** One side's battle row, carrying the game's own formation position (0 = banned, null = unknown). */
	function teamRow(h, crAll) {
		var pos = Number(h.position) || 0;
		var cr = crAll ? crAll[h.hero_code] : null;
		return {
			code: h.hero_code,
			name: heroOf(h.hero_code).name,
			portrait: heroPortrait(h.hero_code),
			level: Number(h.level) || null,
			slot: Number(h.pick_order) || 0,
			position: pos,
			banned: pos === 0,
			mvp: h.mvp === 1,
			damage: Number(h.attack_damage) || 0,
			taken: Number(h.receive_damage) || 0,
			recovery: Number(h.recovery) || 0,
			mvpPoint: Number(h.mvp_point) || 0,
			kills: Number(h.kill_count) || 0,
			respawn: Number(h.respawn) || 0,
			artifact: h.artifact || null,
			artifactIco: h.artifact ? artifactIcon(h.artifact) : null,
			artifactName: h.artifact ? artifactOf(h.artifact).name : null,
			setIcons: (Array.isArray(h.equip) ? h.equip : []).map(function (sc) { return { icon: setIcon(sc), name: setName(sc) }; }),
			sets: Array.isArray(h.equip) ? h.equip : [],
			cr: cr === undefined ? null : cr
		};
	}
	function setIcon(code) { return CDN + 'wearingStatus/images/sets/' + code + '.png'; }
	/** The warfare-rule title is an i18n token; the desc tid is what identifies the actual modifier. */
	function ruleKey(raw) {
		var tid = String(raw.opening_rule_desc_tid || '');
		if (/soulburn_dmg_up/.test(tid)) return 'soulburn';
		if (/heal_shield_up/.test(tid)) return 'heal';
		if (/resist_up/.test(tid)) return 'resist';
		if (/dodge_down/.test(tid)) return 'evade';
		return null;
	}
	function artifactIcon(code) { return CDN + 'wearingStatus/images/artifact/' + code + '_ico.png'; }
	/** 1-2-2-2-2-1: our draft slot → the global pick number, by which side holds first pick. */
	var GLOBAL_FP = { 1: 1, 2: 4, 3: 5, 4: 8, 5: 9 };
	var GLOBAL_SP = { 1: 2, 2: 3, 3: 6, 4: 7, 5: 10 };
	var round = function (n, d) { d = d || 1; var f = Math.pow(10, d); return Math.round(n * f) / f; };
	var pct = function (w, n) { return n ? round((100 * w) / n, 1) : 0; };
	var sum = function (a) { return a.reduce(function (s, v) { return s + v; }, 0); };
	var clamp01 = function (n) { return n < 0 ? 0 : n > 1 ? 1 : (isNaN(n) ? 0 : n); };
	function parseTs(s) {
		if (typeof s !== 'string') return NaN;
		return new Date(s.replace(' ', 'T').replace(/\.\d+$/, '')).getTime();
	}
	/** energy gauge is packed as `"x":[..]` — wrap and parse. */
	function parseGauge(raw) {
		var s = raw && raw.energyGauge;
		if (typeof s !== 'string' || !s) return null;
		try {
			var o = JSON.parse('{' + s + '}');
			return (o && o.energy_gauge) || null;
		} catch (e) { return null; }
	}
	var RANK_KEYS = ['bronze', 'silver', 'gold', 'master', 'challenger', 'champion', 'warlord', 'emperor', 'legend'];
	function rankKey(t) {
		var s = String(t == null ? '' : t).toLowerCase().replace(/[^a-z]/g, '');
		for (var i = 0; i < RANK_KEYS.length; i++) if (s.indexOf(RANK_KEYS[i]) >= 0) return RANK_KEYS[i];
		return 'unranked';
	}
	function emblemUrl(tier) {
		return 'https://static-pubcomm.onstove.com/live/epic7/gg/images/common/grade/grade_' + rankKey(tier) + '.png';
	}

	function normalize(raw) {
		var win = raw.iswin === 1;
		// The point magnitude arrives signed differently between feeds — the anonymous battle list
		// returns negative values even for wins. Take the magnitude and let the win flag set the
		// sign, so the number can never disagree with the win/loss colour.
		var delta = (win ? 1 : -1) * Math.abs(Number(raw.updownPointWinscore) || 0);
		var played = [], ban = [];
		var deck = (raw.my_deck && raw.my_deck.hero_list) || [];
		deck.forEach(function (h) {
			if (h.ban === 1) ban.push(h.hero_code);
			else played.push({ code: h.hero_code, mvp: h.mvp === 1 });
		});
		var opp = ((raw.enemy_deck && raw.enemy_deck.hero_list) || []).filter(function (h) { return h.ban !== 1; }).map(function (h) { return h.hero_code; });
		var mvp = null;
		for (var i = 0; i < played.length; i++) if (played[i].mvp) { mvp = played[i]; break; }
		var fp = false, fpCode = null;
		deck.forEach(function (h) { if (h.first_pick === 1) { fp = true; fpCode = h.hero_code; } });

		var playedCodes = played.map(function (p) { return p.code; });
		var myCodes = playedCodes.concat(ban);

		// opening turn: my best initial combat readiness vs theirs (energy gauge), plus per-hero CR
		var initiative = null;
		var crAll = {};
		var gauge = parseGauge(raw);
		if (gauge && gauge.length) {
			var mySet = {};
			myCodes.forEach(function (c) { mySet[c] = 1; });
			var myMax = -1, theirMax = -1, mine = 0, theirs = 0;
			gauge.forEach(function (e) {
				var en = Number(e.energy) || 0;
				crAll[e.hero_code] = en;
				if (mySet[e.hero_code]) { mine++; if (en > myMax) myMax = en; }
				else { theirs++; if (en > theirMax) theirMax = en; }
			});
			if (mine && theirs) initiative = myMax >= theirMax;
		}

		// our five draft slots with their per-hero battle line (damage, healing, kills, CR, build)
		var team = (parseInner(raw.teamBettleInfo) || {}).my_team || [];
		var foe = (parseInner(raw.teamBettleInfoenemy) || {}).my_team || [];
		var myRows = team.map(function (h) { return teamRow(h, crAll); });
		// the opponent's payload nests under the same "my_team" key; if it is missing, fall back to the
		// deck codes with no formation position (the card renders those as a flat strip)
		var foeRows = foe.length
			? foe.map(function (h) { return teamRow(h, crAll); })
			: opp.map(function (c) { return { code: c, name: heroOf(c).name, portrait: heroPortrait(c), level: null, position: null, banned: false, mvp: false, slot: 0, damage: 0, taken: 0, recovery: 0, kills: 0, respawn: 0, artifact: null, artifactIco: null, artifactName: null, setIcons: [], sets: [], cr: crAll[c] === undefined ? null : crAll[c], mvpPoint: 0 }; });

		return {
			seq: String(raw.battle_seq),
			t: parseTs(raw.battleCompletedate),
			date: raw.battleCompletedate,
			season: raw.season_name || 'Unknown',
			seasonCode: raw.season_code || null,
			nick: raw.nicknameno,
			world: raw.worldCode,
			win: win,
			delta: delta,
			score: raw.winScore,
			before: Number(raw.winScore) - delta,
			turns: raw.turn == null ? null : raw.turn,
			seconds: raw.battle_time == null ? null : raw.battle_time,
			grade: raw.grade_code || null,
			rank: rankKey(raw.grade_code),
			oppGrade: raw.enemy_grade_code || null,
			fp: fp ? 'me' : 'opp',
			fpCode: fpCode,
			initiative: initiative,
			played: played.map(function (p) { return heroOf(p.code).name; }),
			playedCodes: playedCodes,
			myCodes: myCodes,
			myRows: myRows,
			foeRows: foeRows,
			mvp: mvp ? heroOf(mvp.code).name : null,
			mvpCode: mvp ? mvp.code : null,
			ban: ban.map(function (c) { return heroOf(c).name; }),
			opp: opp.map(function (c) { return heroOf(c).name; }),
			oppCodes: opp,
			prebans: ((raw.my_deck && raw.my_deck.preban_list) || []).map(function (c) { return heroOf(c).name; }),
			foePrebans: ((raw.enemy_deck && raw.enemy_deck.preban_list) || []).map(function (c) { return heroOf(c).name; }),
			// the same bans with portraits, for the match card (prebans above stays names for the aggregation)
			prebanRows: ((raw.my_deck && raw.my_deck.preban_list) || []).map(function (c) { return { code: c, name: heroOf(c).name, portrait: heroPortrait(c) }; }),
			foePrebanRows: ((raw.enemy_deck && raw.enemy_deck.preban_list) || []).map(function (c) { return { code: c, name: heroOf(c).name, portrait: heroPortrait(c) }; }),
			foeNick: raw.enemy_nick_no == null ? null : String(raw.enemy_nick_no),
			foeWorld: raw.enemy_world_code || null,
			openingRule: ruleKey(raw),
			// starting combat readiness, highest first — the turn order the match actually opened with
			// (heroes on 0 never acted, so they are left out)
			readiness: gauge ? gauge.filter(function (e) { return (Number(e.energy) || 0) > 0; }).map(function (e) {
				return { code: e.hero_code, name: heroOf(e.hero_code).name, portrait: heroPortrait(e.hero_code), energy: Number(e.energy) || 0, mine: Number(e.team) === 1 };
			}).sort(function (a, b) { return b.energy - a.energy; }) : []
		};
	}

	var BUCKETS = [
		{ label: 'Game 1', test: function (p) { return p === 1; } },
		{ label: 'Games 2–4', test: function (p) { return p >= 2 && p <= 4; } },
		{ label: 'Games 5–9', test: function (p) { return p >= 5 && p <= 9; } },
		{ label: 'Games 10–19', test: function (p) { return p >= 10 && p <= 19; } },
		{ label: 'Games 20+', test: function (p) { return p >= 20; } }
	];

	function blankHero(code) {
		var m = heroOf(code);
		return {
			code: code, name: m.name, element: m.element, role: m.role, portrait: heroPortrait(code),
			games: 0, wins: 0, winRate: 0,
			firstPickGames: 0, firstPickWins: 0, firstPickWinRate: 0,
			secondPickGames: 0, secondPickWins: 0, secondPickWinRate: 0,
			mvp: 0, mvpRate: 0, bannedOut: 0, netDelta: 0, avgDelta: 0,
			dmgSum: 0, takenSum: 0, recSum: 0, killSum: 0, respSum: 0, mvpPtSum: 0, crSum: 0, crN: 0,
			avgDamage: 0, avgDamageTaken: 0, avgRecovery: 0, avgKills: 0, avgMvpPoint: 0, avgRespawn: 0, avgCR: null,
			posCounts: { 1: 0, 2: 0, 3: 0, 4: 0 },
			sets: {}, artifacts: {}, setsList: [], artifactsList: [], comp: {}, companions: [],
			slots: [1, 2, 3, 4, 5].map(function (s) { return { slot: s, games: 0, wins: 0, losses: 0, winRate: 0 }; }),
			pickRate: 0, banRate: 0
		};
	}
	function finishHeroes(map, totalBattles) {
		var out = [];
		map.forEach(function (a) {
			if (a.games + a.bannedOut <= 0) return;
			a.winRate = pct(a.wins, a.games);
			a.mvpRate = pct(a.mvp, a.games);
			a.firstPickWinRate = pct(a.firstPickWins, a.firstPickGames);
			a.secondPickWinRate = pct(a.secondPickWins, a.secondPickGames);
			a.avgDelta = a.games ? round(a.netDelta / a.games, 2) : 0;
			if (a.games) {
				a.avgDamage = Math.round(a.dmgSum / a.games);
				a.avgDamageTaken = Math.round(a.takenSum / a.games);
				a.avgRecovery = Math.round(a.recSum / a.games);
				a.avgKills = round(a.killSum / a.games, 2);
				a.avgMvpPoint = Math.round(a.mvpPtSum / a.games);
				a.avgRespawn = round(a.respSum / a.games, 2);
			}
			a.avgCR = a.crN ? round(a.crSum / a.crN, 1) : null;
			a.setsList = Object.keys(a.sets).map(function (k) {
				return { code: k, name: setName(k), icon: setIcon(k), games: a.sets[k], pct: pct(a.sets[k], a.games) };
			}).sort(function (x, y) { return y.games - x.games; });
			a.artifactsList = Object.keys(a.artifacts).map(function (k) {
				var m = artifactOf(k);
				return { code: k, name: m.name, role: m.role, rarity: m.rarity, icon: artifactIcon(k), games: a.artifacts[k], pct: pct(a.artifacts[k], a.games) };
			}).sort(function (x, y) { return y.games - x.games; });
			a.companions = Object.keys(a.comp).map(function (k) {
				var cp = a.comp[k];
				return { code: k, name: heroOf(k).name, portrait: heroPortrait(k), games: cp.games, wins: cp.wins, winRate: pct(cp.wins, cp.games) };
			}).filter(function (c) { return c.games >= 3; })
				.sort(function (x, y) { return y.games - x.games || y.winRate - x.winRate; })
				.slice(0, 6);
			a.pickRate = totalBattles ? pct(a.games, totalBattles) : 0;
			a.banRate = totalBattles ? pct(a.bannedOut, totalBattles) : 0;
			a.slots.forEach(function (s) { s.winRate = pct(s.wins, s.games); });
			delete a.sets; delete a.artifacts; delete a.comp;
			delete a.dmgSum; delete a.takenSum; delete a.recSum; delete a.killSum; delete a.respSum; delete a.mvpPtSum; delete a.crSum; delete a.crN;
			out.push(a);
		});
		return out;
	}
	function codeByName(name) {
		for (var k in HEROES) if (HEROES[k][0] === name) return k;
		return name;
	}
	function toMap(obj) { var m = new Map(); for (var k in obj) m.set(k, obj[k]); return m; }

	function summarize(records) {
		var w = records.filter(function (b) { return b.win; }).length;
		var scores = records.map(function (b) { return b.score; });
		var wd = records.map(function (b) { return b.delta; }).filter(function (d) { return d > 0; });
		var ld = records.map(function (b) { return b.delta; }).filter(function (d) { return d < 0; });
		return {
			season: records.length ? records[0].season : null,
			battles: records.length,
			wins: w,
			losses: records.length - w,
			winRate: pct(w, records.length),
			netDelta: sum(records.map(function (b) { return b.delta; })),
			peak: scores.length ? Math.max.apply(null, scores) : null,
			trough: scores.length ? Math.min.apply(null, scores) : null,
			firstScore: records.length ? records[0].before : null,
			lastScore: records.length ? records[records.length - 1].score : null,
			avgWin: wd.length ? round(sum(wd) / wd.length, 1) : 0,
			avgLoss: ld.length ? round(sum(ld) / ld.length, 1) : 0,
			firstDate: records.length ? records[0].date : null,
			lastDate: records.length ? records[records.length - 1].date : null,
			sessions: 0,
			avgSessionGames: 0
		};
	}

	function groupBy(records, keyFn) {
		var m = {};
		records.forEach(function (b) {
			var k = keyFn(b);
			var g = m[k] || (m[k] = { key: k, battles: 0, wins: 0, netDelta: 0 });
			g.battles++;
			if (b.win) g.wins++;
			g.netDelta += b.delta;
		});
		return Object.keys(m).map(function (k) { var g = m[k]; g.winRate = pct(g.wins, g.battles); return g; });
	}

	function computePlaystyle(records) {
		// lineup churn (duo-based): a fresh lineup carries over at most ONE hero from the previous match
		var pairs = 0, fresh = 0;
		for (var i = 1; i < records.length; i++) {
			var prev = {};
			records[i - 1].playedCodes.forEach(function (c) { prev[c] = 1; });
			var overlap = 0;
			records[i].playedCodes.forEach(function (c) { if (prev[c]) overlap++; });
			pairs++;
			if (overlap < 2) fresh++;
		}
		// match length: 15 turns is the midpoint, and the curve flattens at the tails so a 60-turn
		// slog is not scored proportionally worse than a 30-turn one.
		var TURN_MID = 15, TURN_K = 8;
		var withTurns = records.filter(function (r) { return r.turns != null; });
		var tempoScore = withTurns.length
			? sum(withTurns.map(function (r) { return 100 / (1 + Math.exp((r.turns - TURN_MID) / TURN_K)); })) / withTurns.length
			: 0;
		var withInit = records.filter(function (r) { return r.initiative !== null; });
		var held = withInit.filter(function (r) { return r.initiative; }).length;
		return {
			flex: { value: pct(fresh, pairs), n: pairs, fresh: fresh },
			tempo: {
				value: round(tempoScore, 1), n: withTurns.length, midpoint: TURN_MID,
				avgTurns: withTurns.length ? round(sum(withTurns.map(function (r) { return r.turns; })) / withTurns.length, 1) : null
			},
			initiative: { value: pct(held, withInit.length), n: withInit.length, held: held }
		};
	}

	function computeRecent(records, n) {
		var slice = records.slice(-n);
		var w = slice.filter(function (r) { return r.win; }).length;
		return {
			n: slice.length,
			wins: w,
			losses: slice.length - w,
			winRate: pct(w, slice.length),
			net: sum(slice.map(function (r) { return r.delta; })),
			avgDelta: slice.length ? round(sum(slice.map(function (r) { return r.delta; })) / slice.length, 1) : 0,
			form: slice.map(function (r) { return r.win ? 1 : 0; }),
			seqs: slice.map(function (r) { return r.seq; })
		};
	}

	/** Behaviour-first tags. Every threshold is a delta from the player's own win rate (`W`), so a rule
	    only fires when *this* player genuinely deviates — that is what makes a tag feel specific.
	    Each carries a category (for the fair-spread cap), an impact (how far past the threshold, used to
	    rank) and a key+params pair that the render layer resolves in the active language. */
	function buildTags(ctx) {
		var records = ctx.records, summary = ctx.summary, heroes = ctx.heroes, byBucket = ctx.byBucket,
			play = ctx.playstyle, sessions = ctx.sessions || [];
		var W = summary.winRate;

		var tags = [];
		var add = function (id, category, tone, impact, params) {
			tags.push({ key: id, category: category, tone: tone, impact: clamp01(impact), params: params || {} });
		};

		/* ---------- precomputes ---------- */
		var pairs = {}, elems = {};
		records.forEach(function (b) {
			var codes = b.playedCodes || [];
			for (var i = 0; i < codes.length; i++) {
				var el = heroOf(codes[i]).element;
				if (el) {
					var e = elems[el] || (elems[el] = { games: 0, wins: 0 });
					e.games++; if (b.win) e.wins++;
				}
				for (var j = i + 1; j < codes.length; j++) {
					var k = codes[i] < codes[j] ? codes[i] + '|' + codes[j] : codes[j] + '|' + codes[i];
					var p = pairs[k] || (pairs[k] = { a: codes[i], b: codes[j], games: 0, wins: 0 });
					p.games++; if (b.win) p.wins++;
				}
			}
		});

		// vengeance prebans: after a loss, did you preban one of their MVPs in the next draft?
		var chances = 0, grudges = 0;
		for (var i = 1; i < records.length; i++) {
			if (records[i - 1].win) continue;
			var mvp = null;
			(records[i - 1].foeRows || []).forEach(function (r) { if (r.mvp && !mvp) mvp = r.code; });
			if (!mvp) continue;
			chances++;
			var pre = records[i].prebanRows || [];
			for (var j = 0; j < pre.length; j++) if (pre[j].code === mvp) { grudges++; break; }
		}

		// session shape: halves, median length, and what happens after a three-loss run
		var lengths = [], firstG = 0, firstW = 0, lastG = 0, lastW = 0, runs = 0, wentOn = 0, bailed = 0;
		sessions.forEach(function (s) {
			var g = s.games, n = g.length, i;
			lengths.push(n);
			if (n >= 12) {
				var half = Math.floor(n / 2);
				for (i = 0; i < n; i++) {
					if (i < half) { firstG++; if (g[i].win) firstW++; }
					else { lastG++; if (g[i].win) lastW++; }
				}
			}
			var run = 0;
			for (i = 0; i < n; i++) {
				if (!g[i].win) {
					run++;
					if (run === 3) { runs++; if (n - 1 - i >= 3) wentOn++; else bailed++; }
				} else run = 0;
			}
		});
		lengths.sort(function (a, b) { return a - b; });
		var median = lengths.length ? lengths[Math.floor(lengths.length / 2)] : 0;
		var halfDiff = (firstG && lastG) ? round(pct(lastW, lastG) - pct(firstW, firstG), 1) : 0;

		/* ---------- playstyle ---------- */
		if (play.flex.n >= 12) {
			if (play.flex.value >= 60) add('FLEX', 'playstyle', 'good', (play.flex.value - 60) / 40, { pct: play.flex.value, n: play.flex.n });
			else if (play.flex.value <= 25) add('SPAMMER', 'playstyle', W <= 50 ? 'bad' : 'neutral', (25 - play.flex.value) / 25, { pct: play.flex.value, n: play.flex.n });
		}
		if (play.tempo.n >= 15) {
			if (play.tempo.value >= 62) add('CLEAVE', 'playstyle', 'good', (play.tempo.value - 62) / 38, { turns: play.tempo.avgTurns, n: play.tempo.n });
			else if (play.tempo.value <= 40) add('CONTROL', 'playstyle', 'neutral', (40 - play.tempo.value) / 40, { turns: play.tempo.avgTurns, n: play.tempo.n });
		}
		if (play.initiative.n >= 12) {
			if (play.initiative.value >= 60) add('RACIST', 'playstyle', 'good', (play.initiative.value - 60) / 40, { pct: play.initiative.value, n: play.initiative.n });
			else if (play.initiative.value <= 40) add('OUTSPED', 'playstyle', 'neutral', (40 - play.initiative.value) / 40, { pct: play.initiative.value, n: play.initiative.n });
		}
		var fpMe = records.filter(function (b) { return b.fp === 'me'; });
		var fpFoe = records.filter(function (b) { return b.fp === 'opp'; });
		if (fpMe.length >= 8 && fpFoe.length >= 8) {
			var meRate = pct(fpMe.filter(function (b) { return b.win; }).length, fpMe.length);
			var opRate = pct(fpFoe.filter(function (b) { return b.win; }).length, fpFoe.length);
			if (meRate - opRate >= 5) add('DRAFT KING', 'playstyle', 'good', (meRate - opRate - 5) / 20, { me: meRate, op: opRate });
			else if (opRate - meRate >= 5) add('COUNTER PICK', 'playstyle', 'good', (opRate - meRate - 5) / 20, { me: meRate, op: opRate });
		}
		if (chances >= 8) {
			var grudge = pct(grudges, chances);
			if (grudge >= 25) add('VETO', 'playstyle', 'neutral', (grudge - 25) / 50, { pct: grudge, n: chances });
		}

		/* ---------- session ---------- */
		var opening = byBucket[0].battles + byBucket[1].battles;
		var openRate = pct(byBucket[0].wins + byBucket[1].wins, opening);
		if (opening >= 12) {
			if (openRate <= W - 6) add('COLD START', 'session', 'bad', (W - 6 - openRate) / 14, { open: openRate, overall: W, diff: round(W - openRate, 1) });
			else if (openRate >= W + 6) add('HOT START', 'session', 'good', (openRate - W - 6) / 14, { open: openRate, overall: W, diff: round(openRate - W, 1) });
		}
		if (firstG >= 20 && lastG >= 20) {
			if (halfDiff <= -8) add('BURNOUT', 'session', 'bad', (-halfDiff - 8) / 20, { diff: Math.abs(halfDiff), n: firstG + lastG });
			else if (halfDiff >= 8) add('LATE GAME', 'session', 'good', (halfDiff - 8) / 20, { diff: halfDiff, n: firstG + lastG });
		}
		var deep = byBucket[byBucket.length - 1];
		if (deep.battles >= 8 && deep.winRate >= W + 6) add('STAMINA', 'session', 'good', (deep.winRate - W - 6) / 14, { pct: deep.winRate, n: deep.battles });
		if (sessions.length >= 4) {
			if (median <= 8) add('QUICK SET', 'session', 'neutral', (8 - median) / 8, { n: median });
			else if (median >= 20) add('ALL NIGHTER', 'session', 'neutral', (median - 20) / 20, { n: median });
		}
		if (runs >= 4) {
			var on = pct(wentOn, runs), off = pct(bailed, runs);
			if (on >= 60) add('RAGEBAITED', 'session', 'bad', (on - 60) / 40, { pct: on, n: runs });
			else if (off >= 60) add('STOP LOSS', 'session', 'good', (off - 60) / 40, { pct: off, n: runs });
		}

		/* ---------- heroes ---------- */
		var q = heroes.filter(function (h) { return h.games >= 8; });
		if (q.length) {
			var best = q.slice().sort(function (a, b) { return b.winRate - a.winRate; })[0];
			if (best.winRate >= W + 8) add('SIGNATURE', 'heroes', 'good', (best.winRate - W - 8) / 20, { hero: best.name, pct: best.winRate, games: best.games, diff: round(best.winRate - W, 1) });
			var worst = q.slice().sort(function (a, b) { return a.winRate - b.winRate; })[0];
			if (worst.winRate <= W - 8 && worst.code !== best.code) add('BAIT PICK', 'heroes', 'bad', (W - 8 - worst.winRate) / 20, { hero: worst.name, pct: worst.winRate, games: worst.games, diff: round(W - worst.winRate, 1) });
		}
		var mvpQ = heroes.filter(function (h) { return h.games >= 10; }).sort(function (a, b) { return b.mvpRate - a.mvpRate; });
		if (mvpQ.length && mvpQ[0].mvpRate >= 25) add('CARRY', 'heroes', 'good', (mvpQ[0].mvpRate - 25) / 40, { hero: mvpQ[0].name, pct: mvpQ[0].mvpRate, games: mvpQ[0].games });

		var bestPair = null;
		Object.keys(pairs).forEach(function (k) {
			var p = pairs[k];
			if (p.games < 6) return;
			if (!bestPair || pct(p.wins, p.games) > pct(bestPair.wins, bestPair.games)) bestPair = p;
		});
		if (bestPair) {
			var pr = pct(bestPair.wins, bestPair.games);
			if (pr >= W + 12) add('SYNERGY', 'heroes', 'good', (pr - W - 12) / 25, { a: heroOf(bestPair.a).name, b: heroOf(bestPair.b).name, pct: pr, games: bestPair.games });
		}

		var bestEl = null, worstEl = null;
		Object.keys(elems).forEach(function (k) {
			var e = elems[k];
			if (e.games < 15) return;
			if (!bestEl || pct(e.wins, e.games) > pct(bestEl.e.wins, bestEl.e.games)) bestEl = { k: k, e: e };
			if (!worstEl || pct(e.wins, e.games) < pct(worstEl.e.wins, worstEl.e.games)) worstEl = { k: k, e: e };
		});
		if (bestEl && worstEl && bestEl.k !== worstEl.k) {
			var elUp = pct(bestEl.e.wins, bestEl.e.games), elDown = pct(worstEl.e.wins, worstEl.e.games);
			if (elUp >= W + 8) add('ELEMENT EDGE', 'heroes', 'good', (elUp - W - 8) / 20, { elem: bestEl.k, pct: elUp, n: bestEl.e.games, diff: round(elUp - W, 1) });
			else if (elDown <= W - 8) add('ELEMENT EDGE', 'heroes', 'bad', (W - 8 - elDown) / 20, { elem: worstEl.k, pct: elDown, n: worstEl.e.games, diff: round(elDown - W, 1) });
		}

		var fpCount = {};
		records.forEach(function (b) { if (b.fpCode) fpCount[b.fpCode] = (fpCount[b.fpCode] || 0) + 1; });
		var topFp = null;
		Object.keys(fpCount).forEach(function (k) { if (!topFp || fpCount[k] > fpCount[topFp]) topFp = k; });
		if (topFp && fpCount[topFp] >= 6) add('OPENING PICK', 'heroes', 'neutral', 0.3, { hero: heroOf(topFp).name, games: fpCount[topFp] });

		var order = { good: 0, neutral: 1, bad: 2 };
		return tags.sort(function (a, b) { return (order[a.tone] - order[b.tone]) || (b.impact - a.impact); });
	}

	function computeView(records, key, label, gapMinutes) {
		var summary = summarize(records);
		var GAP = gapMinutes * 60000;

		// sessions
		var sessions = [], cur = null;
		records.forEach(function (b) {
			if (!cur || b.t - cur.endTs > GAP) { cur = { i: sessions.length + 1, startTs: b.t, endTs: b.t, games: [], heroMap: {} }; sessions.push(cur); }
			cur.endTs = b.t;
			cur.games.push({ seq: b.seq, t: b.t, win: b.win, delta: b.delta, turns: b.turns, mvp: b.mvp, played: b.played, seconds: b.seconds, score: b.score });
			(b.playedCodes || []).forEach(function (code) {
				var e = cur.heroMap[code] || (cur.heroMap[code] = { games: 0, wins: 0 });
				e.games++; if (b.win) e.wins++;
			});
		});
		sessions.forEach(function (s) {
			s.battles = s.games.length;
			s.wins = s.games.filter(function (g) { return g.win; }).length;
			s.losses = s.battles - s.wins;
			s.winRate = pct(s.wins, s.battles);
			s.netDelta = s.games.reduce(function (a, g) { return a + g.delta; }, 0);
			s.start = s.games[0].t;
			s.end = s.games[s.games.length - 1].t;
			s.startScore = s.games[0].score - s.games[0].delta;
			s.endScore = s.games[s.games.length - 1].score;
			s.durationMin = Math.round((s.endTs - s.startTs) / 60000);
			s.heroes = Object.keys(s.heroMap).map(function (k) {
				var e = s.heroMap[k];
				return { code: k, name: heroOf(k).name, portrait: heroPortrait(k), games: e.games, wins: e.wins, losses: e.games - e.wins, winRate: pct(e.wins, e.games) };
			}).sort(function (a, b) { return b.games - a.games || b.winRate - a.winRate; });
			delete s.heroMap;
		});
		summary.sessions = sessions.length;
		summary.avgSessionGames = sessions.length ? round(records.length / sessions.length, 1) : 0;

		var curLen = 0, curWin = null, longestWin = 0, longestLoss = 0;
		records.forEach(function (b) {
			if (curWin === b.win) curLen++; else { curWin = b.win; curLen = 1; }
			if (b.win) longestWin = Math.max(longestWin, curLen); else longestLoss = Math.max(longestLoss, curLen);
		});
		var streaks = { longestWin: longestWin, longestLoss: longestLoss, current: { win: curWin === true, length: curLen } };

		// buckets + positions
		var byBucket = BUCKETS.map(function (bk) {
			var battles = 0, wins = 0, netDelta = 0;
			sessions.forEach(function (s) {
				s.games.forEach(function (g, idx) { if (!bk.test(idx + 1)) return; battles++; if (g.win) wins++; netDelta += g.delta; });
			});
			return { label: bk.label, battles: battles, wins: wins, netDelta: netDelta, winRate: pct(wins, battles) };
		});
		var posMap = {};
		sessions.forEach(function (s) {
			s.games.forEach(function (g, idx) {
				var p = idx + 1;
				var t = posMap[p] || (posMap[p] = { pos: p, battles: 0, wins: 0, netDelta: 0 });
				t.battles++; if (g.win) t.wins++; t.netDelta += g.delta;
			});
		});
		var byPosition = Object.keys(posMap).map(function (k) { var t = posMap[k]; t.winRate = pct(t.wins, t.battles); return t; }).sort(function (a, b) { return a.pos - b.pos; });

		// heroes — enriched from the packed team info (damage, healing, kills, CR, sets, artifacts)
		var heroMap = {}, oppMap = {}, prebanMap = {};
		var slotAgg = [1, 2, 3, 4, 5].map(function (s) { return { slot: s, games: 0, wins: 0, losses: 0, banned: 0, bannedWon: 0, bannedLost: 0, played: 0, dmg: 0, taken: 0, recovery: 0, crSum: 0, crN: 0 }; });
		var fpMe = { games: 0, wins: 0 }, fpOpp = { games: 0, wins: 0 };

		records.forEach(function (b) {
			(b.myRows || []).forEach(function (r) {
				var a = heroMap[r.code] || (heroMap[r.code] = blankHero(r.code));
				var sa = (r.slot >= 1 && r.slot <= 5) ? slotAgg[r.slot - 1] : null;
				if (sa) {
					sa.games++;
					if (b.win) sa.wins++; else sa.losses++;
					if (r.banned) { sa.banned++; if (b.win) sa.bannedWon++; else sa.bannedLost++; }
					else {
						sa.played++;
						sa.dmg += r.damage; sa.taken += r.taken; sa.recovery += r.recovery;
						if (r.cr != null) { sa.crSum += r.cr; sa.crN++; }
					}
				}
				if (r.banned) { a.bannedOut++; return; }   // banned out carries no performance line
				a.games++;
				if (b.win) a.wins++;
				a.netDelta += b.delta;
				if (b.fp === 'me') { a.firstPickGames++; if (b.win) a.firstPickWins++; }
				else { a.secondPickGames++; if (b.win) a.secondPickWins++; }
				if (b.mvpCode === r.code) a.mvp++;
				a.dmgSum += r.damage; a.takenSum += r.taken; a.recSum += r.recovery;
				a.killSum += r.kills; a.respSum += r.respawn; a.mvpPtSum += r.mvpPoint;
				if (r.cr != null) { a.crSum += r.cr; a.crN++; }
				if (r.position >= 1 && r.position <= 4) a.posCounts[r.position]++;
				r.sets.forEach(function (sc) { a.sets[sc] = (a.sets[sc] || 0) + 1; });
				if (r.artifact) a.artifacts[r.artifact] = (a.artifacts[r.artifact] || 0) + 1;
				/* who else was in this lineup — the ban slot is excluded from playedCodes, so a hero
				   banned out never counts as having been picked alongside */
				b.playedCodes.forEach(function (c) {
					if (c === r.code) return;
					var cp = a.comp[c] || (a.comp[c] = { games: 0, wins: 0 });
					cp.games++; if (b.win) cp.wins++;
				});
				if (r.slot >= 1 && r.slot <= 5) {
					var hs = a.slots[r.slot - 1];
					hs.games++; if (b.win) hs.wins++; else hs.losses++;
				}
			});
			b.oppCodes.forEach(function (code) {
				var a = oppMap[code] || (oppMap[code] = blankHero(code));
				a.games++; if (!b.win) a.wins++;
			});
			b.prebans.forEach(function (nm) {
				var key = codeByName(nm);
				var a = prebanMap[key] || (prebanMap[key] = blankHero(key));
				a.games++; if (b.win) a.wins++;
			});
			if (b.fp === 'me') { fpMe.games++; if (b.win) fpMe.wins++; }
			else { fpOpp.games++; if (b.win) fpOpp.wins++; }
		});
		var heroes = finishHeroes(toMap(heroMap), records.length).sort(function (a, b) { return b.games - a.games || b.winRate - a.winRate; });
		var oppHeroes = finishHeroes(toMap(oppMap), records.length).sort(function (a, b) { return b.games - a.games || a.winRate - b.winRate; });
		var prebans = finishHeroes(toMap(prebanMap), records.length).sort(function (a, b) { return b.games - a.games; });

		// our draft slots (1-2-2-2-2-1): every match fills all five; the banned slot keeps its order
		var pickSlots = slotAgg.map(function (s) {
			return {
				slot: s.slot, games: s.games, wins: s.wins, losses: s.losses, played: s.played, banned: s.banned,
				// played-only split, so a stack of [won, lost, banned] sums to games exactly
				playedWins: s.wins - s.bannedWon, playedLosses: s.losses - s.bannedLost,
				winRate: pct(s.wins, s.games),
				avgDamage: s.played ? Math.round(s.dmg / s.played) : 0,
				avgDamageTaken: s.played ? Math.round(s.taken / s.played) : 0,
				avgRecovery: s.played ? Math.round(s.recovery / s.played) : 0,
				avgCR: s.crN ? round(s.crSum / s.crN, 1) : null,
				globalFP: GLOBAL_FP[s.slot], globalSP: GLOBAL_SP[s.slot]
			};
		});
		var firstPickAdvantage = {
			me: { games: fpMe.games, wins: fpMe.wins, winRate: pct(fpMe.wins, fpMe.games) },
			opp: { games: fpOpp.games, wins: fpOpp.wins, winRate: pct(fpOpp.wins, fpOpp.games) }
		};

		var byHour = groupBy(records, function (b) { return ('0' + new Date(b.t).getHours()).slice(-2); }).sort(function (a, b) { return a.key < b.key ? -1 : 1; });
		var byWeekday = groupBy(records, function (b) { return String(new Date(b.t).getDay()); }).sort(function (a, b) { return a.key < b.key ? -1 : 1; });
		var byDay = groupBy(records, function (b) { return String(b.date).slice(0, 10); }).sort(function (a, b) { return a.key < b.key ? -1 : 1; });

		var playstyle = computePlaystyle(records);
		var recent = computeRecent(records, 20);
		var journey = records.map(function (r) { return { t: r.t, score: r.score, rank: r.rank, win: r.win }; });
		var tags = buildTags({ records: records, summary: summary, heroes: heroes, byBucket: byBucket, sessions: sessions, playstyle: playstyle });

		return {
			key: key, label: label, summary: summary, streaks: streaks, series: records, sessions: sessions,
			byBucket: byBucket, byPosition: byPosition, byDay: byDay, byHour: byHour, byWeekday: byWeekday,
			heroes: heroes, oppHeroes: oppHeroes, prebans: prebans,
			pickSlots: pickSlots, firstPickAdvantage: firstPickAdvantage,
			playstyle: playstyle, recent: recent, journey: journey, tags: tags
		};
	}

	function build(rawBattles, opts) {
		opts = opts || {};
		var gapMinutes = opts.gapMinutes || 60;
		var records = (rawBattles || [])
			.filter(function (b) { return b && b.battle_seq != null && b.winScore != null && b.battleCompletedate; })
			.map(normalize)
			.filter(function (b) { return !isNaN(b.t); })
			.sort(function (a, b) { return a.t - b.t; });

		var lastTs = {};
		records.forEach(function (b) { lastTs[b.season] = b.t; });
		var seasons = Object.keys(lastTs).sort(function (a, b) { return lastTs[b] - lastTs[a]; });

		var views = [{ key: 'all', label: 'All seasons', series: records }];
		seasons.forEach(function (s) { views.push({ key: s, label: s, series: records.filter(function (b) { return b.season === s; }) }); });
		views = views.map(function (v) {
			var computed = computeView(v.series, v.key, v.label, gapMinutes);
			computed.series = v.series;
			return computed;
		}).filter(function (v) { return v.summary.battles > 0; });

		var first = records[0] || {};
		var last = records[records.length - 1] || {};
		return {
			meta: {
				nick: first.nick != null ? String(first.nick) : null,
				world: first.world || null,
				seasons: seasons,
				generatedAt: new Date().toISOString(),
				gapMinutes: gapMinutes,
				battleCount: records.length,
				latestGrade: last.grade || null,
				latestRank: last.rank || null
			},
			views: views
		};
	}

	window.E7Aggregate = {
		build: build, rankKey: rankKey, emblemUrl: emblemUrl,
		heroPortrait: heroPortrait, setIcon: setIcon, artifactIcon: artifactIcon,
		setName: setName, artifactOf: artifactOf
	};
})();
