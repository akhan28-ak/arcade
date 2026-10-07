/*
 * Chip Wars — Board Renderer
 * ---------------------------
 * Pure presentation, shared by both the local (hot-seat/bot) game in
 * ui.js and the networked game in net.js. Knows how to draw chips/pips
 * and replay an engine event log as animation. Knows nothing about
 * whose turn it "should" be, sockets, or bot AI — callers pass in the
 * data (grid, players, turn info) each time.
 */

(function (root) {
  'use strict';

  const PALETTE = [
    { name: 'Crimson', color: '#e6435b', dark: '#a11e33' },
    { name: 'Sapphire', color: '#2f7cf6', dark: '#1a4fb0' },
    { name: 'Gold', color: '#f2b705', dark: '#b3860a' },
    { name: 'Violet', color: '#9b5de5', dark: '#6425a8' },
  ];

  function sleep(ms) {
    return new Promise(res => setTimeout(res, ms));
  }

  function pipPositionsFor(n) {
    switch (n) {
      case 1: return ['pos-c'];
      case 2: return ['pos-ml', 'pos-mr'];
      case 3: return ['pos-t', 'pos-bl', 'pos-br'];
      case 4: return ['pos-tl', 'pos-tr', 'pos-bl', 'pos-br'];
      default: return [];
    }
  }

  function computeCellPx(size, basePx) {
    const avail = Math.min(basePx, window.innerWidth - 60);
    return Math.max(20, Math.floor((avail - (size - 1) * 3 - 20) / size));
  }

  // Creates a renderer bound to one board element + (optional) HUD/status/
  // winner elements. `players` is presentation metadata: [{name,color,dark,type,difficulty}, ...]
  function createBoardRenderer(opts) {
    const size = opts.size;
    const players = opts.players;
    const boardEl = opts.boardEl;
    const basePx = opts.basePx || 460;
    let cellEls = [];

    function buildDOM(onCellClick) {
      boardEl.style.setProperty('--grid-size', size);
      boardEl.style.setProperty('--cell', computeCellPx(size, basePx) + 'px');
      boardEl.innerHTML = '';
      cellEls = [];
      for (let r = 0; r < size; r++) {
        const row = [];
        for (let c = 0; c < size; c++) {
          const cellDiv = document.createElement('div');
          cellDiv.className = 'cell';
          if (onCellClick) cellDiv.addEventListener('click', () => onCellClick(r, c));
          boardEl.appendChild(cellDiv);
          row.push(cellDiv);
        }
        cellEls.push(row);
      }
    }

    function relayout() {
      boardEl.style.setProperty('--cell', computeCellPx(size, basePx) + 'px');
    }

    // `data` is an explicit {owner, dots} — always passed by the caller
    // (either read fresh from a grid, or an animation-step override).
    function renderCell(r, c, data, opts2) {
      opts2 = opts2 || {};
      const cellDiv = cellEls[r][c];
      cellDiv.innerHTML = '';
      cellDiv.classList.remove('clickable');

      if (!data || data.owner === -1 || data.dots <= 0) return;

      const player = players[data.owner];
      const chip = document.createElement('div');
      chip.className = 'chip';
      chip.style.setProperty('--chip-color', player.color);
      chip.style.setProperty('--chip-color-dark', player.dark);

      pipPositionsFor(data.dots).forEach(posClass => {
        const pip = document.createElement('div');
        pip.className = 'pip ' + posClass;
        chip.appendChild(pip);
      });

      if (data.dots === 4) chip.classList.add('will-pop');
      if (opts2.bump) chip.classList.add('bump');
      if (opts2.captured) chip.classList.add('captured');

      cellDiv.appendChild(chip);
      if (opts2.clickable) cellDiv.classList.add('clickable');
    }

    // isClickable(r, c, data) -> bool, called per cell during a full redraw.
    function renderAll(grid, isClickable) {
      for (let r = 0; r < size; r++)
        for (let c = 0; c < size; c++) {
          const data = grid[r][c];
          renderCell(r, c, data, { clickable: isClickable ? isClickable(r, c, data) : false });
        }
    }

    function clearClickable() {
      for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) cellEls[r][c].classList.remove('clickable');
    }

    function spawnRing(r, c, colorHex) {
      const cellDiv = cellEls[r][c];
      const ring = document.createElement('div');
      ring.className = 'ring';
      ring.style.setProperty('--ring-color', colorHex);
      cellDiv.appendChild(ring);
      setTimeout(() => ring.remove(), 480);
    }

    // Replays an engine event log (increment/explode/gain/settle) as
    // animation. `onSettle` fires once per explosion batch, e.g. to
    // refresh a HUD chip-count mid-chain.
    async function playEvents(events, stepDelay, onSettle) {
      for (const ev of events) {
        if (ev.type === 'increment') {
          renderCell(ev.r, ev.c, { owner: ev.owner, dots: ev.dots }, { bump: true });
        } else if (ev.type === 'explode') {
          const chipEl = cellEls[ev.r][ev.c].querySelector('.chip');
          if (chipEl) {
            chipEl.classList.add('exploding');
            await sleep(200);
          }
          renderCell(ev.r, ev.c, { owner: -1, dots: 0 });
          spawnRing(ev.r, ev.c, players[ev.actingPlayer].color);
        } else if (ev.type === 'gain') {
          renderCell(ev.r, ev.c, { owner: ev.owner, dots: ev.dots }, { captured: ev.captured });
        } else if (ev.type === 'settle') {
          if (onSettle) onSettle();
          await sleep(stepDelay);
        }
      }
    }

    function updateHUD(hudEl, grid, current, eliminated, gameOver) {
      if (!hudEl) return;
      const countChips = root.ChipWarsEngine.countChips;
      hudEl.innerHTML = '';
      players.forEach((p, i) => {
        const count = countChips(grid, size, i);
        const card = document.createElement('div');
        card.className =
          'player-card' + (eliminated[i] ? ' eliminated' : i === current && !gameOver ? ' active' : '');
        card.style.setProperty('--player-color', p.color);
        const botTag = p.type === 'bot' ? `<span class="bot-tag">BOT · ${p.difficulty}</span>` : '';
        const you = p.isYou ? ' (You)' : '';
        card.innerHTML = `
          <div class="swatch"></div>
          <div class="player-info">
            <div class="player-name">${p.name}${you} ${botTag}</div>
            <div class="player-count">${eliminated[i] ? 'Out' : 'Chips: <b>' + count + '</b>'}</div>
          </div>`;
        hudEl.appendChild(card);
      });
    }

    function updateStatus(statusEl, current, gameOver, mySeatText) {
      if (!statusEl || gameOver) return;
      const p = players[current];
      statusEl.style.setProperty('--status-color', p.color);
      let who = p.type === 'bot' ? `${p.name} (Bot)` : p.name;
      let suffix = p.type === 'bot' ? ' — thinking...' : mySeatText || ' — click one of your chips';
      statusEl.innerHTML = `<span class="hl">${who}'s</span> turn${suffix}`;
    }

    function finishGame(statusEl, winnerBannerEl, winnerIdx) {
      clearClickable();
      if (statusEl) statusEl.textContent = '';
      if (winnerBannerEl && winnerIdx != null) {
        const p = players[winnerIdx];
        winnerBannerEl.style.setProperty('--winner-color', p.color);
        winnerBannerEl.innerHTML = `🏆 ${p.name} wins the table!`;
        winnerBannerEl.classList.add('show');
      }
    }

    function resetWinnerBanner(winnerBannerEl) {
      if (!winnerBannerEl) return;
      winnerBannerEl.classList.remove('show');
      winnerBannerEl.textContent = '';
    }

    return {
      buildDOM,
      relayout,
      renderCell,
      renderAll,
      clearClickable,
      playEvents,
      updateHUD,
      updateStatus,
      finishGame,
      resetWinnerBanner,
    };
  }

  root.ChipWarsRenderer = { PALETTE, sleep, pipPositionsFor, computeCellPx, createBoardRenderer };
})(typeof globalThis !== 'undefined' ? globalThis : this);
