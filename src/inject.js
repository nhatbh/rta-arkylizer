/*
 * MAIN-world interceptor. Runs inside the page's own JS context so it can wrap the page's
 * fetch/XHR without fighting CORS or cookies: we never authenticate, we just read the responses
 * the page already requested, and (once) page through the rest of the history ourselves.
 *
 * Everything is handed to the isolated content script over window.postMessage.
 */
(function () {
	'use strict';

	var API = 'getBattleList';
	var API_HOST = 'e7api.onstove.com';
	var MAX_PAGES = 25;

	function emit(type, payload) {
		try { window.postMessage({ __e7rta: true, type: type, payload: payload }, '*'); } catch (e) {}
	}
	function urlOf(input) {
		if (typeof input === 'string') return input;
		if (input && typeof input.url === 'string') return input.url;
		return '';
	}
	function isBattleList(url) {
		return !!url && url.indexOf(API) !== -1 && url.indexOf(API_HOST) !== -1;
	}
	function handleBody(body, url) {
		if (!body) return;
		var list = body.battle_list;
		if (!list || !list.length) return;
		emit('battles', { battles: list, total: body.total_count || 0, url: url });
	}
	function handleJson(json, url) {
		if (json && json.code === 0) handleBody(json.value && json.value.result_body, url);
	}

	/* ---- wrap fetch ---- */
	var origFetch = window.fetch;
	if (typeof origFetch === 'function') {
		window.fetch = function () {
			var args = arguments;
			var url = urlOf(args[0]);
			var p = origFetch.apply(this, args);
			if (isBattleList(url)) {
				p.then(function (res) {
					res.clone().json().then(function (j) { handleJson(j, url); maybeSync(url); }).catch(function () {});
				}).catch(function () {});
			}
			return p;
		};
	}

	/* ---- wrap XHR ---- */
	var origOpen = XMLHttpRequest.prototype.open;
	var origSend = XMLHttpRequest.prototype.send;
	XMLHttpRequest.prototype.open = function (method, url) {
		this.__e7rtaUrl = url;
		return origOpen.apply(this, arguments);
	};
	XMLHttpRequest.prototype.send = function () {
		var xhr = this;
		if (isBattleList(xhr.__e7rtaUrl)) {
			xhr.addEventListener('load', function () {
				try { handleJson(JSON.parse(xhr.responseText), xhr.__e7rtaUrl); maybeSync(xhr.__e7rtaUrl); } catch (e) {}
			});
		}
		return origSend.apply(this, arguments);
	};

	/* ---- one-time full-history sync, riding the page's session ---- */
	var synced = {};
	function maybeSync(url) {
		var nick = /[?&]nick_no=(\d+)/.exec(url || '');
		var world = /[?&]world_code=([^&]+)/.exec(url || '');
		if (!nick || !world) return;
		var key = nick[1] + ':' + world[1];
		if (synced[key]) return;
		synced[key] = true;
		emit('syncStart', { nick: nick[1], world: world[1] });
		syncAll(nick[1], decodeURIComponent(world[1]));
	}
	function syncAll(nick, world) {
		var page = 1;
		var seen = {};
		function next() {
			if (page > MAX_PAGES) return emit('syncDone', { count: Object.keys(seen).length });
			var url = 'https://' + API_HOST + '/gameApi/' + API + '?nick_no=' + encodeURIComponent(nick) +
				'&world_code=' + encodeURIComponent(world) + '&current_page=' + page + '&lang=en';
			origFetch.call(window, url, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json;charset=UTF-8' } })
				.then(function (r) { return r.json(); })
				.then(function (j) {
					var body = j && j.value && j.value.result_body;
					var list = (body && body.battle_list) || [];
					var fresh = 0;
					list.forEach(function (b) { var s = String(b.battle_seq); if (!seen[s]) { seen[s] = 1; fresh++; } });
					if (fresh) {
						emit('battles', { battles: list, total: (body && body.total_count) || 0, sync: true });
						page++;
						setTimeout(next, 400);
					} else {
						emit('syncDone', { count: Object.keys(seen).length });
					}
				})
				.catch(function () { emit('syncError', { nick: nick, world: world }); });
		}
		next();
	}

	/* ---- surface client-side navigation (the match history is a SPA) ---- */
	function emitNav() { emit('navigate', { path: location.pathname }); }
	try {
		['pushState', 'replaceState'].forEach(function (key) {
			var orig = history[key];
			if (typeof orig === 'function') history[key] = function () { var r = orig.apply(this, arguments); emitNav(); return r; };
		});
		window.addEventListener('popstate', emitNav);
		window.addEventListener('hashchange', emitNav);
	} catch (e) {}

	emit('ready', {});
})();
