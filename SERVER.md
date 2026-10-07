# Chip Wars — Socket.IO Server

A server-authoritative multiplayer layer for Chip Wars. It wraps the same
`GameEngine` from `engine.js` that the browser client uses — no game rules
are duplicated. Every move is validated and resolved on the server, and
board state is synchronized through the server in three complementary ways:

1. Every move goes through `engine.applyMove()` on the server first —
   clients only ever send intent ("I clicked r,c"), never state.
2. Every broadcast (`move:applied`, `game:started`, `room:update`) carries
   a full `grid` snapshot alongside the animation event log. The client
   plays the events for animation, then adopts the trailing grid as truth
   — so even if the animated replay ever drifted, the board self-corrects
   every move.
3. Clients can ask for the current truth at any time via `state:sync`
   (the networked client polls this every few seconds as a safety net),
   and can reattach to their seat after a dropped connection or page
   refresh via `room:resume` using a token issued at join time.

## Run it

```
npm install
npm start
```

Serves the client (`index.html`, `ui.js`, `net.js`, `renderer.js`,
`styles.css`, `engine.js`) at `http://localhost:3000` and speaks
Socket.IO on the same port.

## Concepts

- **Room** — one match. Identified by a 5-character code (e.g. `T89W6`).
  Has a fixed `size` (6/7/8/9) and a fixed list of 1–4 **slots** decided at
  creation time, each either `human` (an empty seat to be claimed) or `bot`
  (with a `difficulty`).
- **Slot index == player index** — the same index the engine uses as
  `owner`, and the same index `PALETTE` in `renderer.js` uses for color/name.
- **Token** — each human seat gets a private `token` (a UUID) in the ack
  when created/joined. The client saves `{roomCode, playerIndex, token}` in
  `sessionStorage` and replays it via `room:resume` on reconnect — the
  server checks the token matches that slot before reattaching the socket.
- **botControlled** — a seat is bot-controlled either because it was
  configured as a bot, or because its human occupant is currently
  disconnected mid-game (computed server-side, exposed on every snapshot
  so clients don't have to infer it). If a human disconnects mid-game,
  their seat plays as a `medium` bot until they resume with their token —
  the match is never stuck waiting on a dropped connection.

## Events

### Client → Server

| Event | Payload | Ack response |
|---|---|---|
| `room:create` | `{ size, slots: [{type:'human'\|'bot', difficulty?}], name }` | `{ ok, roomCode, playerIndex, token, state }` |
| `room:join` | `{ roomCode, name }` | `{ ok, roomCode, playerIndex, token, state }` |
| `room:resume` | `{ roomCode, playerIndex, token }` | `{ ok, roomCode, playerIndex, token, state }` |
| `state:sync` | `{}` (uses whatever room the socket is currently attached to) | `{ ok, state }` |
| `room:start` | `{}` (host only; requires every human seat filled) | `{ ok, error? }` |
| `move:make` | `{ r, c }` | `{ ok, error? }` |
| `room:leave` | `{}` | — |

Acks use the standard Socket.IO callback pattern:
`socket.emit('room:create', payload, (res) => { ... })`.

### Server → Room (broadcast)

| Event | Payload | When |
|---|---|---|
| `room:update` | full `state` (see below) | slots change — someone joins/leaves/disconnects/resumes |
| `game:started` | full `state`, `grid` now populated | host starts the match |
| `move:applied` | `{ r, c, actingPlayer, events, current, eliminated, gameOver, winner, grid }` | any move resolves, human or bot |

`state` shape (also returned by every ack, and inside `move:applied` as `grid`):

```js
{
  roomCode, size, started, hostSocketId,
  slots: [{ type, difficulty, name, connected, botControlled }, ...],
  current, eliminated, gameOver, winner,
  grid, // 2D array of {owner, dots} — authoritative, null until started
}
```

`events` inside `move:applied` is exactly what `GameEngine.applyMove()`
returns — an ordered list of `{type:'increment'|'explode'|'gain'|'settle', ...}`
steps, used purely for animation. The accompanying `grid` in the same
payload is what the client actually adopts as its state once the animation
finishes; the two are independent so a bug in one can't corrupt the other.

## Client behavior (net.js)

- On `move:applied`, plays `events` for animation, then sets its local
  `grid`/`current`/`eliminated`/`gameOver` directly from the payload
  rather than computing them from the events itself.
- Every 4 seconds while a game is active, calls `state:sync` and
  reconciles silently — catches anything a dropped broadcast might have
  missed.
- On page load, if a session was saved from before a refresh, reconnects
  and calls `room:resume` automatically before showing any UI.
- `room:update` while a game is in progress refreshes bot/disconnected
  status (via `botControlled`) without needing a move to happen.

## Notes / limitations

- Rooms live in memory only — restarting the server drops all matches.
  Fine for a single-process deployment; swap in Redis or similar if you
  need multiple server instances.
- No authentication beyond the per-seat token — anyone with a room code
  can join an open seat, and anyone with a leaked token could resume into
  someone else's seat. Fine for casual play with friends; add real auth
  for anything more adversarial.
- Tokens live only in memory alongside the room, so they don't survive a
  server restart either.

