/*
 * Snowball Siege — Simulation
 * ------------------------------
 * Pure turn-based physics: gravity-arced throws, terrain collision, and
 * segmented player hitboxes (head/body/legs). No canvas, no DOM, no
 * input — the caller (local game loop, or the server for online play)
 * calls throwSnowball(angle, power) on behalf of the current player and
 * gets back a result with a sampled trajectory (for animation) plus the
 * outcome. Same event-returning shape as engine.js/sim.js so all three
 * games share one architectural pattern.
 */

(function (root) {
  'use strict';

  // World space matches maps.js's viewBox exactly (100 wide, 70 tall),
  // so terrain data needs no rescaling between the setup preview and
  // actual gameplay.
  const WORLD_W = 100;
  const WORLD_H = 70;
  // Max range at 45°/full power is MAX_SPEED^2 / GRAVITY ≈ 139 world
  // units — comfortably more than the ~92-unit worst-case distance
  // between two players on any map, so no match can end up with an
  // opponent that's physically out of throwing range.
  const GRAVITY = 65;
  const MAX_SPEED = 95;
  const MAX_FLIGHT_TIME = 6; // safety cap, seconds
  const STEP = 1 / 60;

  // Hit-zone heights, measured upward from the ground the player stands on.
  const LEG_H = 3;
  const BODY_H = 8;
  const HEAD_H = 12;
  const HITBOX_HALF_W = 3;

  const START_HEALTH = 100;
  const DAMAGE = { head: 45, body: 25, legs: 12 };

  function terrainHeightAt(map, x) {
    const pts = map.points;
    const cx = Math.max(0, Math.min(WORLD_W, x));
    for (let i = 0; i < pts.length - 1; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[i + 1];
      if (cx >= x1 && cx <= x2) {
        const t = x2 === x1 ? 0 : (cx - x1) / (x2 - x1);
        return y1 + (y2 - y1) * t;
      }
    }
    return pts[pts.length - 1][1];
  }

  class SnowballSim {
    // players: [{ name }, ...] in seat order. spawnXs: matching x
    // positions (already randomized/assigned by maps.assignSpawns).
    constructor(map, players, spawnXs) {
      this.map = map;
      this.players = players.map((p, i) => ({
        name: p.name,
        x: spawnXs[i],
        health: START_HEALTH,
        eliminated: false,
      }));
      this.turn = 0;
      this.gameOver = false;
      this.winner = null;
    }

    groundY(x) { return terrainHeightAt(this.map, x); }

    activeIndices() {
      return this.players.map((p, i) => i).filter(i => !this.players[i].eliminated);
    }

    isValidThrow(playerIndex) {
      return !this.gameOver && playerIndex === this.turn && this.players[playerIndex] && !this.players[playerIndex].eliminated;
    }

    // Removes a player mid-match (used when they disconnect online).
    // Never called for local play.
    eliminatePlayer(index) {
      const p = this.players[index];
      if (!p || p.eliminated) return;
      p.eliminated = true;
      p.health = 0;
      this._checkWin();
      if (!this.gameOver && this.turn === index) this._advanceTurn();
    }

    _checkWin() {
      const remaining = this.activeIndices();
      if (remaining.length <= 1) {
        this.gameOver = true;
        this.winner = remaining.length === 1 ? remaining[0] : null;
      }
    }

    _advanceTurn() {
      for (let step = 0; step < this.players.length; step++) {
        this.turn = (this.turn + 1) % this.players.length;
        if (!this.players[this.turn].eliminated) return;
      }
    }

    // angle: radians (0 = +x/right, negative y = up, matching a normal
    // screen-space direction vector). power: 0..1.
    throwSnowball(playerIndex, angle, power) {
      if (!this.isValidThrow(playerIndex)) return null;
      const thrower = this.players[playerIndex];
      const p = Math.max(0, Math.min(1, power));
      const speed = MAX_SPEED * (0.35 + 0.65 * p); // even a light flick still travels somewhere

      const throwerGroundY = this.groundY(thrower.x);
      let x = thrower.x;
      let y = throwerGroundY - BODY_H; // launch from roughly chest height
      let vx = Math.cos(angle) * speed;
      let vy = Math.sin(angle) * speed;

      const trajectory = [{ x, y }];
      let outcome = { type: 'miss' };
      let t = 0;

      while (t < MAX_FLIGHT_TIME) {
        vy += GRAVITY * STEP;
        x += vx * STEP;
        y += vy * STEP;
        t += STEP;
        trajectory.push({ x, y });

        if (x < -5 || x > WORLD_W + 5) { outcome = { type: 'miss' }; break; }

        // Player collisions (skip the thrower and anyone already out).
        let hit = null;
        for (let i = 0; i < this.players.length; i++) {
          if (i === playerIndex) continue;
          const target = this.players[i];
          if (target.eliminated) continue;
          if (Math.abs(x - target.x) > HITBOX_HALF_W) continue;
          const gy = this.groundY(target.x);
          const relHeight = gy - y; // how far above ground the ball is at this target's position
          if (relHeight >= 0 && relHeight <= LEG_H) { hit = { i, zone: 'legs' }; break; }
          if (relHeight > LEG_H && relHeight <= BODY_H) { hit = { i, zone: 'body' }; break; }
          if (relHeight > BODY_H && relHeight <= HEAD_H) { hit = { i, zone: 'head' }; break; }
        }
        if (hit) {
          outcome = { type: 'hit', targetIndex: hit.i, zone: hit.zone, damage: DAMAGE[hit.zone] };
          break;
        }

        // Terrain collision.
        const ground = this.groundY(x);
        if (y >= ground) { outcome = { type: 'terrain' }; break; }
      }

      let damageApplied = 0;
      if (outcome.type === 'hit') {
        const target = this.players[outcome.targetIndex];
        damageApplied = Math.min(outcome.damage, target.health);
        target.health -= damageApplied;
        if (target.health <= 0) {
          target.health = 0;
          target.eliminated = true;
        }
      }

      this._checkWin();
      if (!this.gameOver) this._advanceTurn();

      return {
        trajectory,
        outcome: { ...outcome, damage: damageApplied || undefined },
        players: this.players.map(p => ({ name: p.name, x: p.x, health: p.health, eliminated: p.eliminated })),
        turn: this.turn,
        gameOver: this.gameOver,
        winner: this.winner,
      };
    }

    getState() {
      return {
        players: this.players.map(p => ({ name: p.name, x: p.x, health: p.health, eliminated: p.eliminated })),
        turn: this.turn,
        gameOver: this.gameOver,
        winner: this.winner,
      };
    }
  }

  const SnowballSimModule = {
    SnowballSim,
    terrainHeightAt,
    geometry: { WORLD_W, WORLD_H, GRAVITY, MAX_SPEED, LEG_H, BODY_H, HEAD_H, HITBOX_HALF_W, START_HEALTH },
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = SnowballSimModule;
  }
  root.SnowballSim = SnowballSimModule;
})(typeof globalThis !== 'undefined' ? globalThis : this);
