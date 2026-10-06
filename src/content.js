/*
 * Content script (isolated world). Bridges messages from src/inject.js, accumulates battle lists
 * PER PLAYER (the match history is a SPA — switching players changes the URL without a reload),
 * reads the player card from the page DOM, and drives the overlay UI.
 */
(function () {
	'use strict';

	var store = {};              // "world:nick" -> { battles: { seq: raw } }
	var currentKey = null;
	var lastPath;                // undefined until the first route sync
	var syncing = false;
	var overlay = null;
	var fab = null;
	var fabHTML = null;
	var fabTitle = null;
	var mounted = false;
	var observer = null;
	var obsTimer = null;
	var lastProfileSig = null;

	/* ---------- route / player scoping ---------- */
	function pathInfo() {
		var m = /\/gg\/battlerecord\/([^/]+)\/(\d+)/.exec(location.pathname);
		return m ? { key: m[1] + ':' + m[2], world: m[1], nick: m[2] } : null;
	}
	function isBattleRecord() { return !!pathInfo(); }
	function bucketOf(key) { if (!key) return null; return store[key] || (store[key] = { battles: {} }); }
	function countFor(key) { var b = key && store[key]; return b ? Object.keys(b.battles).length : 0; }
	function rawFor(key) {
		var b = key && store[key];
		if (!b) return [];
		var out = [];
		for (var k in b.battles) out.push(b.battles[k]);
		return out;
	}
	function keyOf(raw) {
		return (raw.worldCode || '?') + ':' + (raw.nicknameno != null ? String(raw.nicknameno) : '?');
	}
	/** Cheap fingerprint of the player card, so an identical card never triggers a rebuild. */
	function profileSig() {
		var p = readProfile();
		return p ? [p.name, p.server, p.clan, p.tier, p.score, p.emblem, p.avatar].join('|') : '';
	}

	/* ---------- persistent cache ----------
	 * A finished battle never changes, so it is stored once under its own battle id and never rewritten.
	 * Two key spaces in chrome.storage.local:
	 *   b:<battle_seq>          the raw battle, written only if that id is absent
	 *   p:<world>:<nickname_no> the ids belonging to one player, union-merged
	 * Hydration pulls a player's ids + bodies into the in-memory store on first sight, so a revisit
	 * renders the whole accumulated history without refetching a single page.
	 */
	var B_PREFIX = 'b:', P_PREFIX = 'p:';
	var loaded = {};       // playerKey -> hydrated from disk
	var cached = {};       // playerKey -> has a stored record, so the loading screen can be skipped
	var loading = {};      // playerKey -> callbacks waiting on an in-flight hydrate
	var indexQueue = [];   // pending index merges
	var indexBusy = false;

	function hasStorage() {
		return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
	}
	function later() { return (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError) || null; }

	/** Write any battle ids we do not already hold. Existing ids are left untouched. */
	function persist(list) {
		if (!hasStorage()) return;
		var bodies = {}, index = {};
		for (var i = 0; i < list.length; i++) {
			var b = list[i];
			if (!b || b.battle_seq == null) continue;
			bodies[B_PREFIX + b.battle_seq] = b;
			var pk = P_PREFIX + keyOf(b);
			(index[pk] || (index[pk] = [])).push(String(b.battle_seq));
		}
		var ids = Object.keys(bodies);
		if (!ids.length) return;
		chrome.storage.local.get(ids, function (have) {
			if (later() || !have) { queueIndex(index); return; }
			var fresh = {};
			for (var i = 0; i < ids.length; i++) if (!(ids[i] in have)) fresh[ids[i]] = bodies[ids[i]];
			if (!Object.keys(fresh).length) { queueIndex(index); return; }
			chrome.storage.local.set(fresh, function () { queueIndex(index); });
		});
	}

	/* Index merges are read-modify-write, so they must not overlap or two batches racing would each
	   read the old id list and the later write would drop the other's ids. Bodies are write-once and
	   therefore safe to write in parallel; only the index needs serialising. */
	function queueIndex(index) {
		indexQueue.push(index);
		if (indexBusy) return;
		indexBusy = true;
		stepIndex();
	}
	function stepIndex() {
		var next = indexQueue.shift();
		if (!next) { indexBusy = false; return; }
		mergeIndexes(next, stepIndex);
	}
	function mergeIndexes(index, done) {
		var keys = Object.keys(index);
		if (!keys.length) { done(); return; }
		chrome.storage.local.get(keys, function (cur) {
			var next = {};
			for (var i = 0; i < keys.length; i++) {
				var k = keys[i], seen = {};
				(((cur && cur[k]) || [])).forEach(function (s) { seen[s] = 1; });
				index[k].forEach(function (s) { seen[s] = 1; });
				next[k] = Object.keys(seen);
			}
			chrome.storage.local.set(next, function () { done(); });
		});
	}

	/** Pull a player's cached battles into memory, once. Concurrent callers share one read. */
	function hydrate(key, done) {
		done = done || function () {};
		if (!key || loaded[key] || !hasStorage()) { done(); return; }
		if (loading[key]) { loading[key].push(done); return; }
		loading[key] = [done];
		var finish = function () {
			loaded[key] = true;
			var cbs = loading[key] || [];
			delete loading[key];
			cbs.forEach(function (fn) { try { fn(); } catch (e) {} });
		};
		chrome.storage.local.get(P_PREFIX + key, function (res) {
			var seqs = (later() || !res) ? [] : (res[P_PREFIX + key] || []);
			if (!seqs.length) { finish(); return; }
			cached[key] = true;
			chrome.storage.local.get(seqs.map(function (s) { return B_PREFIX + s; }), function (have) {
				if (!later() && have) {
					var bucket = bucketOf(key);
					for (var i = 0; i < seqs.length; i++) {
						var b = have[B_PREFIX + seqs[i]];
						if (b && b.battle_seq != null) bucket.battles[String(b.battle_seq)] = b;
					}
				}
				finish();
			});
		});
	}

	/* ---------- bridge ---------- */
	window.addEventListener('message', function (ev) {
		if (ev.source !== window) return;
		var d = ev.data;
		if (!d || d.__e7rta !== true || d.type === 'ready') return;
		if (d.type === 'battles') ingest(d.payload);
		else if (d.type === 'navigate') syncRoute();
		else if (d.type === 'syncStart') { syncing = true; paintFab(); ifOverlay(refresh); }
		else if (d.type === 'syncDone' || d.type === 'syncError') { syncing = false; paintFab(); ifOverlay(refresh); }
	});
	function ifOverlay(fn) { if (overlay && !overlay.hidden) fn(); }

	function ingest(payload) {
		var list = (payload && payload.battles) || [];
		var touched = {};
		for (var i = 0; i < list.length; i++) {
			var b = list[i];
			if (!b || b.battle_seq == null) continue;
			var key = keyOf(b);
			bucketOf(key).battles[String(b.battle_seq)] = b;
			touched[key] = true;
		}
		if (!currentKey) { var keys = Object.keys(touched); if (keys.length) currentKey = keys[0]; }
		persist(list);
		ensureFab();
		paintFab();
		// only repaint if the batch belongs to the player we are showing (avoids cross-player flicker)
		if (overlay && !overlay.hidden && Object.prototype.hasOwnProperty.call(touched, currentKey)) refresh();
	}

	/** Route changed (SPA navigation): reset the view onto the new player. */
	function syncRoute() {
		var info = pathInfo();
		var key = info ? info.key : null;
		var changed = key !== lastPath;
		lastPath = key;
		if (key) currentKey = key;
		hydrate(key, paintFab);
		ensureFab();
		paintFab();
		if (changed) {
			attachProfileObserver();
			if (overlay && !overlay.hidden) refresh();
		}
	}

	/* ---------- player card from the page ---------- */
	function readProfile() {
		var ui = document.querySelector('#userInfo');
		if (!ui) return null;
		var nick = ui.querySelector('.info-box .nickname');
		var name = nick ? (nick.childNodes[0] && nick.childNodes[0].textContent || '').trim() : '';
		var serv = ui.querySelector('.serv span');
		var clan = ui.querySelector('.clan');
		var tier = ui.querySelector('.tier-name');
		var score = ui.querySelector('.score-rate');
		var emblemEl = ui.querySelector('.img-box em');
		var avatar = ui.querySelector('.profile-img img');

		var emblem = '';
		if (emblemEl) {
			var bg = getComputedStyle(emblemEl).backgroundImage || '';
			var m = /url\(["']?([^"')]+)["']?\)/.exec(bg);
			if (m) emblem = m[1];
		}
		return {
			name: name || null,
			server: serv ? serv.textContent.trim() : null,
			clan: clan ? clan.textContent.replace(/\s+/g, ' ').trim() : null,
			tier: tier ? tier.textContent.trim() : null,
			score: score ? score.innerText.replace(/\s+/g, ' ').trim() : null,
			emblem: emblem || null,
			avatar: avatar && avatar.src ? avatar.src : null
		};
	}
	/* Vue swaps #userInfo on navigation, so re-target the observer each time. */
	function attachProfileObserver() {
		if (observer) { observer.disconnect(); observer = null; }
		var ui = document.querySelector('#userInfo');
		if (!ui) return;
		/* The host page mutates its player card constantly. Every refresh rebuilds the whole analysis
		   and recreates every chart, so coalesce bursts and bail out unless the card really changed. */
		observer = new MutationObserver(function () {
			if (obsTimer || !overlay || overlay.hidden) return;
			obsTimer = setTimeout(function () {
				obsTimer = null;
				if (!overlay || overlay.hidden) return;
				var sig = profileSig();
				if (sig === lastProfileSig) return;
				lastProfileSig = sig;
				refresh();
			}, 250);
		});
		observer.observe(ui, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'class', 'style'] });
	}

	/* ---------- floating button ---------- */
	function ensureFab() {
		if (fab || !document.body || !isBattleRecord()) return;
		fab = document.createElement('button');
		fab.type = 'button';
		fab.className = 'e7rta-fab';
		fab.addEventListener('click', open);
		document.body.appendChild(fab);
		paintFab();
	}
	function paintFab() {
		if (!fab) return;
		var on = isBattleRecord();
		fab.style.display = on ? '' : 'none';
		if (!on) return;
		var n = countFor(currentKey);
		// this runs on a 1s poll — only touch the DOM when something actually changed
		var html = '<span class="e7rta-fab-icon"></span><span class="e7rta-fab-label">' + E7I18n.t('fab.analyze') + '</span><span class="e7rta-fab-count">' + (syncing ? '…' : n) + '</span>';
		if (html !== fabHTML) { fab.innerHTML = html; fabHTML = html; }
		var title = n ? E7I18n.t('fab.title', { n: n }) : E7I18n.t('fab.waiting');
		if (title !== fabTitle) { fab.title = title; fabTitle = title; }
	}

	/* ---------- overlay ---------- */
	function open() {
		if (!overlay) buildOverlay();
		overlay.hidden = false;
		document.documentElement.classList.add('e7rta-lock');
		var info = pathInfo();
		if (info) { currentKey = info.key; if (lastPath === undefined) lastPath = info.key; }
		attachProfileObserver();
		refresh();
		if (window.E7Render.enter) window.E7Render.enter();
	}
	function close() {
		if (overlay) overlay.hidden = true;
		// the tooltip lives on <body> now, so it is not hidden along with the overlay
		if (window.E7Render && window.E7Render.hideTip) window.E7Render.hideTip();
		document.documentElement.classList.remove('e7rta-lock');
	}
	function buildOverlay() {
		overlay = document.createElement('div');
		overlay.className = 'e7rta-overlay';
		overlay.setAttribute('role', 'dialog');
		overlay.setAttribute('aria-modal', 'true');
		overlay.setAttribute('aria-label', E7I18n.t('overlay.label'));
		var card = document.createElement('div');
		card.className = 'e7rta-card-host';
		overlay.appendChild(card);
		document.body.appendChild(overlay);
		window.E7Render.mount(card, { onClose: close });
		mounted = true;
		document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && overlay && !overlay.hidden) close(); });
		overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
	}
	function refresh() {
		if (!mounted || !currentKey) return;
		var key = currentKey;
		var paint = function () {
			if (key !== currentKey || !mounted) return;   // the route moved while we were reading
			paintFab();
			// the spinner holds until the sync lands — unless this player already has a stored record
			window.E7Render.update(window.E7Aggregate.build(rawFor(key), { gapMinutes: 60 }), readProfile(), syncing && !cached[key]);
		};
		if (loaded[key] || !hasStorage()) { paint(); return; }
		// paint straight away (a loading spinner, or whatever has streamed in), then again once the cache lands
		paint();
		hydrate(key, paint);
	}

	/* ---------- boot ---------- */
	E7I18n.onChange(paintFab);
	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { ensureFab(); syncRoute(); });
	else { ensureFab(); syncRoute(); }
	// fallback poll in case a navigation slips past the history hooks
	setInterval(function () { if (fab) syncRoute(); }, 1000);
})();
