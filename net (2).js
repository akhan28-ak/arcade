/*
 * Snowball Siege — Online Play
 * -------------------------------
 * Lobby (create/join/wait) plus real gameplay. The server is
 * authoritative: a throw is sent as intent (`sw:throw` with angle +
 * power), the server runs the exact same SnowballSim used locally,
 * and broadcasts the full result (`sw:thrown`) to everyone in the
 * room — including the thrower. Every client, thrower included, only
 * ever animates a result it received from the server; nobody
 * simulates their own throw locally. That keeps all clients showing
 * the same outcome with no client-side prediction to reconcile.
 */

(function () {
  'use strict';

  const { getMap } = window.SnowballMaps;
  const Local = window.SnowballLocal;
  const els = Local.elements;

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
  const onlineMapGrid = document.getElementById('onlineMapGrid');
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
  const onlineState = { count: 2, mapId: window.SnowballMaps.MAPS[0].id };

  let socket = null;
  let myRoomCode = null;
  let mySeatIndex = null;
  let myToken = null;
  let iAmHost = false;
  let currentMatch = null;

  function socketAvailable() { return typeof io !== 'undefined'; }

  const SESSION_KEY = 'snowball_session';
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
    if (online && !socketAvailable()) {
      modeHint.textContent = 'Online play needs this page served by the arcade server — it looks like it was opened as a local file instead.';
      createRoomBtn.disabled = true;
      joinRoomBtn.disabled = true;
    } else {
      modeHint.textContent = '';
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
      btn.addEventListener('click', () => { onlineState.count = n; renderOnlineCountRow(); });
      onlineCountRow.appendChild(btn);
    });
  }
  function renderOnlineMapGrid() {
    Local.renderMapGrid(onlineMapGrid, onlineState.mapId, id => { onlineState.mapId = id; renderOnlineMapGrid(); });
  }

  createRoomBtn.addEventListener('click', () => {
    const s = getSocket();
    if (!s) return;
    createError.textContent = '';
    const name = (createNameInput.value || 'Player').trim() || 'Player';
    createRoomBtn.disabled = true;
    s.emit('sw:create', { count: onlineState.count, mapId: onlineState.mapId, name }, res => {
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
    s.emit('sw:join', { roomCode: code, name }, res => {
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
      const p = Local.PALETTE[i];
      const row = document.createElement('div');
      row.className = 'slot-row';
      const swatch = document.createElement('div');
      swatch.className = 'slot-swatch';
      swatch.style.background = p.color;
      row.appendChild(swatch);
      const name = document.createElement('div');
      name.className = 'slot-name';
      name.textContent = p.name;
      row.appendChild(name);
      const statusText = document.createElement('div');
      statusText.className = 'hint-text';
      statusText.style.margin = '0';
      statusText.textContent = slot.connected ? (i === mySeatIndex ? `${slot.name} (You)` : slot.name) : 'Open — waiting for a player…';
      row.appendChild(statusText);
      lobbySeats.appendChild(row);
    });
    const unfilled = state.slots.some(s => !s.connected);
    lobbyStartBtn.classList.toggle('hidden', !iAmHost);
    lobbyStartBtn.disabled = unfilled;
    lobbyWaitMsg.textContent = iAmHost
      ? (unfilled ? 'Waiting for everyone to join before you can start…' : 'Everyone is here — ready to start!')
      : 'Waiting for the host to start the game…';
  }

  lobbyStartBtn.addEventListener('click', () => {
    const s = getSocket();
    if (!s) return;
    lobbyStartBtn.disabled = true;
    s.emit('sw:start', {}, res => {
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
    if (s && myRoomCode) s.emit('sw:leave');
    myRoomCode = null; mySeatIndex = null; myToken = null; iAmHost = false;
    clearSession();
    if (currentMatch) { currentMatch.stop(); currentMatch = null; }
  }

  // ---------------- Real online gameplay ----------------

  function startOnlineMatch(startedPayload) {
    const map = getMap(startedPayload.mapId);
    const s = getSocket();

    currentMatch = window.SnowballMatchView({
      canvas: els.gameCanvas,
      healthBarsEl: els.healthBarsEl,
      turnBannerEl: els.turnBannerEl,
      winnerBannerEl: els.winnerBannerEl,
      map,
      players: startedPayload.players,
      turn: startedPayload.turn,
      gameOver: false,
      winner: null,
      canControl: turnIdx => turnIdx === mySeatIndex,
      onThrow: (angle, power) => {
        s.emit('sw:throw', { angle, power }, res => {
          if (!res || !res.ok) { /* server rejected (not your turn, etc.) — just stays in aiming phase */ }
        });
      },
    });

    function onThrown(result) {
      if (!currentMatch) return;
      currentMatch.playThrowResult(result);
    }
    function onPlayerLeft(newState) {
      if (!currentMatch) return;
      currentMatch.applyExternalState(newState);
    }
    s.on('sw:thrown', onThrown);
    s.on('sw:playerLeft', onPlayerLeft);

    els.winnerBannerEl.classList.remove('show');
    els.winnerBannerEl.innerHTML = '';
    currentMatch.start();
    els.homeBtn.textContent = 'Leave Match';

    const originalStop = currentMatch.stop;
    currentMatch.stop = () => { s.off('sw:thrown', onThrown); s.off('sw:playerLeft', onPlayerLeft); originalStop(); };
  }

  function enterGameScreen() {
    Local.showGameScreen();
  }

  // ---------------- Socket lifecycle ----------------

  function attemptResume(s) {
    if (myRoomCode) return;
    const sess = loadSession();
    if (!sess || !sess.roomCode || !sess.token) return;
    s.emit('sw:resume', sess, res => {
      if (!res || !res.ok) { clearSession(); return; }
      myRoomCode = res.roomCode; mySeatIndex = res.seatIndex; myToken = res.token;
      iAmHost = res.state.hostSocketId === s.id;
      saveSession();
      setMode('online');

      if (res.state.started && res.state.matchState) {
        enterGameScreen();
        startOnlineMatch({
          mapId: res.state.mapId,
          players: res.state.matchState.players,
          turn: res.state.matchState.turn,
        });
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
    if (!s || s.__snowballBound) return;
    s.__snowballBound = true;

    s.on('connect', () => attemptResume(s));

    s.on('sw:update', state => {
      if (state.roomCode !== myRoomCode || state.started) return;
      renderLobbySeats(state);
    });

    s.on('sw:started', payload => {
      if (payload.roomCode !== myRoomCode) return;
      enterGameScreen();
      startOnlineMatch(payload);
    });
  }

  window.SnowballNet = {
    onReturnToHome() {
      if (currentMatch) { currentMatch.stop(); currentMatch = null; }
      if (myRoomCode) {
        leaveRoom();
        if (!onlinePanel.classList.contains('hidden')) setTab('create');
      }
    },
  };

  renderOnlineCountRow();
  renderOnlineMapGrid();

  if (socketAvailable() && loadSession()) {
    getSocket();
  }
})();
