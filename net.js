/*
 * Chip Wars — Online Multiplayer UI
 * -----------------------------------
 * Room creation + joining, a waiting lobby, and a networked game
 * controller. This module never decides game rules — it sends intent
 * ("I clicked r,c") to the server and only ever draws what the server's
 * `move:applied` / `game:started` broadcasts say happened, using the
 * same ChipWarsRenderer the local game uses.
 */

(function () {
  'use strict';

  const { PALETTE, sleep, createBoardRenderer } = window.ChipWarsRenderer;
  const Local = window.ChipWarsLocal;
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
  const onlineSizeRow = document.getElementById('onlineSizeRow');
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

  const SIZES = [6, 7, 8, 9];
  const COUNTS = [2, 3, 4];
  const COUNT_HINTS = { 2: '1v1.', 3: 'Three-way free-for-all.', 4: 'Full table.' };
  const DIFFICULTIES = ['easy', 'medium', 'hard'];

  const onlineState = {
    size: 7,
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
  let myPlayerIndex = null;
  let myToken = null;
  let iAmHost = false;
  let latestRoomState = null;
  let netGame = null; // active networked game controller, once started

  const SESSION_KEY = 'chipwars_session';
  function saveSession() {
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({ roomCode: myRoomCode, playerIndex: myPlayerIndex, token: myToken }));
    } catch (e) { /* storage unavailable — resume just won't work, non-fatal */ }
  }
  function loadSession() {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function clearSession() {
    try { sessionStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
  }

  function socketAvailable() {
    return typeof io !== 'undefined';
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
      Local.stopDemo();
      if (!socketAvailable()) {
        modeHint.textContent = 'Online play needs this page to be served by the Chip Wars server (npm start) — it looks like it was opened as a local file instead.';
        createRoomBtn.disabled = true;
        joinRoomBtn.disabled = true;
      } else {
        modeHint.textContent = '';
      }
    } else {
      modeHint.textContent = '';
      Local.restartDemo();
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

  function renderOnlineSizeRow() {
    onlineSizeRow.innerHTML = '';
    SIZES.forEach(sz => {
      const btn = document.createElement('button');
      btn.className = 'opt-btn' + (sz === onlineState.size ? ' selected' : '');
      btn.textContent = sz + '×' + sz;
      btn.addEventListener('click', () => { onlineState.size = sz; renderOnlineSizeRow(); });
      onlineSizeRow.appendChild(btn);
    });
  }

  function renderOnlineCountRow() {
    onlineCountRow.innerHTML = '';
    COUNTS.forEach(n => {
      const btn = document.createElement('button');
      btn.className = 'opt-btn' + (n === onlineState.count ? ' selected' : '');
      btn.textContent = n;
      btn.addEventListener('click', () => { onlineState.count = n; renderOnlineCountRow(); renderOnlineSlots(); });
      onlineCountRow.appendChild(btn);
    });
    onlineCountHint.textContent = COUNT_HINTS[onlineState.count];
  }

  function renderOnlineSlots() {
    onlineSlotsWrap.innerHTML = '';
    for (let i = 0; i < onlineState.count; i++) {
      const p = PALETTE[i];
      const slot = onlineState.slots[i];
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
    s.emit('room:create', { size: onlineState.size, slots, name }, res => {
      createRoomBtn.disabled = false;
      if (!res || !res.ok) {
        createError.textContent = (res && res.error) || 'Could not create room.';
        return;
      }
      enterLobby(res.roomCode, res.playerIndex, res.token, res.state);
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
    s.emit('room:join', { roomCode: code, name }, res => {
      joinRoomBtn.disabled = false;
      if (!res || !res.ok) {
        joinError.textContent = (res && res.error) || 'Could not join room.';
        return;
      }
      enterLobby(res.roomCode, res.playerIndex, res.token, res.state);
    });
  });

  // ---------------- Waiting lobby ----------------

  function enterLobby(roomCode, playerIndex, token, roomState) {
    myRoomCode = roomCode;
    myPlayerIndex = playerIndex;
    myToken = token;
    iAmHost = roomState.hostSocketId === getSocket().id;
    latestRoomState = roomState;
    saveSession();

    createForm.classList.add('hidden');
    joinForm.classList.add('hidden');
    lobbyWait.classList.remove('hidden');
    lobbyCodeDisplay.textContent = roomCode;
    renderLobbySeats(roomState);
  }

  function renderLobbySeats(roomState) {
    lobbySeats.innerHTML = '';
    roomState.slots.forEach((slot, i) => {
      const p = PALETTE[i];
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
      if (slot.type === 'bot') {
        statusText.textContent = `Bot · ${slot.difficulty}`;
      } else if (slot.connected) {
        statusText.textContent = (i === myPlayerIndex ? `${slot.name} (You)` : slot.name);
      } else if (slot.botControlled) {
        statusText.textContent = `${slot.name || 'Player'} — disconnected, bot filling in`;
      } else {
        statusText.textContent = 'Open — waiting for a player…';
      }
      row.appendChild(statusText);

      lobbySeats.appendChild(row);
    });

    const unfilled = roomState.slots.some(s => s.type === 'human' && !s.connected);
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
    s.emit('room:start', {}, res => {
      if (!res || !res.ok) {
        lobbyStartBtn.disabled = false;
        lobbyWaitMsg.textContent = (res && res.error) || 'Could not start game.';
      }
    });
  });

  lobbyLeaveBtn.addEventListener('click', () => {
    leaveRoom();
    setTab('create');
  });

  copyCodeBtn.addEventListener('click', () => {
    if (!myRoomCode) return;
    navigator.clipboard?.writeText(myRoomCode).catch(() => {});
    copyCodeBtn.textContent = 'Copied!';
    setTimeout(() => { copyCodeBtn.textContent = 'Copy'; }, 1200);
  });

  function leaveRoom() {
    const s = getSocket();
    if (s && myRoomCode) s.emit('room:leave');
    myRoomCode = null;
    myPlayerIndex = null;
    myToken = null;
    iAmHost = false;
    latestRoomState = null;
    clearSession();
    if (netGame) { netGame.stop(); netGame = null; }
  }

  // ---------------- Networked game ----------------

  function buildPlayersFromSlots(slots) {
    return slots.map((slot, i) => ({
      ...PALETTE[i],
      type: slot.botControlled ? 'bot' : slot.type,
      difficulty: slot.botControlled && slot.type === 'human' ? 'medium' : slot.difficulty,
      name: slot.type === 'human' ? slot.name || PALETTE[i].name : PALETTE[i].name,
      isYou: i === myPlayerIndex,
    }));
  }

  function startNetworkedGame(roomState) {
    const size = roomState.size;
    const players = buildPlayersFromSlots(roomState.slots);
    const renderer = createBoardRenderer({ size, players, boardEl: els.mainBoardEl, basePx: 460 });
    let grid = roomState.grid;
    let current = roomState.current;
    let eliminated = roomState.eliminated;
    let gameOver = roomState.gameOver;
    let animating = false;
    let stopped = false;

    function isClickable(r, c, data) {
      return !stopped && !gameOver && current === myPlayerIndex && data.owner === myPlayerIndex && data.dots > 0;
    }

    function redraw() {
      renderer.renderAll(grid, isClickable);
      renderer.updateHUD(els.hudEl, grid, current, eliminated, gameOver);
      renderer.updateStatus(
        els.statusEl,
        current,
        gameOver,
        current === myPlayerIndex ? ' — click one of your chips' : ' — waiting…'
      );
    }

    function onCellClick(r, c) {
      if (stopped || gameOver || current !== myPlayerIndex) return;
      if (grid[r][c].owner !== myPlayerIndex || grid[r][c].dots <= 0) return;
      renderer.clearClickable();
      getSocket().emit('move:make', { r, c }, res => {
        if (!res || !res.ok) redraw(); // rejected — restore clickability
      });
    }

    async function onMoveApplied(payload) {
      if (stopped) return;
      animating = true;
      await renderer.playEvents(payload.events, 190, () =>
        renderer.updateHUD(els.hudEl, grid, current, eliminated, gameOver)
      );
      animating = false;
      if (stopped) return;

      // The server's trailing grid is the ground truth for this move —
      // adopt it outright rather than trusting our own event replay to
      // have landed on the same state.
      grid = payload.grid;
      current = payload.current;
      eliminated = payload.eliminated;
      gameOver = payload.gameOver;

      if (gameOver) {
        renderer.finishGame(els.statusEl, els.winnerBanner, payload.winner);
        renderer.updateHUD(els.hudEl, grid, current, eliminated, gameOver);
        return;
      }
      redraw();
    }

    function applyServerState(state) {
      players.forEach((p, i) => {
        p.type = state.slots[i].botControlled ? 'bot' : state.slots[i].type;
        p.difficulty = state.slots[i].botControlled && state.slots[i].type === 'human' ? 'medium' : state.slots[i].difficulty;
        if (state.slots[i].name) p.name = state.slots[i].name;
      });
      grid = state.grid;
      current = state.current;
      eliminated = state.eliminated;
      gameOver = state.gameOver;
    }

    function onRoomUpdate(newState) {
      if (stopped || newState.roomCode !== myRoomCode || animating) return;
      applyServerState(newState);
      redraw();
      if (gameOver) renderer.finishGame(els.statusEl, els.winnerBanner, newState.winner);
    }

    // Belt-and-suspenders: periodically ask the server for the truth and
    // reconcile against it, so a missed broadcast (dropped packet, brief
    // disconnect) can never leave this client's board silently wrong.
    const syncTimer = setInterval(() => {
      if (stopped || gameOver || animating) return;
      const s = getSocket();
      if (!s) return;
      s.emit('state:sync', {}, res => {
        if (!res || !res.ok || stopped || animating) return;
        applyServerState(res.state);
        redraw();
        if (gameOver) {
          clearInterval(syncTimer);
          renderer.finishGame(els.statusEl, els.winnerBanner, res.state.winner);
        }
      });
    }, 4000);

    const s = getSocket();
    s.on('move:applied', onMoveApplied);
    s.on('room:update', onRoomUpdate);

    renderer.resetWinnerBanner(els.winnerBanner);
    renderer.buildDOM(onCellClick);
    redraw();

    return {
      stop() {
        stopped = true;
        clearInterval(syncTimer);
        s.off('move:applied', onMoveApplied);
        s.off('room:update', onRoomUpdate);
      },
      relayout: renderer.relayout,
    };
  }

  function enterGameScreen() {
    els.homeBtn.textContent = 'Leave Room';
    els.restartBtn.classList.add('hidden');
    Local.showGameScreen();
  }

  // ---------------- Wiring socket lifecycle to the lobby/game ----------------

  // Reattaches to a previously-held seat using the token saved in
  // sessionStorage — covers both a page refresh and socket.io's own
  // automatic reconnect after a brief network drop. The server hands
  // back a full snapshot either way, so the client never has to guess
  // what it might have missed while disconnected.
  function attemptResume(s) {
    if (myRoomCode) return; // already attached this session, nothing to resume
    const sess = loadSession();
    if (!sess || !sess.roomCode || !sess.token) return;

    s.emit('room:resume', sess, res => {
      if (!res || !res.ok) { clearSession(); return; }

      myRoomCode = res.roomCode;
      myPlayerIndex = res.playerIndex;
      myToken = res.token;
      iAmHost = res.state.hostSocketId === s.id;
      latestRoomState = res.state;
      saveSession();

      setMode('online');
      if (res.state.started) {
        enterGameScreen();
        if (netGame) netGame.stop();
        netGame = startNetworkedGame(res.state);
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
    if (!s || s.__chipWarsBound) return;
    s.__chipWarsBound = true;

    s.on('connect', () => attemptResume(s));

    s.on('room:update', state => {
      if (state.roomCode !== myRoomCode || state.started) return;
      latestRoomState = state;
      renderLobbySeats(state);
    });

    s.on('game:started', state => {
      if (state.roomCode !== myRoomCode) return;
      latestRoomState = state;
      enterGameScreen();
      netGame = startNetworkedGame(state);
    });
  }

  // Called by ui.js when the player clicks "Change Settings" / "Leave Room"
  // while a networked game or lobby is active.
  window.ChipWarsNet = {
    onReturnToHome() {
      els.homeBtn.textContent = 'Change Settings';
      els.restartBtn.classList.remove('hidden');
      if (netGame) { netGame.stop(); netGame = null; }
      if (myRoomCode) {
        leaveRoom();
        if (!onlinePanel.classList.contains('hidden')) setTab('create');
      }
    },
    relayout() {
      if (netGame) netGame.relayout();
    },
  };

  renderOnlineSizeRow();
  renderOnlineCountRow();
  renderOnlineSlots();

  // If we have a saved seat from before a page refresh, reconnect and
  // try to resume it automatically rather than waiting for a click.
  if (socketAvailable() && loadSession()) {
    getSocket();
  }
})();
