/*
 * Star Bounce — Simulation
 * -------------------------
 * Pure game logic: ball physics, paddle movement, bot AI, lives and win
 * detection. No canvas, no DOM, no timers of its own — the caller drives
 * it by calling step(dt) repeatedly (a local requestAnimationFrame loop
 * for offline play, or a setInterval tick loop on the server for online
 * play). Both call the exact same code, so the server can be fully
 * authoritative for online matches.
 */

(function (root) {
  'use strict';

  // Fixed logical coordinate space — every match simulates in this same
  // 520x520 space regardless of how big the canvas is drawn on screen,
  // so local and networked play (and the home-screen preview) all share
  // identical geometry with no scaling math to keep in sync.
  const SIZE = 520;
  const MARGIN = 70;
  const ARENA_MIN = MARGIN;
  const ARENA_MAX = SIZE - MARGIN;
  const CENTER = SIZE / 2;
  const CORNER_SAFE = 16; // small always-bounce zone right at each corner
  const PADDLE_HALF = 35;
  const PADDLE_THICK = 16;
  const BALL_R = 7;
  const CANNON_RX = 16;
  const CANNON_RY = 12;
  const START_LIVES = 5;
  const PADDLE_SPEED = 150; // logical px/sec — deliberately unhurried

  const END_LOW = ARENA_MIN + CORNER_SAFE + PADDLE_HALF;
  const END_HIGH = ARENA_MAX - CORNER_SAFE - PADDLE_HALF;
  const MID = (ARENA_MIN + ARENA_MAX) / 2;

  const SIDES = ['top', 'right', 'bottom', 'left'];
  const SIDES_FOR_COUNT = {
    2: ['top', 'bottom'],
    3: ['top', 'right', 'bottom'],
    4: ['top', 'right', 'bottom', 'left'],
  };

  const CORNER_POS = {
    tl: { x: ARENA_MIN, y: ARENA_MIN },
    tr: { x: ARENA_MAX, y: ARENA_MIN },
    br: { x: ARENA_MAX, y: ARENA_MAX },
    bl: { x: ARENA_MIN, y: ARENA_MAX },
  };

  function isXAxisSide(key) { return key === 'top' || key === 'bottom'; }

  const BOT_TUNING = {
    easy: { interval: 0.9, error: 0.45 },
    medium: { interval: 0.45, error: 0.18 },
    hard: { interval: 0.2, error: 0.05 },
  };

  class StarBounceSim {
    // playersBySide: {top,right,bottom,left}, each null (permanent wall)
    // or {type:'human'|'bot', difficulty, name}.
    constructor(playersBySide) {
      this.playersBySide = playersBySide;
      this.reset();
    }

    reset() {
      this.sides = {};
      SIDES.forEach(key => {
        this.sides[key] = {
          key,
          player: this.playersBySide[key],
          eliminated: false,
          lives: START_LIVES,
          pos: MID,
          dir: 0, // -1, 0, or 1 — 0 means "hasn't moved yet, resting at center"
          botTimer: 0,
          flashUntil: 0,
          botOverride: false,
          botOverrideDifficulty: 'medium',
        };
      });
      this.balls = [];
      this.elapsed = 0;
      this.spawnTimer = 1.4; // first ball arrives a little faster than later ones
      this.gameOver = false;
      this.winnerSide = null;
    }

    activeSideKeys() {
      return SIDES.filter(k => this.sides[k].player);
    }

    // A click/tap: reverses the paddle's current direction, or (if it
    // hasn't moved yet) starts it moving. Spamming this rapidly means
    // the paddle only travels a little each time before reversing again
    // — which is what keeps it effectively parked near the center.
    toggle(sideKey) {
      const s = this.sides[sideKey];
      if (!s || !s.player || s.eliminated || this.gameOver) return;
      s.dir = s.dir === 0 ? -1 : -s.dir;
    }

    spawnBall() {
      const corners = Object.values(CORNER_POS);
      const c = corners[Math.floor(Math.random() * corners.length)];
      const baseAngle = Math.atan2(CENTER - c.y, CENTER - c.x);
      const jitter = (Math.random() - 0.5) * (Math.PI / 4.5);
      const angle = baseAngle + jitter;
      const speed = 150 + Math.min(this.elapsed * 3.2, 150);
      this.balls.push({
        x: c.x + Math.cos(angle) * (CANNON_RX + BALL_R + 2),
        y: c.y + Math.sin(angle) * (CANNON_RY + BALL_R + 2),
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
      });
    }

    loseLife(sideKey) {
      const s = this.sides[sideKey];
      if (s.eliminated) return;
      s.lives -= 1;
      s.flashUntil = this.elapsed + 0.35;
      if (s.lives <= 0) {
        s.eliminated = true;
        this._checkWin();
      }
    }

    _checkWin() {
      const active = this.activeSideKeys();
      const remaining = active.filter(k => !this.sides[k].eliminated);
      if (remaining.length <= 1) {
        this.gameOver = true;
        this.winnerSide = remaining[0] || null;
      }
    }

    _handleAxisHit(ball, sideKey, axisPos, wallCoord, isXAxis) {
      const s = this.sides[sideKey];
      const inCorner = axisPos < ARENA_MIN + CORNER_SAFE || axisPos > ARENA_MAX - CORNER_SAFE;
      const solidWall = inCorner || !s.player || s.eliminated;

      if (solidWall) {
        if (isXAxis) { ball.x = wallCoord; ball.vx = -ball.vx; }
        else { ball.y = wallCoord; ball.vy = -ball.vy; }
        return true;
      }

      if (Math.abs(axisPos - s.pos) <= PADDLE_HALF) {
        const offset = (axisPos - s.pos) / PADDLE_HALF;
        if (isXAxis) {
          ball.x = wallCoord;
          ball.vx = -ball.vx * 1.03;
          ball.vy += offset * 60;
        } else {
          ball.y = wallCoord;
          ball.vy = -ball.vy * 1.03;
          ball.vx += offset * 60;
        }
        s.flashUntil = this.elapsed + 0.15;
        return true;
      }

      this.loseLife(sideKey);
      return false;
    }

    _stepBall(ball, dt) {
      ball.x += ball.vx * dt;
      ball.y += ball.vy * dt;

      if (ball.vx < 0 && ball.x - BALL_R <= ARENA_MIN) {
        if (!this._handleAxisHit(ball, 'left', ball.y, ARENA_MIN + BALL_R, true)) return false;
      } else if (ball.vx > 0 && ball.x + BALL_R >= ARENA_MAX) {
        if (!this._handleAxisHit(ball, 'right', ball.y, ARENA_MAX - BALL_R, true)) return false;
      }

      if (ball.vy < 0 && ball.y - BALL_R <= ARENA_MIN) {
        if (!this._handleAxisHit(ball, 'top', ball.x, ARENA_MIN + BALL_R, false)) return false;
      } else if (ball.vy > 0 && ball.y + BALL_R >= ARENA_MAX) {
        if (!this._handleAxisHit(ball, 'bottom', ball.x, ARENA_MAX - BALL_R, false)) return false;
      }

      return true;
    }

    _predictAxisForSide(key) {
      const isX = isXAxisSide(key);
      const approaching = this.balls.filter(b => {
        if (key === 'left') return b.vx < 0;
        if (key === 'right') return b.vx > 0;
        if (key === 'top') return b.vy < 0;
        return b.vy > 0;
      });
      if (approaching.length === 0) return null;

      let best = null, bestT = Infinity;
      approaching.forEach(b => {
        let t;
        if (key === 'left') t = (ARENA_MIN - b.x) / b.vx;
        else if (key === 'right') t = (ARENA_MAX - b.x) / b.vx;
        else if (key === 'top') t = (ARENA_MIN - b.y) / b.vy;
        else t = (ARENA_MAX - b.y) / b.vy;
        if (t > 0 && t < bestT) {
          bestT = t;
          best = isX ? b.y + b.vy * t : b.x + b.vx * t;
        }
      });
      return best;
    }

    // Lets a server-hosted room temporarily bot-pilot a human seat while
    // its player is disconnected, without touching the real slot config
    // (so control hands back cleanly if they reconnect).
    setBotOverride(sideKey, on, difficulty) {
      const s = this.sides[sideKey];
      if (!s) return;
      s.botOverride = on;
      s.botOverrideDifficulty = difficulty || 'medium';
    }

    _updateBot(key, dt) {
      const s = this.sides[key];
      if (!s.player || s.eliminated) return;
      const isBot = s.player.type === 'bot' || s.botOverride;
      if (!isBot) return;
      s.botTimer -= dt;
      if (s.botTimer > 0) return;
      const difficulty = s.player.type === 'bot' ? s.player.difficulty : s.botOverrideDifficulty;
      const tuning = BOT_TUNING[difficulty || 'medium'];
      s.botTimer = tuning.interval;

      const predicted = this._predictAxisForSide(key);
      let wantLeft;
      if (predicted == null) {
        wantLeft = Math.random() < 0.5;
      } else {
        wantLeft = Math.abs(predicted - END_LOW) < Math.abs(predicted - END_HIGH);
      }
      if (Math.random() < tuning.error) wantLeft = !wantLeft;

      const desiredDir = wantLeft ? -1 : 1;
      if (s.dir !== desiredDir) this.toggle(key);
    }

    step(dt) {
      if (this.gameOver) return;
      this.elapsed += dt;
      this.spawnTimer -= dt;
      const interval = Math.max(0.9, 2.6 - this.elapsed * 0.025);
      if (this.spawnTimer <= 0) {
        this.spawnBall();
        this.spawnTimer = interval;
      }

      SIDES.forEach(key => {
        const s = this.sides[key];
        if (!s.player) return;
        if (s.dir !== 0) {
          s.pos += s.dir * PADDLE_SPEED * dt;
          s.pos = Math.max(END_LOW, Math.min(END_HIGH, s.pos));
        }
        this._updateBot(key, dt);
      });

      this.balls = this.balls.filter(b => this._stepBall(b, dt));
    }

    // Lightweight JSON-serializable snapshot for broadcasting over the
    // network. Balls only need position — the receiving client doesn't
    // simulate, just draws whatever it's told.
    getSnapshot() {
      const sides = {};
      SIDES.forEach(key => {
        const s = this.sides[key];
        sides[key] = { pos: s.pos, dir: s.dir, lives: s.lives, eliminated: s.eliminated, flashUntil: s.flashUntil, botOverride: s.botOverride };
      });
      return {
        sides,
        balls: this.balls.map(b => ({ x: b.x, y: b.y })),
        elapsed: this.elapsed,
        gameOver: this.gameOver,
        winnerSide: this.winnerSide,
      };
    }
  }

  const StarBounceSimModule = {
    StarBounceSim,
    SIDES,
    SIDES_FOR_COUNT,
    CORNER_POS,
    geometry: { SIZE, MARGIN, ARENA_MIN, ARENA_MAX, CENTER, CORNER_SAFE, PADDLE_HALF, PADDLE_THICK, BALL_R, CANNON_RX, CANNON_RY, END_LOW, END_HIGH, MID },
    isXAxisSide,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = StarBounceSimModule;
  }
  root.StarBounceSim = StarBounceSimModule;
})(typeof globalThis !== 'undefined' ? globalThis : this);
