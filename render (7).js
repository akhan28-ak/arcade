/*
 * Star Bounce — Renderer
 * ------------------------
 * Pure drawing: takes a canvas 2D context and a snapshot (either from a
 * local StarBounceSim or a server broadcast) and draws it. Doesn't know
 * or care where the snapshot came from — this is what lets local play,
 * the home-screen preview, and networked play all share one renderer.
 */

(function (root) {
  'use strict';

  const G = root.StarBounceSim.geometry;
  const CORNER_POS = root.StarBounceSim.CORNER_POS;
  const SIDES = root.StarBounceSim.SIDES;
  const isXAxisSide = root.StarBounceSim.isXAxisSide;

  const SIDE_LABEL = { top: 'Top', right: 'Right', bottom: 'Bottom', left: 'Left' };
  const SIDE_COLOR = { top: '#e6435b', right: '#2f7cf6', bottom: '#f2b705', left: '#9b5de5' };
  const SIDE_COLOR_DARK = { top: '#a11e33', right: '#1a4fb0', bottom: '#b3860a', left: '#6425a8' };

  function drawCannon(ctx, pos, dirToCenter) {
    ctx.save();
    ctx.translate(pos.x, pos.y);
    ctx.rotate(dirToCenter);
    const grad = ctx.createLinearGradient(-G.CANNON_RX, 0, G.CANNON_RX, 0);
    grad.addColorStop(0, '#5a6070');
    grad.addColorStop(0.5, '#c9d3e0');
    grad.addColorStop(1, '#4a5060');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.ellipse(0, 0, G.CANNON_RX, G.CANNON_RY, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#0a0e1f';
    ctx.beginPath();
    ctx.ellipse(G.CANNON_RX * 0.35, 0, G.CANNON_RX * 0.42, G.CANNON_RY * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawSide(ctx, key, sideSnap, hasPlayer, elapsed) {
    const isX = isXAxisSide(key);
    const solid = !hasPlayer || sideSnap.eliminated;
    const color = hasPlayer ? SIDE_COLOR[key] : '#3a4152';

    let x1, y1, x2, y2;
    if (key === 'top') { x1 = G.ARENA_MIN; y1 = G.ARENA_MIN; x2 = G.ARENA_MAX; y2 = G.ARENA_MIN; }
    else if (key === 'bottom') { x1 = G.ARENA_MIN; y1 = G.ARENA_MAX; x2 = G.ARENA_MAX; y2 = G.ARENA_MAX; }
    else if (key === 'left') { x1 = G.ARENA_MIN; y1 = G.ARENA_MIN; x2 = G.ARENA_MIN; y2 = G.ARENA_MAX; }
    else { x1 = G.ARENA_MAX; y1 = G.ARENA_MIN; x2 = G.ARENA_MAX; y2 = G.ARENA_MAX; }

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = solid ? 3 : 2.5;
    if (!solid) { ctx.shadowColor = color; ctx.shadowBlur = 10; }
    if (solid) ctx.setLineDash([6, 5]);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.restore();

    if (!hasPlayer) return;

    const flashing = elapsed < sideSnap.flashUntil;
    ctx.save();
    ctx.fillStyle = sideSnap.eliminated ? '#3a4152' : (flashing ? '#ffffff' : color);
    ctx.shadowColor = color;
    ctx.shadowBlur = sideSnap.eliminated ? 0 : 12;
    ctx.beginPath();
    if (isX) {
      ctx.ellipse(sideSnap.pos, key === 'top' ? G.ARENA_MIN : G.ARENA_MAX, G.PADDLE_HALF, G.PADDLE_THICK / 2, 0, 0, Math.PI * 2);
    } else {
      ctx.ellipse(key === 'left' ? G.ARENA_MIN : G.ARENA_MAX, sideSnap.pos, G.PADDLE_THICK / 2, G.PADDLE_HALF, 0, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.restore();
  }

  // canvasPixelSize: the actual width/height the <canvas> element was
  // created with (may differ from the fixed 520 logical space — the
  // preview uses a smaller canvas, for instance). We scale once so all
  // the drawing math above can stay in logical coordinates.
  function drawFrame(ctx, canvasPixelSize, snapshot, playersBySide) {
    const scale = canvasPixelSize / G.SIZE;
    ctx.save();
    ctx.clearRect(0, 0, canvasPixelSize, canvasPixelSize);
    ctx.scale(scale, scale);

    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.strokeRect(G.ARENA_MIN, G.ARENA_MIN, G.ARENA_MAX - G.ARENA_MIN, G.ARENA_MAX - G.ARENA_MIN);
    ctx.restore();

    SIDES.forEach(key => drawSide(ctx, key, snapshot.sides[key], !!playersBySide[key], snapshot.elapsed));

    Object.values(CORNER_POS).forEach(pos => {
      const dir = Math.atan2(G.CENTER - pos.y, G.CENTER - pos.x);
      drawCannon(ctx, pos, dir);
    });

    snapshot.balls.forEach(b => {
      ctx.save();
      ctx.fillStyle = '#fff8e6';
      ctx.shadowColor = '#ffd97a';
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(b.x, b.y, G.BALL_R, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });

    ctx.restore();
  }

  root.StarBounceRender = { drawFrame, SIDE_LABEL, SIDE_COLOR, SIDE_COLOR_DARK };
})(typeof globalThis !== 'undefined' ? globalThis : this);
