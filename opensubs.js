(function () {
    'use strict';

    if (window.plugin_opensubtitles_eng_ready) return;
    window.plugin_opensubtitles_eng_ready = true;

    var network = new Lampa.Reguest();

    function fixSubtitlePosition() {
        if (document.getElementById('opensubs-position-fix')) return;

        var style = document.createElement('style');
        style.id = 'opensubs-position-fix';
        style.innerHTML = [
            '.player-video__subtitles {',
            '    top: auto !important;',
            '    bottom: 2% !important;',
            '    display: flex !important;',
            '    flex-direction: column !important;',
            '    justify-content: flex-end !important;',
            '    align-items: center !important;',
            '}',
            '.player-video__subtitles > div, .player-video__subtitles span {',
            '    position: static !important;',
            '    transform: none !important;',
            '}'
        ].join('\n');

        document.head.appendChild(style);
    }

    function fetchOpenSubs(imdb_id, season, episode, callback) {
        if (!imdb_id) return callback([]);

        var type = (season && episode) ? 'series' : 'movie';
        var query = imdb_id;
        if (type === 'series') {
            query += ':' + season + ':' + episode;
        }

        var url = 'https://opensubtitles-v3.strem.io/subtitles/' + type + '/' + query + '.json';

        network.silent(url, function (response) {
            var subs = [];
            if (response && response.subtitles && Array.isArray(response.subtitles)) {
                var count = 0;

                response.subtitles.forEach(function (item) {
                    if (item.lang === 'eng' && item.url && count < 5) {
                        count++;
                        subs.push({
                            label: '[OpenSub] English #' + count,
                            url: item.url
                        });
                    }
                });
            }
            callback(subs);
        }, function () {
            callback([]);
        }, false, {
            timeout: 10000
        });
    }

    function initPlugin() {
        fixSubtitlePosition();

        Lampa.Player.listener.follow('start', function (play_data) {
            var activity = Lampa.Activity.active();
            if (!activity || !activity.movie) return;

            var movie = activity.movie;
            var imdb_id = movie.imdb_id;

            var season = play_data.season || '';
            var episode = play_data.episode || '';

            function loadAndApply(id) {
                fetchOpenSubs(id, season, episode, function (os_subs) {
                    if (!os_subs.length) return;

                    var current = play_data.subtitles || [];
                    var merged = current.concat(os_subs);

                    if (Lampa.Player.subtitles) {
                        Lampa.Player.subtitles(merged);
                    }
                });
            }

            if (imdb_id) {
                loadAndApply(imdb_id);
            } else if (movie.id) {
                var tmdb_type = (movie.name || movie.original_name) ? 'tv' : 'movie';
                var tmdb_url = Lampa.TMDB.api(tmdb_type + '/' + movie.id + '/external_ids?api_key=' + Lampa.TMDB.key());

                network.silent(tmdb_url, function (res) {
                    if (res && res.imdb_id) {
                        movie.imdb_id = res.imdb_id;
                        loadAndApply(res.imdb_id);
                    }
                });
            }
        });
    }

    if (window.appready) {
        initPlugin();
    } else {
        Lampa.Listener.follow('app', function (e) {
            if (e.type === 'ready') initPlugin();
        });
    }
})();
