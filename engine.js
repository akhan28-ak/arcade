/*
 * Chip Wars — Game Engine
 * ------------------------
 * Pure game logic. No DOM access, no timers, no colors, no rendering.
 * Everything here could run in Node, a test suite, or a server —
 * it only knows about a grid of {owner, dots} cells and turn order.
 *
 * The UI layer drives the engine by calling applyMove(r, c), which
 * mutates internal state and returns an ordered list of "events"
 * describing exactly what happened. The UI replays those events to
 * animate the board; the engine itself never waits or animates.
 */

(function (root) {
  'use strict';

  const MAX_DOTS = 4;

  // ---- Pure helpers -------------------------------------------------

  function neighborsOf(size, r, c) {
    const list = [];
    if (r > 0) list.push({ r: r - 1, c });
    if (r < size - 1) list.push({ r: r + 1, c });
    if (c > 0) list.push({ r, c: c - 1 });
    if (c < size - 1) list.push({ r, c: c + 1 });
    return list;
  }

  // One square in from each of up to 4 board corners, in a fixed order
  // (top-left, top-right, bottom-left, bottom-right). Only the first
  // `count` corners are used, so a 2-player game starts opposite corners
  // first, matching how the slot list is presented in the UI.
  function cornersFor(size, count) {
    const all = [
      { r: 1, c: 1 },
      { r: 1, c: size - 2 },
      { r: size - 2, c: 1 },
      { r: size - 2, c: size - 2 },
    ];
    return all.slice(0, count);
  }

  function cloneGrid(grid) {
    return grid.map(row => row.map(cell => ({ owner: cell.owner, dots: cell.dots })));
  }

  function emptyGrid(size) {
    const grid = [];
    for (let r = 0; r < size; r++) {
      const row = [];
      for (let c = 0; c < size; c++) row.push({ owner: -1, dots: 0 });
      grid.push(row);
    }
    return grid;
  }

  // Resolve a move (increment + any chain of explosions) against a given
  // grid, purely. Does not touch turn order, elimination, or any other
  // engine state — used both by GameEngine.applyMove internally and by
  // the bot AI to look ahead without side effects.
  function resolveMove(gridIn, size, r, c, actingPlayer) {
    const grid = cloneGrid(gridIn);
    const events = [];

    const cell = grid[r][c];
    cell.dots += 1;
    events.push({ type: 'increment', r, c, dots: cell.dots, owner: actingPlayer });

    let queue = [];
    if (cell.dots >= MAX_DOTS) queue.push({ r, c });
    const queued = new Set();

    while (queue.length) {
      const next = queue.shift();
      const nd = grid[next.r][next.c];
      if (nd.dots < MAX_DOTS) continue;

      events.push({ type: 'explode', r: next.r, c: next.c, actingPlayer });
      nd.dots = 0;
      nd.owner = -1;

      const neigh = neighborsOf(size, next.r, next.c);
      for (const n of neigh) {
        const cd = grid[n.r][n.c];
        const captured = cd.owner !== -1 && cd.owner !== actingPlayer;
        cd.owner = actingPlayer;
        cd.dots += 1;
        events.push({ type: 'gain', r: n.r, c: n.c, dots: cd.dots, owner: actingPlayer, captured });

        if (cd.dots >= MAX_DOTS) {
          const k = n.r + ',' + n.c;
          if (!queued.has(k)) {
            queued.add(k);
            queue.push(n);
          }
        }
      }

      events.push({ type: 'settle' });
    }

    return { grid, events };
  }

  function countChips(grid, size, playerIdx) {
    let n = 0;
    for (let r = 0; r < size; r++)
      for (let c = 0; c < size; c++)
        if (grid[r][c].owner === playerIdx && grid[r][c].dots > 0) n++;
    return n;
  }

  // ---- Bot AI ---------------------------------------------------------
  // Difficulty levels:
  //   easy   - picks a random legal move
  //   medium - simulates every legal move, scores by captures + net board control
  //   hard   - same as medium, plus a penalty for leaving 3-dot chips exposed
  //            next to 2+ enemy-owned neighbors (avoids reckless setups)

  function chooseBotMove(grid, size, playerIdx, playerCount, difficulty) {
    const candidates = [];
    for (let r = 0; r < size; r++)
      for (let c = 0; c < size; c++)
        if (grid[r][c].owner === playerIdx && grid[r][c].dots > 0) candidates.push({ r, c });

    if (candidates.length === 0) return null;
    if (difficulty === 'easy') {
      return candidates[Math.floor(Math.random() * candidates.length)];
    }

    const scored = candidates.map(mv => {
      const { grid: ng } = resolveMove(grid, size, mv.r, mv.c, playerIdx);
      const captured = countCaptures(grid, ng, size, playerIdx);

      const counts = new Array(playerCount).fill(0);
      for (let r = 0; r < size; r++)
        for (let c = 0; c < size; c++) {
          const cell = ng[r][c];
          if (cell.owner >= 0 && cell.dots > 0) counts[cell.owner]++;
        }
      const myCount = counts[playerIdx];
      let maxOther = 0;
      for (let i = 0; i < playerCount; i++) if (i !== playerIdx) maxOther = Math.max(maxOther, counts[i]);

      let vulnerability = 0;
      if (difficulty === 'hard') {
        for (let r = 0; r < size; r++)
          for (let c = 0; c < size; c++) {
            const cell = ng[r][c];
            if (cell.owner === playerIdx && cell.dots === 3) {
              let enemyAdj = 0;
              neighborsOf(size, r, c).forEach(n => {
                const nc = ng[n.r][n.c];
                if (nc.owner !== -1 && nc.owner !== playerIdx) enemyAdj++;
              });
              if (enemyAdj >= 2) vulnerability++;
            }
          }
      }

      const score = captured * 3 + (myCount - maxOther) - vulnerability * 2 + Math.random() * 0.6;
      return { mv, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored[0].mv;
  }

  function countCaptures(beforeGrid, afterGrid, size, playerIdx) {
    let n = 0;
    for (let r = 0; r < size; r++)
      for (let c = 0; c < size; c++) {
        const before = beforeGrid[r][c];
        const after = afterGrid[r][c];
        if (after.owner === playerIdx && before.owner !== -1 && before.owner !== playerIdx) n++;
      }
    return n;
  }

  // ---- GameEngine -----------------------------------------------------

  class GameEngine {
    constructor(size, playerCount) {
      this.size = size;
      this.playerCount = playerCount;
      this.reset();
    }

    reset() {
      this.grid = emptyGrid(this.size);
      const corners = cornersFor(this.size, this.playerCount);
      corners.forEach((pos, i) => {
        this.grid[pos.r][pos.c] = { owner: i, dots: 3 };
      });

      this.current = 0;
      this.eliminated = new Array(this.playerCount).fill(false);
      this.hasMoved = new Array(this.playerCount).fill(false);
      this.gameOver = false;
      this.winner = null;
    }

    cell(r, c) {
      return this.grid[r][c];
    }

    countChips(playerIdx) {
      return countChips(this.grid, this.size, playerIdx);
    }

    isValidMove(r, c) {
      if (this.gameOver) return false;
      const cell = this.grid[r][c];
      return cell.owner === this.current && cell.dots > 0;
    }

    // Applies a move for the current player. Returns null if illegal.
    // Otherwise mutates internal state to the fully-resolved result and
    // returns { events, eliminated, gameOver, winner, current } describing
    // the outcome, for the UI to replay/animate and then reflect.
    applyMove(r, c) {
      if (!this.isValidMove(r, c)) return null;

      const actingPlayer = this.current;
      this.hasMoved[actingPlayer] = true;

      const { grid: newGrid, events } = resolveMove(this.grid, this.size, r, c, actingPlayer);
      this.grid = newGrid;

      let winner = null;
      if (this.playerCount >= 2) {
        this._checkEliminations();
        const remaining = [];
        for (let i = 0; i < this.playerCount; i++) if (!this.eliminated[i]) remaining.push(i);
        if (remaining.length <= 1) {
          winner = remaining[0];
          this.gameOver = true;
          this.winner = winner;
        }
      }

      if (!this.gameOver) this._advanceTurn();

      return {
        events,
        eliminated: this.eliminated.slice(),
        gameOver: this.gameOver,
        winner,
        current: this.current,
      };
    }

    chooseBotMove(playerIdx, difficulty) {
      return chooseBotMove(this.grid, this.size, playerIdx, this.playerCount, difficulty || 'medium');
    }

    _checkEliminations() {
      for (let i = 0; i < this.playerCount; i++) {
        if (this.eliminated[i]) continue;
        if (this.hasMoved[i] && this.countChips(i) === 0) this.eliminated[i] = true;
      }
    }

    _advanceTurn() {
      let next = this.current;
      for (let step = 0; step < this.playerCount; step++) {
        next = (next + 1) % this.playerCount;
        if (!this.eliminated[next]) {
          this.current = next;
          return;
        }
      }
    }
  }

  const ChipWarsEngine = {
    GameEngine,
    neighborsOf,
    cornersFor,
    resolveMove,
    countChips,
  };

  if (typeof module !== 'undefined' && module.exports) {
    // Node / CommonJS (e.g. the Socket.IO server) — require('./engine.js')
    module.exports = ChipWarsEngine;
  }
  // Browser — <script src="engine.js"></script> still sets window.ChipWarsEngine
  root.ChipWarsEngine = ChipWarsEngine;
})(typeof globalThis !== 'undefined' ? globalThis : this);
