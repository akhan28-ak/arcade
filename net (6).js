/*
 * Star Bounce — Online Multiplayer UI
 * -------------------------------------
 * Room creation + joining, a waiting lobby, and a networked match
 * controller. Never simulates physics itself — sends "toggle my paddle"
 * intent to the server and draws whatever `sb:state` snapshot arrives,
 * using the same StarBounceRender the local game uses.
 */

(function () {
  'use strict';

  const { SIDES, SIDES_FOR_COUNT } = window.StarBounceSim;
  const { drawFrame, SIDE_LABEL, SIDE_COLOR } = window.StarBounceRender;
  const Local = window.StarBounceLocal;
  const els = Local.elements;
  const START_LIVES = 5;

  const localModeBtn = document.getElementById('localModeBtn');
  const onlineModeBtn = document.getElementById('onlineModeBtn');
  const modeHint = document.getElementById('modeHint');
  const localPanel = document.getElementById('localPanel');
  const onlinePanel = document.getElementById('onlinePanel');

  const createTabBtn = document.getElementById('createTabBtn');
  const joinTabBtn = document.getElementById('joinTabBtn');
  const createForm = document.getElementById('createForm');
  const joinForm = document.getElementById('joinForm');
  const lobbyWait = document.getElementById('lobbyWait');

  const createNameInput = document.getElementById('createNameInput');
  const onlineCountRow = document.getElementById('onlineCountRow');
  const onlineCountHint = document.getElementById('onlineCountHint');
  const onlineSlotsWrap = document.getElementById('onlineSlotsWrap');
  const createError = document.getElementById('createError');
  const createRoomBtn = document.getElementById('createRoomBtn');

  const joinNameInput = document.getElementById('joinNameInput');
  const joinCodeInput = document.getElementById('joinCodeInput');
  const joinError = document.getElementById('joinError');
  const joinRoomBtn = document.getElementById('joinRoomBtn');

  const lobbyCodeDisplay = document.getElementById('lobbyCodeDisplay');
  const copyCodeBtn = document.getElementById('copyCodeBtn');
  const lobbySeats = document.getElementById('lobbySeats');
  const lobbyWaitMsg = document.getElementById('lobbyWaitMsg');
  const lobbyStartBtn = document.getElementById('lobbyStartBtn');
  const lobbyLeaveBtn = document.getElementById('lobbyLeaveBtn');

  const COUNTS = [2, 3, 4];
  const COUNT_HINT = { 2: 'Top vs Bottom.', 3: 'Three-way — one side sits out.', 4: 'Full arena.' };
  const DIFFICULTIES = ['easy', 'medium', 'hard'];

  const onlineState = {
    count: 2,
    slots: [
      { type: 'human' }, // seat 0 is always you
      { type: 'human' },
      { type: 'bot', difficulty: 'medium' },
      { type: 'bot', difficulty: 'medium' },
    ],
  };

  let socket = null;
  let myRoomCode = null;
  let mySeatIndex = null;
  let myToken = null;
  let iAmHost = false;
  let netMatch = null;

  function socketAvailable() { return typeof io !== 'undefined'; }

  const SESSION_KEY = 'starbounce_session';
  function saveSession() {
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify({ roomCode: myRoomCode, seatIndex: mySeatIndex, token: myToken })); }
    catch (e) { /* non-fatal */ }
  }
  function loadSession() {
    try { const raw = sessionStorage.getItem(SESSION_KEY); return raw ? JSON.parse(raw) : null; }
    catch (e) { return null; }
  }
  function clearSession() {
    try { sessionStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
  }

  function getSocket() {
    if (!socket && socketAvailable()) {
      socket = io();
      bindGlobalSocketHandlers(socket);
    }
    return socket;
  }

  // ---------------- Mode toggle ----------------

  function setMode(mode) {
    const online = mode === 'online';
    localModeBtn.classList.toggle('selected', !online);
    onlineModeBtn.classList.toggle('selected', online);
    localPanel.classList.toggle('hidden', online);
    onlinePanel.classList.toggle('hidden', !online);

    if (online) {
      Local.stopPreview();
      if (!socketAvailable()) {
        modeHint.textContent = 'Online play needs this page served by the arcade server — it looks like it was opened as a local file instead.';
        createRoomBtn.disabled = true;
        joinRoomBtn.disabled = true;
      } else {
        modeHint.textContent = '';
      }
    } else {
      modeHint.textContent = '';
      Local.startPreview();
    }
  }
  localModeBtn.addEventListener('click', () => setMode('local'));
  onlineModeBtn.addEventListener('click', () => setMode('online'));

  // ---------------- Create/Join tabs ----------------

  function setTab(tab) {
    createTabBtn.classList.toggle('selected', tab === 'create');
    joinTabBtn.classList.toggle('selected', tab === 'join');
    createForm.classList.toggle('hidden', tab !== 'create');
    joinForm.classList.toggle('hidden', tab !== 'join');
    lobbyWait.classList.add('hidden');
  }
  createTabBtn.addEventListener('click', () => setTab('create'));
  joinTabBtn.addEventListener('click', () => setTab('join'));

  // ---------------- Create-room form ----------------

  function renderOnlineCountRow() {
    onlineCountRow.innerHTML = '';
    COUNTS.forEach(n => {
      const btn = document.createElement('button');
      btn.className = 'opt-btn' + (n === onlineState.count ? ' selected' : '');
      btn.textContent = n;
      btn.addEventListener('click', () => { onlineState.count = n; renderOnlineCountRow(); renderOnlineSlots(); });
      onlineCountRow.appendChild(btn);
    });
    onlineCountHint.textContent = COUNT_HINT[onlineState.count];
  }

  function renderOnlineSlots() {
    onlineSlotsWrap.innerHTML = '';
    const activeSides = SIDES_FOR_COUNT[onlineState.count];
    for (let i = 0; i < onlineState.count; i++) {
      const sideKey = activeSides[i];
      const slot = onlineState.slots[i];
      const row = document.createElement('div');
      row.className = 'slot-row';

      const swatch = document.createElement('div');
      swatch.className = 'slot-swatch';
      swatch.style.background = SIDE_COLOR[sideKey];
      row.appendChild(swatch);

      const name = document.createElement('div');
      name.className = 'slot-name';
      name.textContent = SIDE_LABEL[sideKey];
      row.appendChild(name);

      if (i === 0) {
        const youTag = document.createElement('div');
        youTag.className = 'hint-text';
        youTag.style.margin = '0';
        youTag.textContent = 'You (host)';
        row.appendChild(youTag);
      } else {
        const toggle = document.createElement('div');
        toggle.className = 'type-toggle';
        ['human', 'bot'].forEach(t => {
          const b = document.createElement('button');
          b.className = 'type-btn' + (slot.type === t ? ' selected' : '');
          b.textContent = t === 'human' ? 'Open Seat' : 'Bot';
          b.addEventListener('click', () => { slot.type = t; renderOnlineSlots(); });
          toggle.appendChild(b);
        });
        row.appendChild(toggle);

        if (slot.type === 'bot') {
          const sel = document.createElement('select');
          sel.className = 'diff-select';
          DIFFICULTIES.forEach(d => {
            const opt = document.createElement('option');
            opt.value = d;
            opt.textContent = d.charAt(0).toUpperCase() + d.slice(1);
            if (d === (slot.difficulty || 'medium')) opt.selected = true;
            sel.appendChild(opt);
          });
          sel.addEventListener('change', () => { slot.difficulty = sel.value; });
          row.appendChild(sel);
        }
      }

      onlineSlotsWrap.appendChild(row);
    }
  }

  createRoomBtn.addEventListener('click', () => {
    const s = getSocket();
    if (!s) return;
    createError.textContent = '';
    const name = (createNameInput.value || 'Player').trim() || 'Player';
    const slots = onlineState.slots.slice(0, onlineState.count).map(slot =>
      slot.type === 'bot' ? { type: 'bot', difficulty: slot.difficulty || 'medium' } : { type: 'human' }
    );

    createRoomBtn.disabled = true;
    s.emit('sb:create', { count: onlineState.count, slots, name }, res => {
      createRoomBtn.disabled = false;
      if (!res || !res.ok) { createError.textContent = (res && res.error) || 'Could not create room.'; return; }
      enterLobby(res.roomCode, res.seatIndex, res.token, res.state);
    });
  });

  // ---------------- Join-room form ----------------

  joinRoomBtn.addEventListener('click', () => {
    const s = getSocket();
    if (!s) return;
    joinError.textContent = '';
    const name = (joinNameInput.value || 'Player').trim() || 'Player';
    const code = (joinCodeInput.value || '').trim().toUpperCase();
    if (!code) { joinError.textContent = 'Enter a room code.'; return; }

    joinRoomBtn.disabled = true;
    s.emit('sb:join', { roomCode: code, name }, res => {
      joinRoomBtn.disabled = false;
      if (!res || !res.ok) { joinError.textContent = (res && res.error) || 'Could not join room.'; return; }
      enterLobby(res.roomCode, res.seatIndex, res.token, res.state);
    });
  });

  // ---------------- Waiting lobby ----------------

  function enterLobby(roomCode, seatIndex, token, state) {
    myRoomCode = roomCode;
    mySeatIndex = seatIndex;
    myToken = token;
    iAmHost = state.hostSocketId === getSocket().id;
    saveSession();

    createForm.classList.add('hidden');
    joinForm.classList.add('hidden');
    lobbyWait.classList.remove('hidden');
    lobbyCodeDisplay.textContent = roomCode;
    renderLobbySeats(state);
  }

  function renderLobbySeats(state) {
    lobbySeats.innerHTML = '';
    state.slots.forEach((slot, i) => {
      const row = document.createElement('div');
      row.className = 'slot-row';

      const swatch = document.createElement('div');
      swatch.className = 'slot-swatch';
      swatch.style.background = SIDE_COLOR[slot.side];
      row.appendChild(swatch);

      const name = document.createElement('div');
      name.className = 'slot-name';
      name.textContent = SIDE_LABEL[slot.side];
      row.appendChild(name);

      const statusText = document.createElement('div');
      statusText.className = 'hint-text';
      statusText.style.margin = '0';
      if (slot.type === 'bot') statusText.textContent = `Bot · ${slot.difficulty}`;
      else if (slot.connected) statusText.textContent = i === mySeatIndex ? `${slot.name} (You)` : slot.name;
      else statusText.textContent = 'Open — waiting for a player…';
      row.appendChild(statusText);

      lobbySeats.appendChild(row);
    });

    const unfilled = state.slots.some(s => s.type === 'human' && !s.connected);
    lobbyStartBtn.classList.toggle('hidden', !iAmHost);
    lobbyStartBtn.disabled = unfilled;
    lobbyWaitMsg.textContent = iAmHost
      ? (unfilled ? 'Waiting for all seats to fill before you can start…' : 'All seats filled — ready to start!')
      : 'Waiting for the host to start the game…';
  }

  lobbyStartBtn.addEventListener('click', () => {
    const s = getSocket();
    if (!s) return;
    lobbyStartBtn.disabled = true;
    s.emit('sb:start', {}, res => {
      if (!res || !res.ok) { lobbyStartBtn.disabled = false; lobbyWaitMsg.textContent = (res && res.error) || 'Could not start game.'; }
    });
  });

  lobbyLeaveBtn.addEventListener('click', () => { leaveRoom(); setTab('create'); });

  copyCodeBtn.addEventListener('click', () => {
    if (!myRoomCode) return;
    navigator.clipboard?.writeText(myRoomCode).catch(() => {});
    copyCodeBtn.textContent = 'Copied!';
    setTimeout(() => { copyCodeBtn.textContent = 'Copy'; }, 1200);
  });

  function leaveRoom() {
    const s = getSocket();
    if (s && myRoomCode) s.emit('sb:leave');
    myRoomCode = null; mySeatIndex = null; myToken = null; iAmHost = false;
    clearSession();
    if (netMatch) { netMatch.stop(); netMatch = null; }
  }

  // ---------------- Networked match ----------------

  function playersBySideFromState(state) {
    const bySide = { top: null, right: null, bottom: null, left: null };
    state.slots.forEach(slot => {
      bySide[slot.side] = { type: slot.botControlled ? 'bot' : slot.type, difficulty: slot.botControlled && slot.type === 'human' ? 'medium' : slot.difficulty, name: slot.name };
    });
    return bySide;
  }

  function startNetworkedMatch(state) {
    const bySide = playersBySideFromState(state);
    const mySide = state.slots[mySeatIndex].side;
    const canvas = els.gameCanvas;
    const ctx = canvas.getContext('2d');

    let latestSnapshot = state.snapshot;
    let stopped = false;
    let rafId = null;

    function render() {
      if (stopped) return;
      if (latestSnapshot) {
        drawFrame(ctx, canvas.width, latestSnapshot, bySide);
        updateHUD(bySide, latestSnapshot);
      }
      rafId = requestAnimationFrame(render);
    }

    function updateHUD(bySide, snapshot) {
      els.hudEl.innerHTML = '';
      SIDES.forEach(key => {
        const p = bySide[key];
        if (!p) return;
        const s = snapshot.sides[key];
        const card = document.createElement('div');
        card.className = 'player-card' + (s.eliminated ? ' eliminated' : '');
        card.style.setProperty('--player-color', SIDE_COLOR[key]);
        const botTag = p.type === 'bot' ? `<span class="bot-tag">BOT · ${p.difficulty}</span>` : '';
        const you = key === mySide ? ' (You)' : '';
        const hearts = Array.from({ length: START_LIVES }, (_, i) => `<span class="heart${i < s.lives ? '' : ' lost'}">♥</span>`).join('');
        card.innerHTML = `
          <div class="swatch"></div>
          <div class="player-info">
            <div class="player-name">${SIDE_LABEL[key]}${you} ${botTag}</div>
            <div class="lives">${hearts}</div>
          </div>`;
        els.hudEl.appendChild(card);
      });
    }

    Local.buildControls(bySide, key => {
      if (key !== mySide) return;
      getSocket().emit('sb:toggle', {});
    });

    const s = getSocket();
    function onState(snapshot) {
      latestSnapshot = snapshot;
      if (snapshot.gameOver) {
        els.statusEl.textContent = '';
        if (snapshot.winnerSide) {
          els.winnerBanner.style.setProperty('--winner-color', SIDE_COLOR[snapshot.winnerSide]);
          els.winnerBanner.innerHTML = `🏆 ${SIDE_LABEL[snapshot.winnerSide]} wins!`;
        } else {
          els.winnerBanner.innerHTML = 'Game over';
        }
        els.winnerBanner.classList.add('show');
      }
    }
    function onUpdate(newState) {
      if (newState.roomCode !== myRoomCode) return;
      newState.slots.forEach(slot => {
        bySide[slot.side] = bySide[slot.side] || {};
        bySide[slot.side].type = slot.botControlled ? 'bot' : slot.type;
        bySide[slot.side].difficulty = slot.botControlled && slot.type === 'human' ? 'medium' : slot.difficulty;
        if (slot.name) bySide[slot.side].name = slot.name;
      });
    }
    s.on('sb:state', onState);
    s.on('sb:update', onUpdate);

    els.winnerBanner.classList.remove('show');
    els.winnerBanner.textContent = '';
    els.statusEl.textContent = 'Defend your line!';
    render();

    return {
      stop() {
        stopped = true;
        if (rafId) cancelAnimationFrame(rafId);
        s.off('sb:state', onState);
        s.off('sb:update', onUpdate);
      },
    };
  }

  function enterGameScreen() {
    els.homeBtn.textContent = 'Leave Room';
    els.restartBtn.classList.add('hidden');
    Local.showGameScreen();
  }

  // ---------------- Socket lifecycle ----------------

  function attemptResume(s) {
    if (myRoomCode) return;
    const sess = loadSession();
    if (!sess || !sess.roomCode || !sess.token) return;

    s.emit('sb:resume', sess, res => {
      if (!res || !res.ok) { clearSession(); return; }
      myRoomCode = res.roomCode; mySeatIndex = res.seatIndex; myToken = res.token;
      iAmHost = res.state.hostSocketId === s.id;
      saveSession();
      setMode('online');

      if (res.state.started) {
        enterGameScreen();
        if (netMatch) netMatch.stop();
        netMatch = startNetworkedMatch(res.state);
      } else {
        createForm.classList.add('hidden');
        joinForm.classList.add('hidden');
        lobbyWait.classList.remove('hidden');
        lobbyCodeDisplay.textContent = myRoomCode;
        renderLobbySeats(res.state);
      }
    });
  }

  function bindGlobalSocketHandlers(s) {
    if (!s || s.__starBounceBound) return;
    s.__starBounceBound = true;

    s.on('connect', () => attemptResume(s));

    s.on('sb:update', state => {
      if (state.roomCode !== myRoomCode || state.started) return;
      renderLobbySeats(state);
    });

    s.on('sb:started', state => {
      if (state.roomCode !== myRoomCode) return;
      enterGameScreen();
      netMatch = startNetworkedMatch(state);
    });
  }

  window.StarBounceNet = {
    onReturnToHome() {
      els.homeBtn.textContent = 'Change Settings';
      els.restartBtn.classList.remove('hidden');
      if (netMatch) { netMatch.stop(); netMatch = null; }
      if (myRoomCode) {
        leaveRoom();
        if (!onlinePanel.classList.contains('hidden')) setTab('create');
      }
    },
  };

  renderOnlineCountRow();
  renderOnlineSlots();

  if (socketAvailable() && loadSession()) {
    getSocket();
  }
})();
