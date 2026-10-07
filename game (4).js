/*
 * Star Bounce — Local Play & Setup Screen
 * ------------------------------------------
 * Drives local hot-seat/vs-bot games and the home-screen preview using a
 * local StarBounceSim + a requestAnimationFrame loop. Also owns the
 * "Local Game" setup panel; net.js owns the "Online" panel and reuses
 * StarBounceRender the same way for networked play.
 */

(function () {
  'use strict';

  const { StarBounceSim, SIDES, SIDES_FOR_COUNT } = window.StarBounceSim;
  const { drawFrame, SIDE_LABEL, SIDE_COLOR } = window.StarBounceRender;
  const START_LIVES = 5;

  function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

  // ---------------- Local match controller (sim + render + rAF loop) ----------------
  function createLocalMatch(config) {
    const canvas = config.canvas;
    const ctx = canvas.getContext('2d');
    const sim = new StarBounceSim(config.playersBySide);
    let running = false;
    let stopped = true;
    let rafId = null;
    let lastTs = null;

    function isClickable() { return true; } // controls are per-side buttons, gated in game.js UI itself

    function frame(ts) {
      if (!running) return;
      if (lastTs == null) lastTs = ts;
      const dt = Math.min(0.033, (ts - lastTs) / 1000);
      lastTs = ts;

      sim.step(dt);
      drawFrame(ctx, canvas.width, sim.getSnapshot(), config.playersBySide);

      if (sim.gameOver && !stopped) {
        running = false;
        if (config.onGameOver) config.onGameOver(sim.winnerSide);
        return;
      }
      if (config.onTick) config.onTick(sim.getSnapshot());

      rafId = requestAnimationFrame(frame);
    }

    return {
      start() {
        stopped = false;
        running = true;
        lastTs = null;
        rafId = requestAnimationFrame(frame);
      },
      stop() {
        stopped = true;
        running = false;
        if (rafId) cancelAnimationFrame(rafId);
      },
      toggle(side) { sim.toggle(side); },
    };
  }

  // ---------------- Setup screen ----------------

  const setupScreen = document.getElementById('setupScreen');
  const gameScreen = document.getElementById('gameScreen');
  const previewCanvas = document.getElementById('previewCanvas');
  const gameCanvas = document.getElementById('gameCanvas');
  const countRow = document.getElementById('countRow');
  const countHint = document.getElementById('countHint');
  const slotsWrap = document.getElementById('slotsWrap');
  const startBtn = document.getElementById('startBtn');
  const homeBtn = document.getElementById('homeBtn');
  const restartBtn = document.getElementById('restartBtn');
  const hudEl = document.getElementById('hud');
  const statusEl = document.getElementById('statusLine');
  const winnerBanner = document.getElementById('winnerBanner');
  const paddleControls = document.getElementById('paddleControls');

  const COUNTS = [2, 3, 4];
  const COUNT_HINT = {
    2: 'Head to head — Top vs Bottom.',
    3: 'Three-way — one side sits out as a wall.',
    4: 'Full arena — every side in play.',
  };
  const DIFFICULTIES = ['easy', 'medium', 'hard'];

  const state = {
    count: 2,
    slots: [
      { type: 'human', difficulty: 'medium' },
      { type: 'human', difficulty: 'medium' },
      { type: 'bot', difficulty: 'medium' },
      { type: 'bot', difficulty: 'medium' },
    ],
  };

  function renderCountRow() {
    countRow.innerHTML = '';
    COUNTS.forEach(n => {
      const btn = document.createElement('button');
      btn.className = 'opt-btn' + (n === state.count ? ' selected' : '');
      btn.textContent = n;
      btn.addEventListener('click', () => { state.count = n; renderCountRow(); renderSlots(); });
      countRow.appendChild(btn);
    });
    countHint.textContent = COUNT_HINT[state.count];
  }

  function renderSlots() {
    slotsWrap.innerHTML = '';
    const activeSides = SIDES_FOR_COUNT[state.count];
    activeSides.forEach((sideKey, i) => {
      const slot = state.slots[i];
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

      const toggle = document.createElement('div');
      toggle.className = 'type-toggle';
      ['human', 'bot'].forEach(t => {
        const b = document.createElement('button');
        b.className = 'type-btn' + (slot.type === t ? ' selected' : '');
        b.textContent = t === 'human' ? 'Human' : 'Bot';
        b.addEventListener('click', () => { slot.type = t; renderSlots(); });
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
          if (d === slot.difficulty) opt.selected = true;
          sel.appendChild(opt);
        });
        sel.addEventListener('change', () => { slot.difficulty = sel.value; });
        row.appendChild(sel);
      }

      slotsWrap.appendChild(row);
    });
  }

  function playersBySideFromState() {
    const bySide = { top: null, right: null, bottom: null, left: null };
    const activeSides = SIDES_FOR_COUNT[state.count];
    activeSides.forEach((sideKey, i) => {
      const slot = state.slots[i];
      bySide[sideKey] = { type: slot.type, difficulty: slot.difficulty, name: SIDE_LABEL[sideKey] };
    });
    return bySide;
  }

  // ---- Home-screen preview (all bots, restarts on game over) ----
  let previewMatch = null;
  function startPreview() {
    if (previewMatch) previewMatch.stop();
    const bySide = {
      top: { type: 'bot', difficulty: 'medium', name: 'Top' },
      right: { type: 'bot', difficulty: 'hard', name: 'Right' },
      bottom: { type: 'bot', difficulty: 'medium', name: 'Bottom' },
      left: { type: 'bot', difficulty: 'easy', name: 'Left' },
    };
    previewMatch = createLocalMatch({
      canvas: previewCanvas,
      playersBySide: bySide,
      onGameOver: () => setTimeout(() => { if (!setupScreen.classList.contains('hidden') && isLocalTabActive()) startPreview(); }, 1200),
    });
    previewMatch.start();
  }
  function isLocalTabActive() {
    return !document.getElementById('onlinePanel') || document.getElementById('onlinePanel').classList.contains('hidden');
  }

  // ---- Real local game ----
  let liveMatch = null;

  function buildControls(bySide, onClick) {
    paddleControls.innerHTML = '';
    SIDES.forEach(key => {
      const p = bySide[key];
      if (!p) return;
      const btn = document.createElement('button');
      btn.className = 'paddle-btn ' + key;
      btn.style.background = SIDE_COLOR[key];
      btn.textContent = p.type === 'bot' ? `${SIDE_LABEL[key]} (Bot)` : SIDE_LABEL[key];
      if (p.type === 'bot') {
        btn.classList.add('bot-controlled');
      } else {
        btn.addEventListener('click', () => onClick(key));
      }
      paddleControls.appendChild(btn);
    });
  }

  function updateHUD(bySide, snapshot) {
    hudEl.innerHTML = '';
    SIDES.forEach(key => {
      const p = bySide[key];
      if (!p) return;
      const s = snapshot.sides[key];
      const card = document.createElement('div');
      card.className = 'player-card' + (s.eliminated ? ' eliminated' : '');
      card.style.setProperty('--player-color', SIDE_COLOR[key]);
      const botTag = p.type === 'bot' ? `<span class="bot-tag">BOT · ${p.difficulty}</span>` : '';
      const hearts = Array.from({ length: START_LIVES }, (_, i) =>
        `<span class="heart${i < s.lives ? '' : ' lost'}">♥</span>`
      ).join('');
      card.innerHTML = `
        <div class="swatch"></div>
        <div class="player-info">
          <div class="player-name">${SIDE_LABEL[key]} ${botTag}</div>
          <div class="lives">${hearts}</div>
        </div>`;
      hudEl.appendChild(card);
    });
  }

  function startLiveGame() {
    const bySide = playersBySideFromState();
    winnerBanner.classList.remove('show');
    winnerBanner.textContent = '';
    statusEl.textContent = 'Defend your line!';
    buildControls(bySide, key => liveMatch && liveMatch.toggle(key));

    liveMatch = createLocalMatch({
      canvas: gameCanvas,
      playersBySide: bySide,
      onTick: snapshot => updateHUD(bySide, snapshot),
      onGameOver: winnerSideKey => {
        statusEl.textContent = '';
        if (winnerSideKey) {
          winnerBanner.style.setProperty('--winner-color', SIDE_COLOR[winnerSideKey]);
          winnerBanner.innerHTML = `🏆 ${SIDE_LABEL[winnerSideKey]} wins!`;
        } else {
          winnerBanner.innerHTML = `Game over`;
        }
        winnerBanner.classList.add('show');
      },
    });
    liveMatch.start();
  }

  function showGameScreen() {
    setupScreen.classList.add('hidden');
    gameScreen.classList.remove('hidden');
    if (previewMatch) previewMatch.stop();
  }
  function showSetupScreen() {
    gameScreen.classList.add('hidden');
    setupScreen.classList.remove('hidden');
    if (liveMatch) liveMatch.stop();
    if (isLocalTabActive()) startPreview();
  }

  startBtn.addEventListener('click', () => { startLiveGame(); showGameScreen(); });
  homeBtn.addEventListener('click', () => {
    showSetupScreen();
    if (window.StarBounceNet) window.StarBounceNet.onReturnToHome();
  });
  restartBtn.addEventListener('click', () => { if (liveMatch) liveMatch.stop(); startLiveGame(); });

  renderCountRow();
  renderSlots();
  startPreview();

  window.StarBounceLocal = {
    createLocalMatch,
    startPreview,
    stopPreview: () => { if (previewMatch) previewMatch.stop(); },
    showGameScreen,
    showSetupScreen,
    isLocalTabActive,
    elements: { gameCanvas, hudEl, statusEl, winnerBanner, paddleControls, setupScreen, gameScreen, homeBtn, restartBtn },
    stopLiveMatch: () => { if (liveMatch) liveMatch.stop(); },
    buildControls,
    updateHUD,
  };
})();
