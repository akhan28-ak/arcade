/*
 * Snowball Siege — Renderer
 * ----------------------------
 * Pure drawing given a camera + world state. Doesn't know about turns,
 * input, or networking — game.js/net.js hand it whatever's currently
 * true (map, player positions/health, an optional mid-flight ball, an
 * optional live drag preview) and it draws one frame.
 */

(function (root) {
  'use strict';

  const G = root.SnowballSim.geometry;
  const PALETTE_COLORS = ['#e6435b', '#2f7cf6', '#f2b705', '#9b5de5'];

  function hillPathD(map) {
    const pts = map.points.map(p => p.join(',')).join(' L');
    return `M0,${G.WORLD_H} L${pts} L${G.WORLD_W},${G.WORLD_H} Z`;
  }

  function createRenderer(canvas) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;

    function worldToScreen(camera, wx, wy) {
      const scale = (W / G.WORLD_W) * camera.zoom;
      return { x: W / 2 + (wx - camera.x) * scale, y: H / 2 + (wy - camera.y) * scale, scale };
    }

    function drawSky() {
      const grad = ctx.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, '#bcdff5');
      grad.addColorStop(1, '#f0f8fc');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
    }

    function drawTerrain(camera, map) {
      const scale = (W / G.WORLD_W) * camera.zoom;
      ctx.save();
      ctx.translate(W / 2 - camera.x * scale, H / 2 - camera.y * scale);
      ctx.scale(scale, scale);
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#c3d8e8';
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      const d = new Path2D(hillPathD(map));
      ctx.fill(d);
      ctx.stroke(d);
      ctx.restore();
    }

    // pose: 'idle' | { armAngle } while aiming (arm points opposite the throw direction)
    function drawStickman(camera, x, groundY, color, pose, facing) {
      const s = worldToScreen(camera, x, groundY);
      const scale = s.scale;
      const headR = 2.2 * scale;
      const bodyTop = s.y - G.BODY_H * scale;
      const bodyBottom = s.y - G.LEG_H * scale;
      const headCenterY = bodyTop - headR - 0.3 * scale;

      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1.5, 0.6 * scale);
      ctx.lineCap = 'round';

      // head
      ctx.beginPath();
      ctx.arc(s.x, headCenterY, headR, 0, Math.PI * 2);
      ctx.stroke();

      // body
      ctx.beginPath();
      ctx.moveTo(s.x, headCenterY + headR);
      ctx.lineTo(s.x, bodyBottom);
      ctx.stroke();

      // legs
      ctx.beginPath();
      ctx.moveTo(s.x, bodyBottom);
      ctx.lineTo(s.x - 2.2 * scale, s.y);
      ctx.moveTo(s.x, bodyBottom);
      ctx.lineTo(s.x + 2.2 * scale, s.y);
      ctx.stroke();

      // arms — idle both slightly down, or one pulled back aiming
      const armY = bodyTop + 1.2 * scale;
      if (pose && pose.armAngle != null) {
        const len = 3 * scale;
        ctx.beginPath();
        ctx.moveTo(s.x, armY);
        ctx.lineTo(s.x + Math.cos(pose.armAngle) * len, armY + Math.sin(pose.armAngle) * len);
        ctx.stroke();
        // other arm stays relaxed
        ctx.beginPath();
        ctx.moveTo(s.x, armY);
        ctx.lineTo(s.x - 2 * scale * facing, armY + 2.2 * scale);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.moveTo(s.x, armY);
        ctx.lineTo(s.x - 2 * scale, armY + 2.2 * scale);
        ctx.moveTo(s.x, armY);
        ctx.lineTo(s.x + 2 * scale, armY + 2.2 * scale);
        ctx.stroke();
      }
      ctx.restore();

      return { screenX: s.x, screenY: headCenterY - headR, scale };
    }

    function drawBall(camera, x, y) {
      const s = worldToScreen(camera, x, y);
      ctx.save();
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#9fb8cc';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(s.x, s.y, Math.max(2.5, 0.9 * s.scale), 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    function drawTrajectoryPreview(camera, points) {
      ctx.save();
      ctx.fillStyle = 'rgba(60,80,100,0.55)';
      points.forEach((pt, i) => {
        if (i % 2 !== 0) return; // dotted look
        const s = worldToScreen(camera, pt.x, pt.y);
        ctx.beginPath();
        ctx.arc(s.x, s.y, 1.6, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.restore();
    }

    function drawPowerIndicator(screenX, screenY, frac) {
      const width = 46, height = 7;
      const x = screenX - width / 2, y = screenY - 16;
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(x, y, width, height);
      ctx.fillStyle = frac > 0.75 ? '#ff5a5a' : frac > 0.4 ? '#ffd45a' : '#8ce07a';
      ctx.fillRect(x, y, width * frac, height);
      ctx.strokeStyle = 'rgba(0,0,0,0.4)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x, y, width, height);
      ctx.restore();
    }

    // Returns arrow descriptors for players currently outside the camera's
    // visible world-x range, so game.js/net.js can also use the data for
    // hit-testing etc if needed later.
    function offscreenArrows(camera, players, activeIndex) {
      const halfWorldVisible = (G.WORLD_W / 2) / camera.zoom;
      const leftEdge = camera.x - halfWorldVisible;
      const rightEdge = camera.x + halfWorldVisible;
      const arrows = [];
      players.forEach((p, i) => {
        if (i === activeIndex || p.eliminated) return;
        if (p.x < leftEdge) arrows.push({ side: 'left', color: PALETTE_COLORS[i], index: i });
        else if (p.x > rightEdge) arrows.push({ side: 'right', color: PALETTE_COLORS[i], index: i });
      });
      return arrows;
    }

    function drawOffscreenArrows(arrows) {
      const byLeft = arrows.filter(a => a.side === 'left');
      const byRight = arrows.filter(a => a.side === 'right');
      byLeft.forEach((a, i) => drawArrow(14, H / 2 + i * 26, 'left', a.color));
      byRight.forEach((a, i) => drawArrow(W - 14, H / 2 + i * 26, 'right', a.color));
    }

    function drawArrow(x, y, side, color) {
      ctx.save();
      ctx.fillStyle = color;
      ctx.beginPath();
      if (side === 'left') {
        ctx.moveTo(x + 10, y - 9);
        ctx.lineTo(x - 6, y);
        ctx.lineTo(x + 10, y + 9);
      } else {
        ctx.moveTo(x - 10, y - 9);
        ctx.lineTo(x + 6, y);
        ctx.lineTo(x - 10, y + 9);
      }
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    function clear() { ctx.clearRect(0, 0, W, H); }

    return {
      worldToScreen,
      clear,
      drawSky,
      drawTerrain,
      drawStickman,
      drawBall,
      drawTrajectoryPreview,
      drawPowerIndicator,
      offscreenArrows,
      drawOffscreenArrows,
    };
  }

  root.SnowballRender = { createRenderer, hillPathD, PALETTE_COLORS };
})(typeof globalThis !== 'undefined' ? globalThis : this);
