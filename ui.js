/*
 * Chip Wars — Local Game UI
 * --------------------------
 * Drives local hot-seat / vs-bot games and the autoplaying home-screen
 * demo board. Uses a local GameEngine directly (no network) and the
 * shared ChipWarsRenderer for all drawing. Also owns the "Local Game"
 * settings panel on the home screen; net.js owns the "Online" panel
 * and calls window.ChipWarsLocal.stopDemo()/restartDemo() when the
 * player switches between the two modes.
 */

(function () {
  'use strict';

  const { GameEngine } = window.ChipWarsEngine;
  const { PALETTE, sleep, createBoardRenderer } = window.ChipWarsRenderer;

  // ---------------- Local game controller (engine + renderer + bots) ----------------

  function createLocalGame(config) {
    const size = config.size;
    const players = config.players;
    const interactive = !!config.interactive;
    const moveDelay = config.moveDelay || 550;
    const stepDelay = config.stepDelay || 190;

    const engine = new GameEngine(size, players.length);
    const renderer = createBoardRenderer({ size, players, boardEl: config.boardEl, basePx: config.basePx });
    let processing = false;
    let stopped = true;

    function isClickable(r, c, data) {
      return interactive && !engine.gameOver && !processing && data.owner === engine.current && data.dots > 0;
    }

    function init() {
      stopped = false;
      engine.reset();
      processing = false;
      renderer.resetWinnerBanner(config.winnerBannerEl);
      renderer.buildDOM(interactive ? onCellClick : null);
      renderer.renderAll(engine.grid, isClickable);
      renderer.updateHUD(config.hud, engine.grid, engine.current, engine.eliminated, engine.gameOver);
      updateStatus();
      maybeScheduleBotMove();
    }

    function stop() {
      stopped = true;
    }

    function updateStatus() {
      renderer.updateStatus(config.statusEl, engine.current, engine.gameOver);
    }

    function maybeScheduleBotMove() {
      if (stopped || engine.gameOver) return;
      const p = players[engine.current];
      if (p.type !== 'bot') return;

      processing = true;
      renderer.clearClickable();
      setTimeout(() => {
        if (stopped || engine.gameOver) return;
        const mv = engine.chooseBotMove(engine.current, p.difficulty || 'medium');
        processing = false;
        if (mv) onCellClick(mv.r, mv.c);
      }, moveDelay);
    }

    async function onCellClick(r, c) {
      if (stopped || processing || !engine.isValidMove(r, c)) return;

      processing = true;
      renderer.clearClickable();

      const result = engine.applyMove(r, c);
      if (!result) {
        processing = false;
        return;
      }

      await renderer.playEvents(result.events, stepDelay, () =>
        renderer.updateHUD(config.hud, engine.grid, engine.current, engine.eliminated, engine.gameOver)
      );
      if (stopped) return;

      await sleep(120);
      if (stopped) return;

      renderer.renderAll(engine.grid, isClickable);
      renderer.updateHUD(config.hud, engine.grid, engine.current, engine.eliminated, engine.gameOver);

      if (result.gameOver) {
        processing = false;
        renderer.finishGame(config.statusEl, config.winnerBannerEl, result.winner);
        if (config.onGameOver) config.onGameOver(result.winner);
        return;
      }

      processing = false;
      updateStatus();
      maybeScheduleBotMove();
    }

    return { init, stop, relayout: renderer.relayout };
  }

  // ---------------- Home screen: "Local Game" settings ----------------

  const sizeRow = document.getElementById('sizeRow');
  const countRow = document.getElementById('countRow');
  const countHint = document.getElementById('countHint');
  const slotsWrap = document.getElementById('slotsWrap');
  const startBtn = document.getElementById('startBtn');
  const homeScreen = document.getElementById('homeScreen');
  const gameScreen = document.getElementById('gameScreen');
  const homeBtn = document.getElementById('homeBtn');
  const restartBtn = document.getElementById('restartBtn');
  const demoBoardEl = document.getElementById('demoBoard');
  const mainBoardEl = document.getElementById('board');
  const hudEl = document.getElementById('hud');
  const statusEl = document.getElementById('statusLine');
  const winnerBanner = document.getElementById('winnerBanner');

  const state = {
    size: 7,
    count: 2,
    slots: [
      { type: 'human', difficulty: 'medium' },
      { type: 'human', difficulty: 'medium' },
      { type: 'bot', difficulty: 'medium' },
      { type: 'bot', difficulty: 'medium' },
    ],
  };

  const SIZES = [6, 7, 8, 9];
  const COUNTS = [1, 2, 3, 4];
  const COUNT_HINTS = {
    1: 'Sandbox mode — free play with no opponents, no win condition.',
    2: 'Classic 1v1 — human or bot on either side.',
    3: 'Three-way free-for-all.',
    4: 'Full table — mix and match humans and bots.',
  };
  const DIFFICULTIES = ['easy', 'medium', 'hard'];

  function renderSizeRow() {
    sizeRow.innerHTML = '';
    SIZES.forEach(sz => {
      const btn = document.createElement('button');
      btn.className = 'opt-btn' + (sz === state.size ? ' selected' : '');
      btn.textContent = sz + '×' + sz;
      btn.addEventListener('click', () => {
        state.size = sz;
        renderSizeRow();
        restartDemo();
      });
      sizeRow.appendChild(btn);
    });
  }

  function renderCountRow() {
    countRow.innerHTML = '';
    COUNTS.forEach(n => {
      const btn = document.createElement('button');
      btn.className = 'opt-btn' + (n === state.count ? ' selected' : '');
      btn.textContent = n;
      btn.addEventListener('click', () => {
        state.count = n;
        renderCountRow();
        renderSlots();
      });
      countRow.appendChild(btn);
    });
    countHint.textContent = COUNT_HINTS[state.count];
  }

  function renderSlots() {
    slotsWrap.innerHTML = '';
    for (let i = 0; i < state.count; i++) {
      const p = PALETTE[i];
      const slot = state.slots[i];
      const row = document.createElement('div');
      row.className = 'slot-row';

      const swatch = document.createElement('div');
      swatch.className = 'slot-swatch';
      swatch.style.background = p.color;

      const name = document.createElement('div');
      name.className = 'slot-name';
      name.textContent = p.name;

      const toggle = document.createElement('div');
      toggle.className = 'type-toggle';
      ['human', 'bot'].forEach(t => {
        const b = document.createElement('button');
        b.className = 'type-btn' + (slot.type === t ? ' selected' : '');
        b.textContent = t === 'human' ? 'Human' : 'Bot';
        b.addEventListener('click', () => {
          slot.type = t;
          renderSlots();
        });
        toggle.appendChild(b);
      });

      row.appendChild(swatch);
      row.appendChild(name);
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
        sel.addEventListener('change', () => {
          slot.difficulty = sel.value;
        });
        row.appendChild(sel);
      }

      slotsWrap.appendChild(row);
    }
  }

  // ---------------- Demo (autoplaying) board ----------------

  let demoGame = null;
  function restartDemo() {
    if (demoGame) demoGame.stop();
    const demoPlayers = PALETTE.map((p, i) => ({
      ...p,
      type: 'bot',
      difficulty: ['easy', 'medium', 'hard', 'medium'][i],
    }));
    demoGame = createLocalGame({
      size: state.size,
      boardEl: demoBoardEl,
      players: demoPlayers,
      interactive: false,
      moveDelay: 480,
      stepDelay: 130,
      basePx: 300,
      onGameOver: () => {
        setTimeout(() => {
          if (!homeScreen.classList.contains('hidden') && isLocalModeActive()) restartDemo();
        }, 1300);
      },
    });
    demoGame.init();
  }
  function stopDemo() {
    if (demoGame) demoGame.stop();
  }

  function isLocalModeActive() {
    return !document.getElementById('onlinePanel') || document.getElementById('onlinePanel').classList.contains('hidden');
  }

  // ---------------- Main local game ----------------

  let mainGame = null;
  function startMainGame() {
    const players = PALETTE.slice(0, state.count).map((p, i) => ({
      ...p,
      type: state.slots[i].type,
      difficulty: state.slots[i].difficulty,
    }));
    mainGame = createLocalGame({
      size: state.size,
      boardEl: mainBoardEl,
      players,
      interactive: true,
      hud: hudEl,
      statusEl: statusEl,
      winnerBannerEl: winnerBanner,
      moveDelay: 650,
      stepDelay: 190,
      basePx: 460,
    });
    mainGame.init();
  }

  function showGameScreen() {
    homeScreen.classList.add('hidden');
    gameScreen.classList.remove('hidden');
    stopDemo();
  }

  function showHomeScreen() {
    gameScreen.classList.add('hidden');
    homeScreen.classList.remove('hidden');
    if (mainGame) mainGame.stop();
    if (isLocalModeActive()) restartDemo();
  }

  startBtn.addEventListener('click', () => {
    startMainGame();
    showGameScreen();
  });
  homeBtn.addEventListener('click', () => {
    showHomeScreen();
    if (window.ChipWarsNet) window.ChipWarsNet.onReturnToHome();
  });
  restartBtn.addEventListener('click', () => {
    if (mainGame) mainGame.init();
  });

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (demoGame) demoGame.relayout();
      if (mainGame) mainGame.relayout();
      if (window.ChipWarsNet) window.ChipWarsNet.relayout();
    }, 200);
  });

  renderSizeRow();
  renderCountRow();
  renderSlots();
  restartDemo();

  // Exposed so net.js can pause/resume the demo board and reuse the same
  // board element + game screen for networked matches.
  window.ChipWarsLocal = {
    createLocalGame,
    stopDemo,
    restartDemo,
    showGameScreen,
    showHomeScreen,
    isLocalModeActive,
    elements: { mainBoardEl, hudEl, statusEl, winnerBanner, homeScreen, gameScreen, homeBtn, restartBtn },
    stopMainGame: () => { if (mainGame) mainGame.stop(); },
  };
})();
