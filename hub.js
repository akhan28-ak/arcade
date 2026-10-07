/*
 * Ak's Arcade — Hub
 * -------------------
 * Renders one flip-card per game from the GAMES list below. Adding a
 * new game later is just adding an entry here — no other markup needed.
 */

(function () {
  'use strict';

  const GAMES = [
    {
      id: 'chip-wars',
      name: 'CHIP WARS',
      href: 'games/chip-wars/index.html',
      instructions:
        'Every chip starts with 3 pips. Click your own chip to add a pip — at 4 it explodes, ' +
        'sending a pip to each neighbor and capturing any enemy chip caught in the blast. One ' +
        'explosion can chain into the next across the board. Eliminate every other color to win. ' +
        '1–4 players, mix humans and bots, play locally or online with a room code.',
      icon: `
        <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
          <circle cx="50" cy="50" r="44" fill="none" stroke="#e6435b" stroke-width="10"
            stroke-dasharray="8 6.9" transform="rotate(-8 50 50)"/>
          <circle cx="50" cy="50" r="32" fill="#a11e33" stroke="#f2e8d5" stroke-width="2.5"/>
          <circle cx="50" cy="38" r="6" fill="#f2e8d5"/>
          <circle cx="40" cy="58" r="6" fill="#f2e8d5"/>
          <circle cx="60" cy="58" r="6" fill="#f2e8d5"/>
        </svg>`,
    },
    {
      id: 'star-bounce',
      name: 'STAR BOUNCE',
      href: 'games/star-bounce/index.html',
      instructions:
        'Defend your side of the arena. Balls launch from the corner cannons and the pace picks ' +
        'up the longer the match runs. Click your control to slide your paddle between the two ' +
        'ends of your side — miss a ball and you lose one of your 5 lives. Lose them all and your ' +
        'side becomes a solid wall that bounces balls away instead. Last side standing wins. ' +
        '2–4 players, mix humans and bots.',
      icon: `
        <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
          <circle cx="14" cy="20" r="1" fill="#f2e8d5" opacity="0.7"/>
          <circle cx="86" cy="16" r="1.3" fill="#f2e8d5" opacity="0.6"/>
          <circle cx="90" cy="70" r="1" fill="#f2e8d5" opacity="0.5"/>
          <circle cx="10" cy="80" r="1.4" fill="#f2e8d5" opacity="0.6"/>
          <circle cx="50" cy="8" r="1" fill="#f2e8d5" opacity="0.5"/>
          <rect x="24" y="24" width="52" height="52" fill="none" stroke="#2f7cf6" stroke-width="2.5" opacity="0.9"/>
          <ellipse cx="24" cy="24" rx="9" ry="7" fill="#8a94a6" stroke="#c9d3e0" stroke-width="1.5" transform="rotate(45 24 24)"/>
          <ellipse cx="76" cy="24" rx="9" ry="7" fill="#8a94a6" stroke="#c9d3e0" stroke-width="1.5" transform="rotate(-45 76 24)"/>
          <ellipse cx="24" cy="76" rx="9" ry="7" fill="#8a94a6" stroke="#c9d3e0" stroke-width="1.5" transform="rotate(-45 24 76)"/>
          <ellipse cx="76" cy="76" rx="9" ry="7" fill="#8a94a6" stroke="#c9d3e0" stroke-width="1.5" transform="rotate(45 76 76)"/>
          <ellipse cx="50" cy="24" rx="9" ry="3.4" fill="#e6435b"/>
          <circle cx="60" cy="55" r="3" fill="#f2e8d5"/>
          <circle cx="40" cy="45" r="2.2" fill="#f2e8d5" opacity="0.8"/>
        </svg>`,
    },
    {
      id: 'snowball-siege',
      name: 'SNOWBALL SIEGE',
      href: 'games/snowball-siege/index.html',
      instructions:
        'Turn-based snowball duel on a snowy hillside. On your turn, drag back on your stickman ' +
        'to aim — the farther back you pull, the more force behind the throw. Headshots hit ' +
        'hardest, legs hit softest. Last duelist standing wins. 2–4 players, hotseat locally or ' +
        'play online — no bots here, every thrower is a real person. Settings and matchmaking are ' +
        'ready now; the throwing gameplay itself is still being built.',
      icon: `
        <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
          <rect x="4" y="4" width="92" height="92" rx="10" fill="#dcefff"/>
          <path d="M4,70 L20,55 L35,68 L50,50 L65,66 L80,54 L96,70 L96,92 L4,92 Z" fill="#ffffff" stroke="#b8cfe0" stroke-width="1.5"/>
          <circle cx="35" cy="40" r="6" fill="none" stroke="#1c2b3a" stroke-width="3"/>
          <line x1="35" y1="46" x2="35" y2="62" stroke="#1c2b3a" stroke-width="3"/>
          <line x1="35" y1="50" x2="46" y2="44" stroke="#1c2b3a" stroke-width="3"/>
          <line x1="35" y1="50" x2="26" y2="55" stroke="#1c2b3a" stroke-width="3"/>
          <line x1="35" y1="62" x2="28" y2="74" stroke="#1c2b3a" stroke-width="3"/>
          <line x1="35" y1="62" x2="42" y2="74" stroke="#1c2b3a" stroke-width="3"/>
          <circle cx="70" cy="35" r="4" fill="#ffffff" stroke="#9fb8cc" stroke-width="1.5"/>
          <path d="M46,44 Q58,30 70,35" fill="none" stroke="#8aa5bd" stroke-width="1.5" stroke-dasharray="2 3"/>
        </svg>`,
    },
  ];

  const grid = document.getElementById('gameGrid');

  GAMES.forEach(game => {
    const wrap = document.createElement('div');
    wrap.className = 'game-card-wrap';

    const name = document.createElement('div');
    name.className = 'game-name';
    name.textContent = game.name;

    const card = document.createElement('div');
    card.className = 'flip-card';
    card.innerHTML = `
      <div class="flip-inner">
        <div class="flip-front">
          ${game.icon}
          <div class="flip-hint-front">Tap for rules</div>
        </div>
        <div class="flip-back">
          <div class="back-title">${game.name}</div>
          <p>${game.instructions}</p>
          <div class="flip-hint">Tap to flip back</div>
        </div>
      </div>`;
    card.addEventListener('click', () => card.classList.toggle('flipped'));

    const playBtn = document.createElement('button');
    playBtn.className = 'play-btn';
    playBtn.textContent = 'Play';
    playBtn.addEventListener('click', e => {
      e.stopPropagation();
      window.location.href = game.href;
    });

    wrap.appendChild(name);
    wrap.appendChild(card);
    wrap.appendChild(playBtn);
    grid.appendChild(wrap);
  });

  const more = document.createElement('div');
  more.className = 'more-soon';
  more.textContent = 'More games coming soon';
  grid.appendChild(more);
})();
