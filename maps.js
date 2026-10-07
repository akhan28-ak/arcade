/*
 * Snowball Siege — Maps
 * -----------------------
 * Terrain data only — no rendering, no game logic. Each map is a hill
 * silhouette (a list of points across a fixed 0–100 width/height space)
 * plus a set of spawn x-positions along that silhouette. Player colors
 * are shuffled across those spawn positions at the start of every match
 * (handled by the game logic, not stored here) so who stands where
 * changes each time.
 *
 * Dual Node/browser module, same pattern as engine.js and sim.js, so
 * the eventual game server can use the exact same terrain data the
 * client draws from.
 */

(function (root) {
  'use strict';

  const MAPS = [
    {
      id: 'twin-peaks',
      name: 'Twin Peaks',
      // A tall hill on each side with a dip in the middle.
      points: [
        [0, 62], [8, 55], [16, 34], [24, 20], [30, 30], [38, 46],
        [50, 58], [62, 46], [70, 30], [76, 20], [84, 34], [92, 55], [100, 62],
      ],
      spawnX: [6, 24, 50, 76, 94],
    },
    {
      id: 'rolling-drifts',
      name: 'Rolling Drifts',
      // Gentle, evenly-spaced rolling snow banks.
      points: [
        [0, 48], [10, 40], [20, 50], [30, 38], [40, 48], [50, 36],
        [60, 48], [70, 38], [80, 50], [90, 40], [100, 48],
      ],
      spawnX: [8, 28, 50, 72, 92],
    },
    {
      id: 'frozen-canyon',
      name: 'Frozen Canyon',
      // Dramatic spiky ridgeline with a deep central gap.
      points: [
        [0, 40], [10, 20], [18, 44], [26, 15], [36, 50], [50, 68],
        [64, 50], [74, 15], [82, 44], [90, 20], [100, 40],
      ],
      spawnX: [5, 22, 50, 78, 95],
    },
  ];

  function getMap(id) {
    return MAPS.find(m => m.id === id) || MAPS[0];
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // Given a map and a player count, pick that many spawn x-positions —
  // which positions are used AND which player index lands on each one
  // are both randomized, so a 2-player match doesn't always deterministically
  // put everyone at the two most extreme, farthest-apart points every time.
  function assignSpawns(map, playerCount) {
    const chosen = shuffle(map.spawnX).slice(0, playerCount).sort((a, b) => a - b);
    return shuffle(chosen);
  }

  const SnowballMaps = { MAPS, getMap, assignSpawns };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = SnowballMaps;
  }
  root.SnowballMaps = SnowballMaps;
})(typeof globalThis !== 'undefined' ? globalThis : this);
