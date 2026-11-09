(function () {
    'use strict';

    if (window.plugin_opensubtitles_eng_ready) return;
    window.plugin_opensubtitles_eng_ready = true;

    var MAX_SUBS     = 5;
    var INDEX_OFFSET = 900;   // keeps our tracks clear of HLS/ffprobe track names, which Lampa looks up by index
    var ACTIVE_CLASS = 'opensubs--active';
    var RESILENCE_MS = 5000;  // Tizen player re-enables its own subtitles on (re)start, so re-assert periodically

    var network = new Lampa.Reguest();
    var state   = null;       // per-playback state; replaced on every 'start', dropped on 'destroy'

    // ---------------------------------------------------------------- helpers

    function isCustom(sub) { return !!sub && typeof sub.url === 'string'; }
    function isOurs(sub)   { return !!sub && sub.opensubs === true; }
    function isOff(sub)    { return !!sub && sub.index === -1 && !isCustom(sub); }

    function hasOurs(list) {
        for (var i = 0; i < list.length; i++) if (isOurs(list[i])) return true;
        return false;
    }

    function findSelected(list) {
        if (!list) return null;
        for (var i = 0; i < list.length; i++) if (list[i] && list[i].selected) return list[i];
        return null;
    }

    function video() {
        return Lampa.PlayerVideo && Lampa.PlayerVideo.video ? Lampa.PlayerVideo.video() : null;
    }

    function isTizenPlayer() {
        return !!(window.webapis && window.webapis.avplay && Lampa.Platform && Lampa.Platform.is('tizen') &&
                  Lampa.Storage && Lampa.Storage.field('player') == 'tizen');
    }

    // Lampa's Player.subtitles() deep-clones the list and only attaches its 'mode' handler to
    // entries without a 'ready' flag. Entries already processed once must be passed back clean,
    // otherwise they become unselectable.
    function clean(sub) {
        var copy = {};
        for (var key in sub) {
            if (Object.prototype.hasOwnProperty.call(sub, key) && key !== 'ready' && key !== 'mode' && key !== 'selected') {
                copy[key] = sub[key];
            }
        }
        return copy;
    }

    // ---------------------------------------------------------------- styles

    function addStyles() {
        if (document.getElementById('opensubs-position-fix')) return;

        var style = document.createElement('style');
        style.id = 'opensubs-position-fix';
        // Applied only while an OpenSubtitles track is the active one.
        style.innerHTML = [
            '.player-video__subtitles.' + ACTIVE_CLASS + ' {',
            '    top: auto !important;',
            '    bottom: 3% !important;',
            '    display: flex !important;',
            '    flex-direction: column !important;',
            '    justify-content: flex-end !important;',
            '    align-items: center !important;',
            '}',
            '.player-video__subtitles.' + ACTIVE_CLASS + ' > div, .player-video__subtitles.' + ACTIVE_CLASS + ' span {',
            '    position: static !important;',
            '    transform: none !important;',
            '}'
        ].join('\n');

        document.head.appendChild(style);
    }

    function markActive(on) {
        try {
            Lampa.PlayerVideo.render().find('.player-video__subtitles').toggleClass(ACTIVE_CLASS, !!on);
        } catch (e) {}
    }

    // ---------------------------------------------------------------- OpenSubtitles

    function fetchOpenSubs(imdb_id, isSeries, season, episode, callback) {
        if (!/^tt\d+$/.test(String(imdb_id || ''))) return callback([]);

        var query = imdb_id;
        if (isSeries) {
            // a series id on the movie endpoint gives wrong or no results
            if (!/^\d+$/.test(String(season)) || !/^\d+$/.test(String(episode))) return callback([]);
            query += ':' + season + ':' + episode;
        }

        var url = 'https://opensubtitles-v3.strem.io/subtitles/' + (isSeries ? 'series' : 'movie') + '/' + query + '.json';

        network.silent(url, function (response) {
            var subs = [];
            var seen = {};

            if (response && Array.isArray(response.subtitles)) {
                response.subtitles.forEach(function (item) {
                    if (subs.length >= MAX_SUBS) return;
                    if (!item || item.lang !== 'eng' || !item.url || seen[item.url]) return;

                    seen[item.url] = true;
                    subs.push({
                        label: '[OpenSub] English #' + (subs.length + 1),
                        url: item.url,
                        lang: 'en',
                        index: INDEX_OFFSET + subs.length,
                        opensubs: true
                    });
                });
            }

            callback(subs);
        }, function () {
            callback([]);
        }, false, {
            timeout: 10000
        });
    }

    function resolveImdb(movie, isSeries, callback) {
        if (movie.imdb_id) return callback(movie.imdb_id);
        if (!movie.id) return callback(null);

        var url = Lampa.TMDB.api((isSeries ? 'tv' : 'movie') + '/' + encodeURIComponent(movie.id) +
                                 '/external_ids?api_key=' + Lampa.TMDB.key());

        network.silent(url, function (res) {
            if (res && res.imdb_id) {
                movie.imdb_id = res.imdb_id;
                callback(res.imdb_id);
            } else {
                callback(null);
            }
        }, function () {
            callback(null);
        });
    }

    // ---------------------------------------------------------------- merging into the player menu

    // Lampa shows one subtitle list at a time: either the URL-based ("custom") list or the
    // player's own tracks (HLS, embedded, Tizen). Player.subtitles() replaces the whole list,
    // so here we rebuild it from what Lampa already has plus our tracks, and send the menu a
    // combined list so the player's own tracks stay selectable too.
    function apply(st) {
        var v = video();
        if (!v || st !== state) return;

        // Embedded tracks are only reported to the menu when Lampa has no URL list; read them directly.
        if (!st.native.length && v.textTracks && v.textTracks.length) {
            for (var t = 0; t < v.textTracks.length; t++) {
                var track = v.textTracks[t];
                if (track && !isCustom(track)) {
                    st.native.push(track);
                    if (st.nativeSeen.indexOf(track) < 0) st.nativeSeen.push(track);
                }
            }
        }

        var previous = findSelected(v.customSubs);
        var base     = (v.customSubs || []).filter(function (s) { return !isOurs(s); }).map(clean);

        st.applying = true;
        try {
            Lampa.Player.subtitles(base.concat(st.ours.map(clean)));

            var list = v.customSubs || [];

            // Player.subtitles() stops whatever custom track was playing; bring the selection back.
            if (previous) {
                for (var i = 0; i < list.length; i++) {
                    if (list[i].url === previous.url && list[i].label === previous.label) {
                        list[i].mode     = 'showing';
                        list[i].selected = true;
                        break;
                    }
                }
            }

            if (st.native.length) {
                st.menu = st.native.concat(list);
                Lampa.PlayerVideo.listener.send('subs', { subs: st.menu });
            } else {
                st.menu = list;
            }
        } finally {
            st.applying = false;
        }

        st.chosen = null; // re-evaluate on the next tick
    }

    function scheduleApply(st) {
        if (st.pending) return;
        st.pending = true;
        setTimeout(function () {
            st.pending = false;
            if (st === state && st.ours.length) apply(st);
        }, 0);
    }

    function onSubsList(e) {
        var st = state;
        if (!st || st.applying || !e || !Array.isArray(e.subs)) return;

        var native = e.subs.filter(function (s) { return s && !isCustom(s) && !isOff(s); });

        if (native.length) {
            st.native = native;
            native.forEach(function (s) { if (st.nativeSeen.indexOf(s) < 0) st.nativeSeen.push(s); });
        }

        st.menu   = e.subs;
        st.chosen = null;

        if (st.ours.length && !hasOurs(e.subs)) scheduleApply(st);
    }

    // ---------------------------------------------------------------- one active track at a time
    //
    // Every subtitle source in Lampa (URL tracks, HLS tracks, Tizen's built-in player) draws
    // into the same on-screen box. A URL track redraws it on every time update, so when another
    // source is still running underneath — typically a forced "signs" track in Russian or
    // Ukrainian that only has lines for on-screen text — its line flashes for a split second
    // before being overwritten. Lampa never turns those sources off:
    //   * Tizen's track objects ignore mode = 'disabled', and Lampa forces setSilentSubtitle(false);
    //   * HLS tracks and native text tracks drop out of the menu once a URL list is set,
    //     so there is nothing left to switch them off with.
    // So whenever a track (or "Off") is chosen, everything else is switched off here.

    function silenceNative(st, on) {
        if (!isTizenPlayer()) return;
        if (!on && !st.silenced) return;

        try {
            window.webapis.avplay.setSilentSubtitle(on);
            st.silenced   = on;
            st.silencedAt = Date.now();
        } catch (e) {}
    }

    function disableNative(st, chosen) {
        st.nativeSeen.forEach(function (s) {
            if (s === chosen) return;
            try {
                s.mode     = 'disabled';
                s.selected = false;
            } catch (e) {}
        });

        var v = video();
        if (v && v.textTracks && !isTizenPlayer()) {
            for (var i = 0; i < v.textTracks.length; i++) {
                var track = v.textTracks[i];
                if (track && track !== chosen && track.mode && track.mode !== 'disabled') {
                    try { track.mode = 'disabled'; } catch (e) {}
                }
            }
        }

        silenceNative(st, true);
    }

    // Switching from a URL track to a player track leaves the URL track drawing as well.
    // Re-setting the list stops it without touching the player's own tracks.
    function stopCustomDrawing(st) {
        var v = video();
        if (!v || !v.customSubs) return;

        st.applying = true;
        try {
            Lampa.Player.subtitles(v.customSubs.map(clean));

            st.menu = st.native.concat(v.customSubs || []);
            Lampa.PlayerVideo.listener.send('subs', { subs: st.menu });
        } finally {
            st.applying = false;
        }
    }

    function onTimeUpdate() {
        var st = state;
        if (!st || !st.menu) return;

        var chosen = findSelected(st.menu);

        if (chosen && chosen === st.chosen) {
            if (st.silenced && Date.now() - st.silencedAt > RESILENCE_MS) silenceNative(st, true);
            return;
        }

        var previous = st.chosen;
        st.chosen = chosen;

        if (!chosen) return;

        if (isCustom(chosen) || isOff(chosen)) {
            disableNative(st, chosen);
        } else {
            silenceNative(st, false);
            if (isCustom(previous)) {
                stopCustomDrawing(st);
                chosen.mode     = 'showing';
                chosen.selected = true;
                st.chosen       = chosen;
            }
        }

        markActive(isOurs(chosen));
    }

    // ---------------------------------------------------------------- player lifecycle

    function onStart(play_data) {
        network.clear();
        state = null;
        markActive(false);

        if (!play_data || play_data.iptv) return;

        var st = state = {
            ours: [],
            native: [],
            nativeSeen: [],
            menu: null,
            chosen: null,
            applying: false,
            pending: false,
            silenced: false,
            silencedAt: 0
        };

        var activity = Lampa.Activity.active();
        var movie    = play_data.card || (activity && activity.movie);
        if (!movie) return;

        var season   = play_data.season || '';
        var episode  = play_data.episode || '';
        var isSeries = !!(movie.name || movie.original_name || movie.number_of_seasons || season);

        resolveImdb(movie, isSeries, function (imdb_id) {
            if (st !== state || !imdb_id) return;

            fetchOpenSubs(imdb_id, isSeries, season, episode, function (subs) {
                if (st !== state || !subs.length) return;   // response for a video that is no longer playing

                st.ours = subs;
                apply(st);
            });
        });
    }

    function onDestroy() {
        network.clear();
        state = null;   // Lampa re-enables Tizen subtitles itself on the next playback
        markActive(false);
    }

    function initPlugin() {
        addStyles();

        Lampa.Player.listener.follow('start', onStart);
        Lampa.Player.listener.follow('destroy', onDestroy);

        Lampa.PlayerVideo.listener.follow('subs', onSubsList);
        Lampa.PlayerVideo.listener.follow('timeupdate', onTimeUpdate);
    }

    if (window.appready) {
        initPlugin();
    } else {
        Lampa.Listener.follow('app', function (e) {
            if (e.type === 'ready') initPlugin();
        });
    }
})();
