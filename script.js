let db;
const request = indexedDB.open("XUnityDB", 2);
request.onupgradeneeded = function(e) {
    db = e.target.result;
    if(!db.objectStoreNames.contains('playlists')) db.createObjectStore('playlists', { keyPath: 'id' });
    if(!db.objectStoreNames.contains('liked_songs')) db.createObjectStore('liked_songs', { keyPath: 'videoId' });
    if(!db.objectStoreNames.contains('favorite_songs')) db.createObjectStore('favorite_songs', { keyPath: 'videoId' });
    if(!db.objectStoreNames.contains('history_songs')) db.createObjectStore('history_songs', { keyPath: 'timestamp' });
    if(!db.objectStoreNames.contains('offline_songs')) db.createObjectStore('offline_songs', { keyPath: 'videoId' });
};
request.onsuccess = function(e) { db = e.target.result; renderLibraryUI(); };
request.onerror = function(e) { console.error('IndexedDB error:', e); };

let isPlaying = false;
let currentTrack = null;
let progressInterval = null;
let currentPlaylistTracks = [];
let playContext = { type: 'similar', currentIndex: -1, tracks: [] };
let audioIframe = document.getElementById('youtube-audio');
let currentVideoId = null;
let isShuffle = false;
let repeatState = 0;
let currentRepeatCount = 0;
let sleepTimerTimeout = null;
let isEditMode = false;
let selectedTracksForDelete = new Set();
let activePlaylistId = null;
let toastTimeout;
let isIframeReady = false;
let pendingPlay = null;

window.addEventListener('load', function() {
    history.replaceState({ view: 'home' }, '', '#home');
    if (!sessionStorage.getItem('splashShown')) {
        setTimeout(() => {
            const splash = document.getElementById('splash-screen');
            if(splash) {
                splash.style.opacity = '0';
                setTimeout(() => { splash.style.display = 'none'; splash.remove(); }, 500);
            }
        }, 7500);
        sessionStorage.setItem('splashShown', 'true');
    } else {
        const splash = document.getElementById('splash-screen');
        if(splash) { splash.style.display = 'none'; splash.remove(); }
    }
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').then(reg => reg.update()).catch(err => console.log('PWA error:', err));
    }
    loadHomeData();
    renderSearchCategories();
    audioIframe.addEventListener('load', function() {
        isIframeReady = true;
        if (pendingPlay) {
            playYouTubeAudio(pendingPlay, true);
            pendingPlay = null;
        }
    });
});

let deferredPrompt;
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    const installBtn = document.getElementById('installAppBtn');
    if(installBtn) {
        installBtn.style.display = 'flex';
        installBtn.addEventListener('click', async () => {
            if (deferredPrompt) {
                deferredPrompt.prompt();
                const { outcome } = await deferredPrompt.userChoice;
                if(outcome === 'accepted') installBtn.style.display = 'none';
                deferredPrompt = null;
            }
        });
    }
});
window.addEventListener('appinstalled', () => {
    document.getElementById('installAppBtn').style.display = 'none';
    deferredPrompt = null;
});
window.addEventListener('popstate', (e) => {
    if (e.state && e.state.view) switchView(e.state.view, false);
    else switchView('home', false);
});

function switchView(view) {
    document.querySelectorAll('.view-section').forEach(el => el.classList.remove('active'));
    const target = document.getElementById('view-' + view);
    if(target) target.classList.add('active');
    const views = ['home', 'search', 'library', 'developer'];
    document.querySelectorAll('.nav-item').forEach((el, i) => {
        el.classList.toggle('active', views[i] === view);
    });
    if (view === 'library') renderLibraryUI();
    window.scrollTo(0, 0);
}

function getHighResImage(url) {
    if (!url) return 'https://placehold.co/140x140/1a120e/c49a6c?text=♪';
    if (url.match(/=w\d+-h\d+/)) return url.replace(/=w\d+-h\d+[^&]*/g, '=w512-h512-l90-rj');
    return url;
}

