/*
 * Snowball Siege — Setup Screen & Match View
 * ----------------------------------------------
 * Two things live here:
 *  1) The setup screen (player count / map picker for local play).
 *  2) createMatchView() — the shared camera/render/input loop used by
 *     BOTH local and online play. It knows how to draw a turn, animate
 *     a throw, and read drag gestures into an angle+power — but it
 *     never decides what a throw *does*; that's handed to it via
 *     callbacks (`onThrow`, `canControl`) so local play can call the
 *     local sim directly while net.js can emit to the server instead.
 */

(function () {
  'use strict';

  const { SnowballSim } = window.SnowballSim;
  const { MAPS, getMap, assignSpawns } = window.SnowballMaps;
  const { createRenderer, PALETTE_COLORS } = window.SnowballRender;
  const G = window.SnowballSim.geometry;

  const PALETTE = [
    { name: 'Crimson', color: '#e6435b' },
    { name: 'Sapphire', color: '#2f7cf6' },
    { name: 'Gold', color: '#f2b705' },
    { name: 'Violet', color: '#9b5de5' },
  ];

  const MAX_DRAG_PX = 140;
  const GRAB_RADIUS_PX = 46;
  const CAMERA_ZOOM = 2.3;
  const RESULT_PAUSE_S = 1.1;

  function hillPathD(map) {
    const pts = map.points.map(p => p.join(',')).join(' L');
    return `M0,70 L${pts} L100,70 Z`;
  }
  function renderMapSVG(map) {
    return `<svg viewBox="0 0 100 70" xmlns="http://www.w3.org/2000/svg">
      <path d="${hillPathD(map)}" fill="#ffffff" stroke="#b8cfe0" stroke-width="1.2"/>
    </svg>`;
  }
  function renderMapGrid(container, selectedId, onSelect) {
    container.innerHTML = '';
    MAPS.forEach(map => {
      const card = document.createElement('div');
      card.className = 'map-card' + (map.id === selectedId ? ' selected' : '');
      card.innerHTML = renderMapSVG(map) + `<div class="map-card-name">${map.name}</div>`;
      card.addEventListener('click', () => onSelect(map.id));
      container.appendChild(card);
    });
  }
  function describeSpawnPosition(index, total) {
    if (total === 2) return index === 0 ? 'left' : 'right';
    if (index === Math.floor((total - 1) / 2) && total % 2 === 1) return 'middle';
    return index < total / 2 ? 'left side' : 'right side';
  }

  // ==================================================================
  // Shared match view: camera + rendering + drag input + turn/health UI
  // ==================================================================

  function createMatchView(config) {
    // config: { canvas, healthBarsEl, turnBannerEl, winnerBannerEl,
    //           map, players: [{name}], turn, gameOver, winner,
    //           onThrow(angle, power), canControl(turnIndex) }
    const canvas = config.canvas;
    const renderer = createRenderer(canvas);
    const map = config.map;

    let players = config.players;
    let turn = config.turn;
    let gameOver = config.gameOver;
    let winner = config.winner;

    let camera = null;
    let cameraTarget = null;
    let phase = 'camera-move'; // camera-move | aiming | dragging | ball-flight | result-pause | gameover
    let drag = null;
    let flight = null; // { trajectory, elapsed, pendingApply }
    let resultTimer = 0;
    let running = false;
    let rafId = null;
    let lastTs = null;
    let stopped = false;

    function terrainY(x) { return window.SnowballSim.terrainHeightAt(map, x); }

    function initCameraOnTurn() {
      if (gameOver) { phase = 'gameover'; showWinnerBanner(); return; }
      const p = players[turn];
      cameraTarget = { x: p.x, y: terrainY(p.x) - 9, zoom: CAMERA_ZOOM };
      if (!camera) camera = { ...cameraTarget };
      phase = 'camera-move';
      updateTurnBanner();
    }

    function updateTurnBanner() {
      if (!config.turnBannerEl) return;
      if (gameOver) { config.turnBannerEl.textContent = ''; return; }
      const p = players[turn];
      const mine = config.canControl(turn);
      config.turnBannerEl.textContent = mine ? `Your turn — drag your stickman to throw` : `${p.name}'s turn`;
    }

    function updateHealthBars() {
      if (!config.healthBarsEl) return;
      config.healthBarsEl.innerHTML = '';
      players.forEach((p, i) => {
        const card = document.createElement('div');
        card.className = 'hp-card' + (p.eliminated ? ' eliminated' : '') + (i === turn && !gameOver ? ' active' : '');
        card.style.setProperty('--hp-color', PALETTE_COLORS[i]);
        card.innerHTML = `
          <div class="hp-name">${p.name}</div>
          <div class="hp-track"><div class="hp-fill" style="width:${Math.max(0, p.health)}%"></div></div>`;
        config.healthBarsEl.appendChild(card);
      });
    }

    function showWinnerBanner() {
      if (!config.winnerBannerEl) return;
      if (winner == null) {
        config.winnerBannerEl.innerHTML = `<div class="winner-banner-inner">Match over</div>`;
      } else {
        config.winnerBannerEl.innerHTML = `<div class="winner-banner-inner">🏆 ${players[winner].name} wins!</div>`;
      }
      config.winnerBannerEl.classList.add('show');
    }

    // ---- Input ----

    function canvasPointerPos(evt) {
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const clientX = evt.touches ? evt.touches[0].clientX : evt.clientX;
      const clientY = evt.touches ? evt.touches[0].clientY : evt.clientY;
      return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
    }

    function onPointerDown(evt) {
      if (phase !== 'aiming' || gameOver) return;
      if (!config.canControl(turn)) return;
      const pos = canvasPointerPos(evt);
      const p = players[turn];
      const s = renderer.worldToScreen(camera, p.x, terrainY(p.x) - 5);
      const dist = Math.hypot(pos.x - s.x, pos.y - s.y);
      if (dist > GRAB_RADIUS_PX) return;
      drag = { start: pos, cur: pos };
      phase = 'dragging';
      evt.preventDefault();
    }

    function onPointerMove(evt) {
      if (phase !== 'dragging' || !drag) return;
      drag.cur = canvasPointerPos(evt);
      evt.preventDefault();
    }

    function onPointerUp(evt) {
      if (phase !== 'dragging' || !drag) return;
      const dx = drag.cur.x - drag.start.x;
      const dy = drag.cur.y - drag.start.y;
      const mag = Math.hypot(dx, dy);
      drag = null;

      if (mag < 10) { phase = 'aiming'; return; }

      const power = Math.max(0, Math.min(1, mag / MAX_DRAG_PX));
      const angle = Math.atan2(-dy, -dx); // slingshot: throw opposite the drag
      phase = 'aiming'; // will be overridden to ball-flight once onThrow resolves
      config.onThrow(angle, power);
    }

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);

    // ---- Called by the owner (local sim result, or a server broadcast) ----
    // result: { trajectory, outcome, players, turn, gameOver, winner }
    function playThrowResult(result) {
      flight = { trajectory: result.trajectory, elapsed: 0, pending: result };
      phase = 'ball-flight';
    }

    function applyPendingResult() {
      const r = flight.pending;
      players = r.players;
      turn = r.turn;
      gameOver = r.gameOver;
      winner = r.winner;
      flight = null;
      updateHealthBars();
      phase = 'result-pause';
      resultTimer = RESULT_PAUSE_S;
    }

    // ---- Frame loop ----

    function computeLiveTrajectoryPreview() {
      if (!drag) return [];
      const dx = drag.cur.x - drag.start.x;
      const dy = drag.cur.y - drag.start.y;
      const mag = Math.hypot(dx, dy);
      if (mag < 6) return [];
      const power = Math.max(0, Math.min(1, mag / MAX_DRAG_PX));
      const angle = Math.atan2(-dy, -dx);
      const speed = G.MAX_SPEED * (0.35 + 0.65 * power);
      const p = players[turn];
      let x = p.x, y = terrainY(p.x) - G.BODY_H;
      let vx = Math.cos(angle) * speed, vy = Math.sin(angle) * speed;
      const pts = [];
      for (let i = 0; i < 70; i++) {
        vy += G.GRAVITY * (1 / 60);
        x += vx * (1 / 60);
        y += vy * (1 / 60);
        pts.push({ x, y });
        if (y >= terrainY(x) || x < 0 || x > G.WORLD_W) break;
      }
      return pts;
    }

    function frame(ts) {
      if (stopped) return;
      if (lastTs == null) lastTs = ts;
      const dt = Math.min(0.033, (ts - lastTs) / 1000);
      lastTs = ts;

      if (phase === 'camera-move' && camera) {
        camera.x += (cameraTarget.x - camera.x) * Math.min(1, dt * 6);
        camera.y += (cameraTarget.y - camera.y) * Math.min(1, dt * 6);
        camera.zoom += (cameraTarget.zoom - camera.zoom) * Math.min(1, dt * 6);
        if (Math.hypot(cameraTarget.x - camera.x, cameraTarget.y - camera.y) < 0.3 && Math.abs(cameraTarget.zoom - camera.zoom) < 0.02) {
          phase = 'aiming';
        }
      } else if (phase === 'ball-flight' && flight) {
        flight.elapsed += dt;
        const idx = Math.min(flight.trajectory.length - 1, Math.floor(flight.elapsed * 60));
        if (idx >= flight.trajectory.length - 1) {
          applyPendingResult();
        }
      } else if (phase === 'result-pause') {
        resultTimer -= dt;
        if (resultTimer <= 0) initCameraOnTurn();
      }

      draw();
      rafId = requestAnimationFrame(frame);
    }

    function draw() {
      if (!camera) return;
      renderer.clear();
      renderer.drawSky();
      renderer.drawTerrain(camera, map);

      players.forEach((p, i) => {
        if (p.eliminated) return;
        let pose = null, facing = 1;
        if (i === turn && phase === 'dragging' && drag) {
          const dx = drag.cur.x - drag.start.x, dy = drag.cur.y - drag.start.y;
          pose = { armAngle: Math.atan2(-dy, -dx) };
        }
        renderer.drawStickman(camera, p.x, terrainY(p.x), PALETTE_COLORS[i], pose, facing);
      });

      if (phase === 'dragging' && drag) {
        const preview = computeLiveTrajectoryPreview();
        renderer.drawTrajectoryPreview(camera, preview);
        const p = players[turn];
        const s = renderer.worldToScreen(camera, p.x, terrainY(p.x) - 13);
        const mag = Math.hypot(drag.cur.x - drag.start.x, drag.cur.y - drag.start.y);
        renderer.drawPowerIndicator(s.x, s.y, Math.min(1, mag / MAX_DRAG_PX));
      }

      if (phase === 'ball-flight' && flight) {
        const idx = Math.min(flight.trajectory.length - 1, Math.floor(flight.elapsed * 60));
        const pt = flight.trajectory[idx];
        renderer.drawBall(camera, pt.x, pt.y);
      }

      const arrows = renderer.offscreenArrows(camera, players, turn);
      renderer.drawOffscreenArrows(arrows);
    }

    function start() {
      stopped = false;
      running = true;
      updateHealthBars();
      initCameraOnTurn();
      rafId = requestAnimationFrame(frame);
    }
    function stop() {
      stopped = true;
      running = false;
      if (rafId) cancelAnimationFrame(rafId);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    }

    // For state changes with no throw to animate (e.g. a disconnected
    // player being eliminated online). Only applied if we're not
    // mid-animation, so it can never clobber a throw in progress.
    function applyExternalState(newState) {
      if (phase === 'ball-flight') return;
      players = newState.players;
      turn = newState.turn;
      gameOver = newState.gameOver;
      winner = newState.winner;
      updateHealthBars();
      if (gameOver) { phase = 'gameover'; showWinnerBanner(); }
      else initCameraOnTurn();
    }

    return { start, stop, playThrowResult, updateHealthBars, applyExternalState };
  }

  // ==================================================================
  // Setup screen
  // ==================================================================

  const setupScreen = document.getElementById('setupScreen');
  const gameScreen = document.getElementById('gameScreen');
  const mapPreview = document.getElementById('mapPreview');
  const mapPreviewCaption = document.getElementById('mapPreviewCaption');
  const countRow = document.getElementById('countRow');
  const mapGrid = document.getElementById('mapGrid');
  const startBtn = document.getElementById('startBtn');
  const homeBtn = document.getElementById('homeBtn');
  const gameCanvas = document.getElementById('gameCanvas');
  const healthBarsEl = document.getElementById('healthBars');
  const turnBannerEl = document.getElementById('turnBanner');
  const winnerBannerEl = document.getElementById('winnerBanner');

  const COUNTS = [2, 3, 4];

  const state = { count: 2, mapId: MAPS[0].id };

  function updateMapPreview(mapId) {
    const map = getMap(mapId);
    mapPreview.innerHTML = `<path d="${hillPathD(map)}" fill="#ffffff" stroke="#b8cfe0" stroke-width="1.2"/>`;
    mapPreviewCaption.textContent = map.name;
  }
  function renderCountRow() {
    countRow.innerHTML = '';
    COUNTS.forEach(n => {
      const btn = document.createElement('button');
      btn.className = 'opt-btn' + (n === state.count ? ' selected' : '');
      btn.textContent = n;
      btn.addEventListener('click', () => { state.count = n; renderCountRow(); });
      countRow.appendChild(btn);
    });
  }
  function refreshLocalMapGrid() {
    renderMapGrid(mapGrid, state.mapId, id => { state.mapId = id; refreshLocalMapGrid(); updateMapPreview(id); });
  }

  let currentMatch = null;

  function showGameScreen() {
    setupScreen.classList.add('hidden');
    gameScreen.classList.remove('hidden');
  }
  function showSetupScreen() {
    gameScreen.classList.add('hidden');
    setupScreen.classList.remove('hidden');
    winnerBannerEl.classList.remove('show');
    winnerBannerEl.innerHTML = '';
    if (currentMatch) { currentMatch.stop(); currentMatch = null; }
  }

  startBtn.addEventListener('click', () => {
    const map = getMap(state.mapId);
    const spawns = assignSpawns(map, state.count);
    const players = PALETTE.slice(0, state.count).map(p => ({ name: p.name }));
    const sim = new SnowballSim(map, players, spawns);

    currentMatch = createMatchView({
      canvas: gameCanvas,
      healthBarsEl, turnBannerEl, winnerBannerEl,
      map,
      players: sim.getState().players,
      turn: sim.getState().turn,
      gameOver: false,
      winner: null,
      canControl: () => true, // hotseat — whoever's turn it is controls this device
      onThrow: (angle, power) => {
        const result = sim.throwSnowball(sim.turn, angle, power);
        if (result) currentMatch.playThrowResult(result);
      },
    });
    currentMatch.start();
    showGameScreen();
  });

  homeBtn.addEventListener('click', () => {
    showSetupScreen();
    if (window.SnowballNet) window.SnowballNet.onReturnToHome();
  });

  renderCountRow();
  refreshLocalMapGrid();
  updateMapPreview(state.mapId);

  window.SnowballLocal = {
    PALETTE,
    renderMapSVG,
    hillPathD,
    renderMapGrid,
    describeSpawnPosition,
    showGameScreen,
    showSetupScreen,
    elements: { setupScreen, gameScreen, gameCanvas, healthBarsEl, turnBannerEl, winnerBannerEl, homeBtn },
  };
  window.SnowballMatchView = createMatchView;
})();