function createListHTML(track) {
    const img = getHighResImage(track.thumbnail || 'https://placehold.co/48x48/1a120e/c49a6c?text=♪');
    const data = { 
        videoId: track.videoId, 
        title: track.title || 'Untitled', 
        artist: track.artist || 'Unknown', 
        img: img 
    };
    const dataStr = JSON.stringify(data).replace(/'/g, "\\'");
    return `<div class="v-item" onclick="playMusic(${dataStr}, true)">
        <img src="${img}" class="v-img" onerror="this.src='https://placehold.co/48x48/1a120e/c49a6c?text=♪'">
        <div class="v-info">
            <div class="v-title">${track.title || 'Untitled'}</div>
            <div class="v-sub">${track.artist || 'Unknown'}</div>
        </div>
        <div class="dots-container">⋯</div>
    </div>`;
}

function createCardHTML(track, isArtist = false) {
    const img = getHighResImage(track.thumbnail || 'https://placehold.co/140x140/1a120e/c49a6c?text=♪');
    const data = { 
        videoId: track.videoId, 
        title: track.title, 
        artist: track.artist || 'Unknown', 
        img: img 
    };
    const dataStr = JSON.stringify(data).replace(/'/g, "\\'");
    let clickAction;
    if (isArtist) {
        const artistName = (track.artist || '').replace(/'/g, "\\'");
        clickAction = `openArtistView('${artistName}')`;
    } else {
        clickAction = `playMusic(${dataStr}, true)`;
    }
    return `<div class="h-card" onclick="${clickAction}">
        <img src="${img}" class="h-img ${isArtist ? 'artist-img' : ''}" onerror="this.src='https://placehold.co/140x140/1a120e/c49a6c?text=♪'">
        <div class="h-title">${isArtist ? (track.artist || 'Artis') : (track.title || 'Untitled')}</div>
        <div class="h-sub">${isArtist ? 'Artis' : (track.artist || 'Unknown')}</div>
    </div>`;
}

let homeDisplayedVideoIds = new Set();

async function fetchAndRender(query, containerId, formatType, isArtist = false, isHome = false) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '<div style="color:var(--text-sub); font-size:13px;">⏳ Memuat...</div>';
    try {
        const res = await fetch(`api/ytmusic-wrapper.php?q=${encodeURIComponent(query)}`);
        const data = await res.json();
        if (data.status === true && data.result && data.result.length > 0) {
            let limit = containerId === 'recentList' ? 5 : (formatType === 'list' ? 5 : 10);
            let tracks = [];
            for (let t of data.result) {
                if (!t.videoId) continue;
                if (isHome && homeDisplayedVideoIds.has(t.videoId)) continue;
                tracks.push(t);
                if (isHome) homeDisplayedVideoIds.add(t.videoId);
                if (tracks.length >= limit) break;
            }
            if (tracks.length === 0) { 
                container.innerHTML = '<div style="color:var(--text-sub); font-size:13px;">📭 Tidak ada data</div>'; 
                return; 
            }
            let html = '';
            tracks.forEach(t => {
                t.title = t.title || 'Untitled';
                t.artist = t.artist || 'Unknown Artist';
                t.thumbnail = t.thumbnail || 'https://placehold.co/140x140/1a120e/c49a6c?text=♪';
                html += formatType === 'list' ? createListHTML(t) : createCardHTML(t, isArtist);
            });
            container.innerHTML = html;
        } else {
            container.innerHTML = '<div style="color:var(--text-sub); font-size:13px;">📭 Tidak ada data</div>';
        }
    } catch(e) {
        console.error('Fetch error:', e);
        container.innerHTML = '<div style="color:var(--text-sub); font-size:13px;">⚠️ Gagal memuat</div>';
    }
}

function loadHomeData() {
    homeDisplayedVideoIds.clear();
    const queries = [
        { id: 'recentList', q: 'lagu indonesia hits', type: 'list' },
        { id: 'rowAnyar', q: 'lagu baru indonesia 2026', type: 'card' },
        { id: 'rowGembira', q: 'lagu ceria semangat', type: 'card' },
        { id: 'rowCharts', q: 'top 50 indonesia', type: 'card' },
        { id: 'rowGalau', q: 'lagu galau indonesia', type: 'card' },
        { id: 'rowBaru', q: 'lagu viral terbaru', type: 'card' },
        { id: 'rowTiktok', q: 'lagu tiktok viral indonesia', type: 'card' },
        { id: 'rowArtists', q: 'penyanyi indonesia populer', type: 'card' }
    ];
    queries.forEach(q => fetchAndRender(q.q, q.id, q.type, q.id === 'rowArtists', true));
}

function renderSearchCategories() {
    const cats = [
        { title: '🎵 Pop', color: '#4a2a1a' },
        { title: '🎸 Indie', color: '#2f231c' },
        { title: '🇮🇩 Indonesia', color: '#5a2d1a' },
        { title: '🎤 Hip Hop', color: '#3d2a1a' }
    ];
    const grid = document.getElementById('categoryGrid');
    if(!grid) return;
    grid.innerHTML = cats.map(c => `
        <div class="category-card" style="background-color:${c.color};" onclick="searchMusic('${c.title.replace(/[^a-zA-Z]/g,'').trim()}')">
            <div class="category-title">${c.title}</div>
        </div>
    `).join('');
}

let searchTimeout;
const searchInput = document.getElementById('searchInput');
if(searchInput) {
    searchInput.addEventListener('input', function(e) {
        clearTimeout(searchTimeout);
        const q = e.target.value.trim();
        if (q.length === 0) {
            document.getElementById('searchCategoriesUI').style.display = 'block';
            document.getElementById('searchResultsUI').style.display = 'none';
            return;
        }
        document.getElementById('searchCategoriesUI').style.display = 'none';
        document.getElementById('searchResultsUI').style.display = 'block';
        searchTimeout = setTimeout(() => searchMusic(q), 500);
    });
}

async function searchMusic(query) {
    if (!query.trim()) return;
    const container = document.getElementById('searchResults');
    if(!container) return;
    container.innerHTML = '<div style="color:var(--text-sub); font-size:13px;">🔍 Mencari...</div>';
    try {
        const res = await fetch(`api/ytmusic-wrapper.php?q=${encodeURIComponent(query)}`);
        const data = await res.json();
        if (data.status === true && data.result && data.result.length > 0) {
            let html = '';
            data.result.forEach(t => {
                t.thumbnail = t.thumbnail || 'https://placehold.co/48x48/1a120e/c49a6c?text=♪';
                html += createListHTML(t);
            });
            container.innerHTML = html;
        } else {
            container.innerHTML = '<div style="color:var(--text-sub); font-size:13px;">😕 Tidak ada hasil</div>';
        }
    } catch(e) {
        console.error('Search error:', e);
        container.innerHTML = '<div style="color:var(--text-sub); font-size:13px;">⚠️ Gagal mencari</div>';
    }
}

function playYouTubeAudio(videoId, autoPlay = true) {
    if (!videoId) { 
        showToast('⚠️ Video ID tidak valid'); 
        return; 
    }
    currentVideoId = videoId;
    const embedUrl = `https://www.youtube.com/embed/${videoId}?autoplay=${autoPlay ? 1 : 0}&controls=0&disablekb=1&fs=0&iv_load_policy=3&modestbranding=1&playsinline=1&rel=0&showinfo=0&loop=1`;
    audioIframe.src = embedUrl;
    console.log('🎵 Playing audio with videoId:', videoId);
    if (autoPlay) {
        isPlaying = true;
        updatePlayButtons(true);
        startFakeProgress();
    }
}

function startFakeProgress() {
    stopProgressBar();
    let progress = 0;
    const duration = 180;
    if (progressInterval) clearInterval(progressInterval);
    progressInterval = setInterval(() => {
        progress += 1.5;
        if (progress > 100) {
            progress = 0;
            stopProgressBar();
            handleTrackEnded();
            return;
        }
        updateProgress(progress, duration);
    }, 100);
}

function updateProgress(percent, duration) {
    const pb = document.getElementById('progressBar');
    if(pb) {
        pb.value = percent;
        pb.style.background = `linear-gradient(to right, white ${percent}%, rgba(255,255,255,0.2) ${percent}%)`;
    }
    const mp = document.getElementById('miniProgressBar');
    if(mp) mp.style.width = percent + '%';
    const dur = duration || 180;
    const current = (percent / 100) * dur;
    const ct = document.getElementById('currentTime');
    const tt = document.getElementById('totalTime');
    if(ct) ct.innerText = formatTime(current);
    if(tt) tt.innerText = formatTime(dur);
}

function stopProgressBar() { 
    if(progressInterval) {
        clearInterval(progressInterval); 
        progressInterval = null;
    }
}

function togglePlay() {
    if (!currentVideoId) { 
        showToast('⚠️ Tidak ada lagu diputar'); 
        return; 
    }
    if (isPlaying) {
        audioIframe.src = `https://www.youtube.com/embed/${currentVideoId}?autoplay=0&controls=0&disablekb=1&fs=0&iv_load_policy=3&modestbranding=1&playsinline=1&rel=0&showinfo=0`;
        isPlaying = false;
        updatePlayButtons(false);
        stopProgressBar();
    } else {
        audioIframe.src = `https://www.youtube.com/embed/${currentVideoId}?autoplay=1&controls=0&disablekb=1&fs=0&iv_load_policy=3&modestbranding=1&playsinline=1&rel=0&showinfo=0`;
        isPlaying = true;
        updatePlayButtons(true);
        startFakeProgress();
    }
}

function updatePlayButtons(playing) {
    const play = '<path d="M8 5v14l11-7z"/>';
    const pause = '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>';
    const icon = playing ? pause : play;
    ['mainPlayBtn', 'miniPlayBtn'].forEach(id => {
        const el = document.getElementById(id);
        if(el) el.innerHTML = icon;
    });
}

function formatTime(s) {
    if (!s || isNaN(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec < 10 ? '0' : ''}${sec}`;
}

function seekTo(value) {
    const percent = parseFloat(value);
    const pb = document.getElementById('progressBar');
    if(pb) {
        pb.value = percent;
        pb.style.background = `linear-gradient(to right, white ${percent}%, rgba(255,255,255,0.2) ${percent}%)`;
    }
    const mp = document.getElementById('miniProgressBar');
    if(mp) mp.style.width = percent + '%';
}

function expandPlayer() { 
    const modal = document.getElementById('playerModal');
    if(modal) modal.style.display = 'flex'; 
}
function minimizePlayer() { 
    const modal = document.getElementById('playerModal');
    if(modal) modal.style.display = 'none'; 
}

function handleTrackEnded() {
    isPlaying = false;
    updatePlayButtons(false);
    if (repeatState === 0) {
        playNextTrack(false);
    } else if (repeatState === 1) {
        if (currentRepeatCount < 1) { 
            currentRepeatCount++; 
            playYouTubeAudio(currentVideoId, true); 
        } else { 
            currentRepeatCount = 0; 
            playNextTrack(false); 
        }
    } else if (repeatState === 2) {
        if (currentRepeatCount < 3) { 
            currentRepeatCount++; 
            playYouTubeAudio(currentVideoId, true); 
        } else { 
            currentRepeatCount = 0; 
            playNextTrack(false); 
        }
    } else if (repeatState === 3) {
        playYouTubeAudio(currentVideoId, true);
    }
}

function playTrackData(track, reset = true) {
    if (!track || !track.videoId) {
        showToast('⚠️ Data lagu tidak valid');
        return;
    }
    const img = track.thumbnail || 'https://placehold.co/140x140/1a120e/c49a6c?text=♪';
    const data = { 
        videoId: track.videoId, 
        title: track.title || 'Untitled', 
        artist: track.artist || 'Unknown', 
        img: img 
    };
    playMusic(data, reset);
}

function playMusic(trackData, resetContext = true) {
    if (!trackData || !trackData.videoId) { 
        showToast('⚠️ Video ID tidak valid'); 
        return; 
    }
    currentTrack = trackData;
    if (resetContext) {
        playContext = { type: 'similar', currentIndex: -1, tracks: [] };
    }
    addToHistory(currentTrack);
    checkIfLiked(currentTrack.videoId);
    const imgSrc = currentTrack.img || 'https://placehold.co/44x44/1a120e/c49a6c?text=♪';
    const miniPlayer = document.getElementById('miniPlayer');
    if(miniPlayer) miniPlayer.style.display = 'flex';
    const miniImg = document.getElementById('miniPlayerImg');
    if(miniImg) miniImg.src = imgSrc;
    const miniTitle = document.getElementById('miniPlayerTitle');
    if(miniTitle) miniTitle.innerText = currentTrack.title || 'Judul Lagu';
    const miniArtist = document.getElementById('miniPlayerArtist');
    if(miniArtist) miniArtist.innerText = currentTrack.artist || 'Artis';
    const playerArt = document.getElementById('playerArt');
    if(playerArt) playerArt.src = imgSrc;
    const playerTitle = document.getElementById('playerTitle');
    if(playerTitle) playerTitle.innerText = currentTrack.title || 'Judul Lagu';
    const playerArtist = document.getElementById('playerArtist');
    if(playerArtist) playerArtist.innerText = currentTrack.artist || 'Artis';
    const playerBg = document.getElementById('playerBg');
    if(playerBg) playerBg.style.backgroundImage = `url('${imgSrc}')`;
    updateMediaSession();
    playYouTubeAudio(currentTrack.videoId, true);
    expandPlayer();
    showToast(`▶️ ${currentTrack.title}`);
}

function playNextTrack(isManual = true) {
    if(isManual) currentRepeatCount = 0;
    if (playContext.type === 'playlist' && playContext.tracks.length > 0) {
        playContext.currentIndex++;
        if (playContext.currentIndex < playContext.tracks.length) {
            const track = playContext.tracks[playContext.currentIndex];
            playTrackData(track, false);
            return;
        }
        showToast('📋 Playlist selesai');
        playContext.type = 'similar';
    }
    playNextSimilar();
}

function playPrevTrack() {
    showToast('⏮️ Lagu sebelumnya');
    if (currentVideoId) {
        playYouTubeAudio(currentVideoId, true);
        isPlaying = true;
        updatePlayButtons(true);
        startFakeProgress();
    }
}

async function playNextSimilar() {
    if (!currentTrack) return;
    try {
        const res = await fetch(`api/ytmusic-wrapper.php?q=${encodeURIComponent(currentTrack.artist)}`);
        const data = await res.json();
        if (data.status === true && data.result && data.result.length > 1) {
            const filtered = data.result.filter(t => t.videoId !== currentTrack.videoId);
            if (filtered.length > 0) {
                const random = filtered[Math.floor(Math.random() * filtered.length)];
                playTrackData(random, true);
                return;
            }
        }
        showToast('⏭️ Lagu berikutnya');
    } catch(e) { 
        console.error('Play next error:', e);
        showToast('⏭️ Lagu berikutnya'); 
    }
}

function toggleShuffle() {
    isShuffle = !isShuffle;
    const btn1 = document.getElementById('btnShuffle');
    const btn2 = document.getElementById('btnPlaylistShuffle');
    const color = isShuffle ? 'var(--spotify-green)' : 'var(--text-sub)';
    if (btn1) btn1.style.fill = color;
    if (btn2) btn2.style.fill = color;
    showToast(isShuffle ? "🔀 Acak dihidupkan" : "🔀 Acak dimatikan");
}

function toggleRepeat() {
    repeatState = (repeatState + 1) % 4;
    const btn = document.getElementById('btnRepeat');
    const badge = document.getElementById('repeatBadge');
    if (repeatState === 0) {
        if(btn) btn.style.fill = 'var(--text-sub)';
        if(badge) badge.style.display = 'none';
        showToast("🔁 Ulangi dimatikan");
    } else {
        if(btn) btn.style.fill = 'var(--spotify-green)';
        if(badge) badge.style.display = 'block';
        if (repeatState === 1) { 
            if(badge) badge.innerText = "1x"; 
            showToast("🔁 Ulangi 1 kali"); 
        }
        if (repeatState === 2) { 
            if(badge) badge.innerText = "3x"; 
            showToast("🔁 Ulangi 3 kali"); 
        }
        if (repeatState === 3) { 
            if(badge) badge.innerText = "∞"; 
            showToast("🔁 Ulangi terus"); 
        }
    }
}

function addToHistory(track) {
    if(!db) return;
    try {
        const tx = db.transaction("history_songs", "readwrite");
        tx.objectStore("history_songs").put({ ...track, timestamp: Date.now() });
    } catch(e) {}
}

function checkIfLiked(videoId) {
    if(!db) return;
    try {
        const tx = db.transaction("liked_songs", "readonly");
        const req = tx.objectStore("liked_songs").get(videoId);
        req.onsuccess = function() {
            const btn = document.getElementById('btnLikeSong');
            if(!btn) return;
            if(req.result) { 
                btn.style.fill = 'var(--spotify-green)'; 
                btn.style.stroke = 'var(--spotify-green)'; 
            } else { 
                btn.style.fill = 'transparent'; 
                btn.style.stroke = 'white'; 
            }
        };
    } catch(e) {}
}

function toggleLike() {
    if(!currentTrack || !db) return;
    const tx = db.transaction("liked_songs", "readwrite");
    const store = tx.objectStore("liked_songs");
    const req = store.get(currentTrack.videoId);
    req.onsuccess = function() {
        const btn = document.getElementById('btnLikeSong');
        if(!btn) return;
        if(req.result) {
            store.delete(currentTrack.videoId);
            btn.style.fill = 'transparent';
            btn.style.stroke = 'white';
            showToast("💔 Dihapus dari Suka");
        } else {
            store.put(currentTrack);
            btn.style.fill = 'var(--spotify-green)';
            btn.style.stroke = 'var(--spotify-green)';
            showToast("❤️ Ditambahkan ke Suka");
        }
        renderLibraryUI();
    };
}

function downloadCurrentTrack() {
    if(!currentTrack) return;
    showToast("💾 Menyimpan untuk offline...");
    const tx = db.transaction("offline_songs", "readwrite");
    tx.objectStore("offline_songs").put(currentTrack);
    setTimeout(() => { 
        showToast("✅ Tersedia di Unduhan"); 
        renderLibraryUI(); 
    }, 1500);
    closePlayerMenuModal();
}

function downloadCurrentPlaylist() {
    if(!currentPlaylistTracks || currentPlaylistTracks.length === 0) {
        showToast("⚠️ Tidak ada lagu di playlist");
        return;
    }
    showToast(`💾 Menyiapkan ${currentPlaylistTracks.length} lagu untuk offline...`);
    const tx = db.transaction("offline_songs", "readwrite");
    const store = tx.objectStore("offline_songs");
    currentPlaylistTracks.forEach(t => store.put(t));
    setTimeout(() => { 
        showToast("✅ Selesai! Tersedia di Unduhan"); 
        renderLibraryUI(); 
    }, 3000);
}

function showToast(msg) {
    const toast = document.getElementById('customToast');
    if(!toast) return;
    toast.innerText = msg;
    toast.classList.add('show');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => { toast.classList.remove('show'); }, 3000);
}

function updateMediaSession() {
    if ('mediaSession' in navigator && currentTrack) {
        try {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: currentTrack.title || 'Lagu',
                artist: currentTrack.artist || 'Artis',
                artwork: [{ src: currentTrack.img || 'https://placehold.co/512x512/1a120e/c49a6c?text=♪', sizes: '512x512' }]
            });
            navigator.mediaSession.setActionHandler('play', togglePlay);
            navigator.mediaSession.setActionHandler('pause', togglePlay);
            navigator.mediaSession.setActionHandler('nexttrack', () => playNextTrack(true));
        } catch(e) {}
    }
}

function openArtistView(name) {
    document.getElementById('artistNameDisplay').innerText = name;
    const container = document.getElementById('artistTracksContainer');
    if(!container) return;
    container.innerHTML = '<div style="color:var(--text-sub); font-size:13px;">⏳ Memuat...</div>';
    switchView('artist');
    fetch(`api/ytmusic-wrapper.php?q=${encodeURIComponent(name)}`)
        .then(r => r.json())
        .then(data => {
            if (data.status === true && data.result && data.result.length > 0) {
                let html = '';
                data.result.forEach(t => {
                    t.thumbnail = t.thumbnail || 'https://placehold.co/48x48/1a120e/c49a6c?text=♪';
                    html += createListHTML(t);
                });
                container.innerHTML = html;
            } else {
                container.innerHTML = '<div style="color:var(--text-sub); font-size:13px;">😕 Tidak ada lagu</div>';
            }
        })
        .catch(() => container.innerHTML = '<div style="color:var(--text-sub); font-size:13px;">⚠️ Gagal memuat</div>');
}

function playFirstArtistTrack() {
    const container = document.getElementById('artistTracksContainer');
    const first = container.querySelector('.v-item');
    if(first) first.click();
}

function renderLibraryUI() {
    if(!db) return;
    const container = document.getElementById('libraryContainer');
    if(!container) return;
    const likedTx = db.transaction("liked_songs", "readonly");
    const likedReq = likedTx.objectStore("liked_songs").count();
    const favTx = db.transaction("favorite_songs", "readonly");
    const favReq = favTx.objectStore("favorite_songs").count();
    const playlistTx = db.transaction("playlists", "readonly");
    const playlistReq = playlistTx.objectStore("playlists").getAll();
    Promise.all([
        new Promise(r => { likedReq.onsuccess = () => r(likedReq.result); }),
        new Promise(r => { favReq.onsuccess = () => r(favReq.result); }),
        new Promise(r => { playlistReq.onsuccess = () => r(playlistReq.result); })
    ]).then(([likedCount, favCount, playlists]) => {
        let html = `
            <div class="lib-item" onclick="openPlaylistView('liked')">
                <div class="lib-item-img liked" style="display:flex;justify-content:center;align-items:center;font-size:28px;">❤️</div>
                <div class="lib-item-info"><div class="lib-item-title">Lagu Disukai</div><div class="lib-item-sub">${likedCount} lagu</div></div>
            </div>
            <div class="lib-item" onclick="openPlaylistView('favorites')">
                <div class="lib-item-img fav" style="display:flex;justify-content:center;align-items:center;font-size:28px;">⭐</div>
                <div class="lib-item-info"><div class="lib-item-title">Favorit</div><div class="lib-item-sub">${favCount} lagu</div></div>
            </div>
        `;
        playlists.forEach(p => {
            const count = (p.tracks || []).length;
            html += `
                <div class="lib-item" onclick="openPlaylistView('${p.id}')">
                    <div class="lib-item-img" style="background:linear-gradient(135deg,#3d2a1a,#6d4a2a);display:flex;justify-content:center;align-items:center;font-size:28px;">📀</div>
                    <div class="lib-item-info"><div class="lib-item-title">${p.name}</div><div class="lib-item-sub">${count} lagu</div></div>
                </div>
            `;
        });
        container.innerHTML = html;
    }).catch(e => console.error('Render library error:', e));
}

function openPlaylistView(id) {
    switchView('playlist');
    const container = document.getElementById('playlistTracksContainer');
    if(!container) return;
    container.innerHTML = '<div style="color:var(--text-sub); font-size:13px;">⏳ Memuat...</div>';
    activePlaylistId = id;
    if (id === 'liked') {
        document.getElementById('playlistNameDisplay').innerText = '❤️ Lagu Disukai';
        const imgDisplay = document.getElementById('playlistImageDisplay');
        const svgDisplay = document.getElementById('playlistSvgDisplay');
        if(imgDisplay) imgDisplay.style.display = 'none';
        if(svgDisplay) {
            svgDisplay.style.display = 'block';
            svgDisplay.innerHTML = '<path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>';
        }
        const tx = db.transaction("liked_songs", "readonly");
        const req = tx.objectStore("liked_songs").getAll();
        req.onsuccess = () => { 
            currentPlaylistTracks = req.result || []; 
            renderPlaylistTracks(req.result || []); 
        };
    } else if (id === 'favorites') {
        document.getElementById('playlistNameDisplay').innerText = '⭐ Favorit';
        const imgDisplay = document.getElementById('playlistImageDisplay');
        const svgDisplay = document.getElementById('playlistSvgDisplay');
        if(imgDisplay) imgDisplay.style.display = 'none';
        if(svgDisplay) {
            svgDisplay.style.display = 'block';
            svgDisplay.innerHTML = '<path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/>';
        }
        const tx = db.transaction("favorite_songs", "readonly");
        const req = tx.objectStore("favorite_songs").getAll();
        req.onsuccess = () => { 
            currentPlaylistTracks = req.result || []; 
            renderPlaylistTracks(req.result || []); 
        };
    } else {
        const tx = db.transaction("playlists", "readonly");
        const req = tx.objectStore("playlists").get(id);
        req.onsuccess = () => {
            const p = req.result;
            if(!p) { 
                container.innerHTML = '<div style="color:var(--text-sub); font-size:13px;">📭 Playlist tidak ditemukan</div>'; 
                return; 
            }
            document.getElementById('playlistNameDisplay').innerText = '📀 ' + p.name;
            const imgDisplay = document.getElementById('playlistImageDisplay');
            const svgDisplay = document.getElementById('playlistSvgDisplay');
            if(p.img) {
                if(imgDisplay) {
                    imgDisplay.src = p.img;
                    imgDisplay.style.display = 'block';
                }
                if(svgDisplay) svgDisplay.style.display = 'none';
            } else {
                if(imgDisplay) imgDisplay.style.display = 'none';
                if(svgDisplay) {
                    svgDisplay.style.display = 'block';
                    svgDisplay.innerHTML = '<path d="M4 6h16v2H4V6zm0 5h16v2H4v-2zm0 5h10v2H4v-2z"/>';
                }
            }
            currentPlaylistTracks = p.tracks || [];
            renderPlaylistTracks(currentPlaylistTracks);
        };
    }
}

function renderPlaylistTracks(tracks) {
    const container = document.getElementById('playlistTracksContainer');
    if(!container) return;
    const stats = document.getElementById('playlistStatsDisplay');
    if(stats) stats.innerText = (tracks || []).length + ' lagu';
    if (!tracks || tracks.length === 0) {
        container.innerHTML = '<div style="color:var(--text-sub); font-size:13px;">📭 Belum ada lagu</div>';
        return;
    }
    let html = '';
    tracks.forEach(t => {
        t.thumbnail = t.thumbnail || 'https://placehold.co/48x48/1a120e/c49a6c?text=♪';
        const dataStr = JSON.stringify(t).replace(/'/g, "\\'");
        html += `<div class="v-item" onclick="playTrackData(${dataStr}, true)">
            <input type="checkbox" class="v-checkbox" onchange="handleCheckDelete('${t.videoId}', this.checked)">
            <img src="${t.thumbnail}" class="v-img" onerror="this.src='https://placehold.co/48x48/1a120e/c49a6c?text=♪'">
            <div class="v-info">
                <div class="v-title">${t.title || 'Untitled'}</div>
                <div class="v-sub">${t.artist || 'Unknown'}</div>
            </div>
            <div class="dots-container">⋯</div>
        </div>`;
    });
    container.innerHTML = html;
    if(isEditMode) {
        document.querySelectorAll('#playlistTracksContainer .v-item').forEach(item => item.classList.add('editing'));
        const bar = document.getElementById('bulkActionBar');
        if(bar) bar.style.display = 'flex';
    }
}

function playFirstPlaylistTrack() {
    const container = document.getElementById('playlistTracksContainer');
    const first = container.querySelector('.v-item');
    if(first) first.click();
}

function openCreatePlaylist() {
    const modal = document.getElementById('createPlaylistModal');
    if(modal) modal.style.display = 'flex';
    const input = document.getElementById('cpName');
    if(input) input.value = '';
    const preview = document.getElementById('cpPreview');
    if(preview) preview.src = 'https://placehold.co/120x120/1a120e/c49a6c?text=+';
}
function closeCreatePlaylist() { 
    const modal = document.getElementById('createPlaylistModal');
    if(modal) modal.style.display = 'none'; 
}

function previewImage(event) {
    const file = event.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = (e) => { 
            const preview = document.getElementById('cpPreview');
            if(preview) preview.src = e.target.result; 
        };
        reader.readAsDataURL(file);
    }
}

function saveNewPlaylist() {
    const nameInput = document.getElementById('cpName');
    if(!nameInput) return;
    const name = nameInput.value.trim();
    if (!name) { showToast('⚠️ Masukkan nama'); return; }
    const preview = document.getElementById('cpPreview');
    const img = preview && preview.src && !preview.src.includes('placehold') ? preview.src : 'https://placehold.co/160x160/1a120e/c49a6c?text=📀';
    const newPl = { id: Date.now().toString(), name: name, img: img, tracks: [] };
    const tx = db.transaction("playlists", "readwrite");
    tx.objectStore("playlists").add(newPl);
    tx.oncomplete = () => {
        showToast(`✅ Playlist "${name}" dibuat`);
        closeCreatePlaylist();
        renderLibraryUI();
    };
    tx.onerror = (e) => {
        console.error('Save playlist error:', e);
        showToast('⚠️ Gagal membuat playlist');
    };
}

function openAddToPlaylistModal() {
    if (!currentTrack) { showToast('⚠️ Tidak ada lagu diputar'); return; }
    const tx = db.transaction("playlists", "readonly");
    const req = tx.objectStore("playlists").getAll();
    req.onsuccess = () => {
        const list = document.getElementById('addToPlaylistList');
        if(!list) return;
        if(req.result.length === 0) {
            list.innerHTML = '<div style="color:var(--text-sub); font-size:13px;">📭 Belum ada playlist</div>';
        } else {
            let html = '';
            req.result.forEach(p => {
                const exists = (p.tracks || []).some(t => t.videoId === currentTrack.videoId);
                html += `
                    <div class="lib-item" onclick="addToPlaylist('${p.id}')" style="opacity:${exists ? 0.5 : 1};">
                        <div class="lib-item-img" style="background:linear-gradient(135deg,#3d2a1a,#6d4a2a);display:flex;justify-content:center;align-items:center;font-size:24px;">📀</div>
                        <div class="lib-item-info">
                            <div class="lib-item-title">${p.name} ${exists ? '✅' : ''}</div>
                            <div class="lib-item-sub">${(p.tracks||[]).length} lagu</div>
                        </div>
                    </div>
                `;
            });
            list.innerHTML = html;
        }
        document.getElementById('addToPlaylistModal').style.display = 'flex';
    };
}
function closeAddToPlaylistModal() { 
    document.getElementById('addToPlaylistModal').style.display = 'none'; 
}

function addToPlaylist(playlistId) {
    if (!currentTrack) return;
    const tx = db.transaction("playlists", "readwrite");
    const store = tx.objectStore("playlists");
    const req = store.get(playlistId);
    req.onsuccess = () => {
        const p = req.result;
        if(!p) return;
        if(!p.tracks) p.tracks = [];
        if(!p.tracks.find(t => t.videoId === currentTrack.videoId)) {
            p.tracks.push(currentTrack);
            store.put(p);
            showToast(`✅ Ditambahkan ke ${p.name}`);
        } else {
            showToast(`⚠️ Sudah ada di ${p.name}`);
        }
        closeAddToPlaylistModal();
        renderLibraryUI();
    };
}

function openPlayerMenuModal() {
    if(!currentTrack) return;
    const menuArt = document.getElementById('menuArt');
    if(menuArt) menuArt.src = currentTrack.img || 'https://placehold.co/48x48/1a120e/c49a6c?text=♪';
    const menuTitle = document.getElementById('menuTitle');
    if(menuTitle) menuTitle.innerText = currentTrack.title || 'Judul';
    const menuArtist = document.getElementById('menuArtist');
    if(menuArtist) menuArtist.innerText = currentTrack.artist || 'Artis';
    document.getElementById('playerMenuModal').style.display = 'flex';
}
function closePlayerMenuModal() { 
    document.getElementById('playerMenuModal').style.display = 'none'; 
}

function toggleFavoritLagu() {
    if(!currentTrack || !db) return;
    const tx = db.transaction("favorite_songs", "readwrite");
    const store = tx.objectStore("favorite_songs");
    const req = store.get(currentTrack.videoId);
    req.onsuccess = function() {
        if(req.result) { 
            store.delete(currentTrack.videoId); 
            showToast("⭐ Dihapus dari Favorit"); 
        } else { 
            store.put(currentTrack); 
            showToast("⭐ Ditambahkan ke Favorit"); 
        }
        renderLibraryUI();
        closePlayerMenuModal();
    };
}

function shareLagu() {
    if(navigator.share && currentTrack) {
        navigator.share({ 
            title: currentTrack.title, 
            text: `🎵 ${currentTrack.title} - ${currentTrack.artist}`, 
            url: window.location.href 
        });
    } else {
        showToast(`📤 ${currentTrack.title} - ${currentTrack.artist}`);
    }
    closePlayerMenuModal();
}

function setSleepTimer() {
    const minutes = prompt("⏰ Matikan musik otomatis dalam berapa menit?", "15");
    if(minutes && parseInt(minutes) > 0) {
        setTimeout(() => {
            if(audioIframe) {
                audioIframe.src = 'about:blank';
                isPlaying = false;
                updatePlayButtons(false);
                stopProgressBar();
            }
            showToast("💤 Musik dimatikan");
        }, parseInt(minutes) * 60000);
        showToast(`⏰ Timer ${minutes} menit`);
    }
    closePlayerMenuModal();
}

function toggleEditMode() {
    isEditMode = !isEditMode;
    selectedTracksForDelete.clear();
    document.querySelectorAll('#playlistTracksContainer .v-item').forEach(item => {
        if(isEditMode) item.classList.add('editing');
        else {
            item.classList.remove('editing');
            const checkbox = item.querySelector('.v-checkbox');
            if(checkbox) checkbox.checked = false;
        }
    });
    const bar = document.getElementById('bulkActionBar');
    if(isEditMode && bar) {
        bar.style.display = 'flex';
        updateDeleteCount();
    } else if(bar) {
        bar.style.display = 'none';
    }
}

function handleCheckDelete(videoId, isChecked) {
    if(isChecked) selectedTracksForDelete.add(videoId);
    else selectedTracksForDelete.delete(videoId);
    updateDeleteCount();
}

function updateDeleteCount() {
    const el = document.getElementById('selCountText');
    if(el) el.innerText = `${selectedTracksForDelete.size} lagu dipilih`;
}

function deleteSelectedTracks() {
    if(selectedTracksForDelete.size === 0) {
        showToast("⚠️ Pilih minimal satu lagu untuk dihapus");
        return;
    }
    let storeName = "";
    if(activePlaylistId === 'liked') storeName = "liked_songs";
    else if(activePlaylistId === 'favorites') storeName = "favorite_songs";
    else if(activePlaylistId === 'history') storeName = "history_songs";
    else if(activePlaylistId === 'offline') storeName = "offline_songs";

    if(storeName) {
        const tx = db.transaction(storeName, "readwrite");
        const store = tx.objectStore(storeName);
        selectedTracksForDelete.forEach(id => {
            if(activePlaylistId === 'history') {
                const req = store.openCursor();
                req.onsuccess = function(e) {
                    const cursor = e.target.result;
                    if(cursor) {
                        if(cursor.value && cursor.value.videoId === id) cursor.delete();
                        cursor.continue();
                    }
                }
            } else {
                store.delete(id);
            }
        });
        tx.oncomplete = () => {
            showToast(`🗑️ ${selectedTracksForDelete.size} lagu dihapus`);
            openPlaylistView(activePlaylistId);
        }
        tx.onerror = () => {
            showToast('⚠️ Gagal menghapus lagu');
        };
    } else {
        const tx = db.transaction("playlists", "readwrite");
        const store = tx.objectStore("playlists");
        const req = store.get(activePlaylistId);
        req.onsuccess = () => {
            const p = req.result;
            if(p) {
                p.tracks = p.tracks.filter(t => !selectedTracksForDelete.has(t.videoId));
                store.put(p);
                showToast(`🗑️ ${selectedTracksForDelete.size} lagu dihapus dari Playlist`);
                openPlaylistView(activePlaylistId);
            }
        };
        req.onerror = () => {
            showToast('⚠️ Gagal menghapus lagu dari playlist');
        };
    }
}

window.switchView = switchView;
window.playMusic = playMusic;
window.playTrackData = playTrackData;
window.togglePlay = togglePlay;
window.playNextTrack = playNextTrack;
window.playPrevTrack = playPrevTrack;
window.expandPlayer = expandPlayer;
window.minimizePlayer = minimizePlayer;
window.openPlayerMenuModal = openPlayerMenuModal;
window.closePlayerMenuModal = closePlayerMenuModal;
window.toggleLike = toggleLike;
window.toggleFavoritLagu = toggleFavoritLagu;
window.downloadCurrentTrack = downloadCurrentTrack;
window.shareLagu = shareLagu;
window.openCreatePlaylist = openCreatePlaylist;
window.closeCreatePlaylist = closeCreatePlaylist;
window.saveNewPlaylist = saveNewPlaylist;
window.openAddToPlaylistModal = openAddToPlaylistModal;
window.closeAddToPlaylistModal = closeAddToPlaylistModal;
window.addToPlaylist = addToPlaylist;
window.openPlaylistView = openPlaylistView;
window.playFirstPlaylistTrack = playFirstPlaylistTrack;
window.playFirstArtistTrack = playFirstArtistTrack;
window.openArtistView = openArtistView;
window.searchMusic = searchMusic;
window.showToast = showToast;
window.seekTo = seekTo;
window.toggleShuffle = toggleShuffle;
window.toggleRepeat = toggleRepeat;
window.setSleepTimer = setSleepTimer;
window.toggleEditMode = toggleEditMode;
window.handleCheckDelete = handleCheckDelete;
window.deleteSelectedTracks = deleteSelectedTracks;
window.loadHomeData = loadHomeData;
window.renderSearchCategories = renderSearchCategories;
window.previewImage = previewImage;
window.downloadCurrentPlaylist = downloadCurrentPlaylist;

console.log('🎵 X-Unity Music Player Loaded!');