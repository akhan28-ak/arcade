/*
 * Chip Wars — Socket.IO Server
 * -----------------------------
 * A thin room manager wrapped around the same GameEngine the browser
 * client uses (engine.js). The server is authoritative for board state
 * in three complementary ways:
 *
 *   1. Every move goes through engine.applyMove() here first — clients
 *      only ever send intent ("I clicked r,c"), never state.
 *   2. Every broadcast (`move:applied`, `game:started`, `room:update`)
 *      carries a full grid snapshot alongside the animation event log,
 *      so a client that only trusted the snapshot (ignoring events
 *      entirely) would still end up correct.
 *   3. Clients can ask for the truth at any time via `state:sync`, and
 *      can reattach to a seat after a dropped connection via
 *      `room:resume` — both just hand back the same snapshot shape.
 *
 * Run:
 *   npm install
 *   npm start
 *   -> serves the existing client at http://localhost:3000
 *      and speaks Socket.IO on the same port.
 */

'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const { GameEngine } = require('./games/chip-wars/engine.js');
const { StarBounceSim, SIDES_FOR_COUNT: SB_SIDES_FOR_COUNT } = require('./games/star-bounce/sim.js');
const SnowballMaps = require('./games/snowball-siege/maps.js');

const PORT = process.env.PORT || 3000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const VALID_SIZES = [6, 7, 8, 9];
const VALID_DIFFICULTIES = ['easy', 'medium', 'hard'];
const BOT_MOVE_DELAY_MS = 700;
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

const app = express();
app.use(express.static(path.join(__dirname)));

// Health check for platform load balancers / uptime monitors (Render,
// Railway, Fly, Docker HEALTHCHECK, etc. all expect a plain 200 here).
app.get('/healthz', (req, res) => {
  res.status(200).json({ ok: true, rooms: rooms.size, uptime: process.uptime() });
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: CORS_ORIGIN } });

// roomCode -> Room
const rooms = new Map();

function makeRoomCode() {
  let code;
  do {
    code = Array.from({ length: 5 }, () => ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function makeToken() {
  return crypto.randomUUID();
}

function validateSlots(slots) {
  if (!Array.isArray(slots) || slots.length < 1 || slots.length > 4) {
    return 'slots must be an array of 1 to 4 entries';
  }
  for (const s of slots) {
    if (!s || (s.type !== 'human' && s.type !== 'bot')) return 'each slot needs type "human" or "bot"';
    if (s.type === 'bot' && s.difficulty && !VALID_DIFFICULTIES.includes(s.difficulty)) {
      return 'invalid bot difficulty';
    }
  }
  return null;
}

// A Room owns the slot list (human/bot, name, socket, connection status)
// and, once started, a live GameEngine instance — the single authoritative
// copy of the board. Every snapshot sent to clients is derived from it.
class Room {
  constructor(code, size, slots, hostSocketId) {
    this.code = code;
    this.size = size;
    this.hostSocketId = hostSocketId;
    this.slots = slots.map(s => ({
      type: s.type, // as configured: 'human' (a seat to be claimed) or 'bot'
      difficulty: s.type === 'bot' ? s.difficulty || 'medium' : undefined,
      socketId: null,
      token: null,
      name: null,
      connected: false,
    }));
    this.started = false;
    this.engine = null;
  }

  // A seat is bot-controlled either because it was configured as a bot,
  // or because its human occupant is currently disconnected mid-game.
  isBotControlled(idx) {
    const s = this.slots[idx];
    if (s.type === 'bot') return true;
    return this.started && !s.connected;
  }

  botDifficultyFor(idx) {
    const s = this.slots[idx];
    return s.type === 'bot' ? s.difficulty : 'medium';
  }

  // The full authoritative snapshot. Sent verbatim on room:update,
  // game:started, move:applied, and state:sync/room:resume acks — the
  // same shape everywhere, so a client can resync from any of them.
  publicState() {
    return {
      roomCode: this.code,
      size: this.size,
      started: this.started,
      hostSocketId: this.hostSocketId,
      slots: this.slots.map((s, i) => ({
        type: s.type,
        difficulty: s.difficulty || null,
        name: s.name,
        connected: s.connected,
        botControlled: this.isBotControlled(i),
      })),
      current: this.engine ? this.engine.current : 0,
      eliminated: this.engine ? this.engine.eliminated : this.slots.map(() => false),
      gameOver: this.engine ? this.engine.gameOver : false,
      winner: this.engine ? this.engine.winner : null,
      // Deep-ish snapshot: JSON transit over the wire copies it, so
      // mutating engine.grid afterward can't retroactively change what
      // was already sent.
      grid: this.engine ? this.engine.grid.map(row => row.map(cell => ({ ...cell }))) : null,
    };
  }

  isEmpty() {
    return this.slots.every(s => s.type === 'bot' || !s.connected);
  }

  openHumanSlotIndex() {
    return this.slots.findIndex(s => s.type === 'human' && !s.socketId);
  }

  slotIndexForSocket(socketId) {
    return this.slots.findIndex(s => s.socketId === socketId);
  }
}

function broadcastRoomUpdate(room) {
  io.to(room.code).emit('room:update', room.publicState());
}

// After a move resolves, if it's now a bot-controlled seat's turn,
// compute and apply it server-side after a short "thinking" delay, then
// broadcast the result exactly like a human move would be.
function scheduleBotTurnIfNeeded(room) {
  if (!room.started || room.engine.gameOver) return;
  if (!room.isBotControlled(room.engine.current)) return;

  setTimeout(() => {
    const currentRoom = rooms.get(room.code);
    if (!currentRoom || !currentRoom.started || currentRoom.engine.gameOver) return;
    const botIdx = currentRoom.engine.current;
    if (!currentRoom.isBotControlled(botIdx)) return; // state changed underneath us; bail safely

    const mv = currentRoom.engine.chooseBotMove(botIdx, currentRoom.botDifficultyFor(botIdx));
    if (!mv) return;
    applyMoveAndBroadcast(currentRoom, mv.r, mv.c, botIdx);
  }, BOT_MOVE_DELAY_MS);
}

function applyMoveAndBroadcast(room, r, c, actingPlayerIdx) {
  const result = room.engine.applyMove(r, c);
  if (!result) return false;

  // events drive the animation; the trailing `grid` is the authoritative
  // end state, so a client can always fall back to "just draw this" if
  // anything about the animated replay ever falls out of sync.
  io.to(room.code).emit('move:applied', {
    r,
    c,
    actingPlayer: actingPlayerIdx,
    events: result.events,
    current: result.current,
    eliminated: result.eliminated,
    gameOver: result.gameOver,
    winner: result.winner,
    grid: room.engine.grid.map(row => row.map(cell => ({ ...cell }))),
  });

  if (!result.gameOver) scheduleBotTurnIfNeeded(room);
  return true;
}

io.on('connection', socket => {
  // ---- Create a room -------------------------------------------------
  socket.on('room:create', (payload, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    const { size, slots, name } = payload || {};

    if (!VALID_SIZES.includes(size)) return ack({ ok: false, error: 'invalid board size' });
    const slotError = validateSlots(slots);
    if (slotError) return ack({ ok: false, error: slotError });

    const code = makeRoomCode();
    const room = new Room(code, size, slots, socket.id);
    rooms.set(code, room);

    const myIndex = room.openHumanSlotIndex();
    if (myIndex === -1) return ack({ ok: false, error: 'no human slot available to join as host' });

    const token = makeToken();
    room.slots[myIndex].socketId = socket.id;
    room.slots[myIndex].token = token;
    room.slots[myIndex].name = (name || 'Player').slice(0, 24);
    room.slots[myIndex].connected = true;

    socket.join(code);
    socket.data.roomCode = code;
    socket.data.playerIndex = myIndex;

    ack({ ok: true, roomCode: code, playerIndex: myIndex, token, state: room.publicState() });
    broadcastRoomUpdate(room);
  });

  // ---- Join an existing room ------------------------------------------
  socket.on('room:join', (payload, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    const { roomCode, name } = payload || {};
    const room = rooms.get((roomCode || '').toUpperCase());
    if (!room) return ack({ ok: false, error: 'room not found' });
    if (room.started) return ack({ ok: false, error: 'game already started' });

    const idx = room.openHumanSlotIndex();
    if (idx === -1) return ack({ ok: false, error: 'room is full' });

    const token = makeToken();
    room.slots[idx].socketId = socket.id;
    room.slots[idx].token = token;
    room.slots[idx].name = (name || 'Player').slice(0, 24);
    room.slots[idx].connected = true;

    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.playerIndex = idx;

    ack({ ok: true, roomCode: room.code, playerIndex: idx, token, state: room.publicState() });
    broadcastRoomUpdate(room);
  });

  // ---- Reattach to a seat after a dropped connection / page refresh ----
  socket.on('room:resume', (payload, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    const { roomCode, playerIndex, token } = payload || {};
    const room = rooms.get((roomCode || '').toUpperCase());
    if (!room) return ack({ ok: false, error: 'room not found' });

    const slot = room.slots[playerIndex];
    if (!slot || slot.type !== 'human' || !slot.token || slot.token !== token) {
      return ack({ ok: false, error: 'invalid or expired session' });
    }

    slot.socketId = socket.id;
    slot.connected = true;

    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.playerIndex = playerIndex;

    ack({ ok: true, roomCode: room.code, playerIndex, token, state: room.publicState() });
    broadcastRoomUpdate(room);
    // Their seat may have been sitting bot-controlled while disconnected;
    // no move is forced, they simply regain control on their next turn.
  });

  // ---- On-demand authoritative snapshot --------------------------------
  socket.on('state:sync', (payload, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    const room = rooms.get(socket.data.roomCode);
    if (!room) return ack({ ok: false, error: 'not in a room' });
    ack({ ok: true, state: room.publicState() });
  });

  // ---- Host starts the game --------------------------------------------
  socket.on('room:start', (payload, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    const room = rooms.get(socket.data.roomCode);
    if (!room) return ack({ ok: false, error: 'not in a room' });
    if (room.hostSocketId !== socket.id) return ack({ ok: false, error: 'only the host can start the game' });
    if (room.started) return ack({ ok: false, error: 'already started' });

    const unfilled = room.slots.some(s => s.type === 'human' && !s.socketId);
    if (unfilled) return ack({ ok: false, error: 'waiting for all human seats to be filled' });

    room.started = true;
    room.engine = new GameEngine(room.size, room.slots.length);

    io.to(room.code).emit('game:started', room.publicState());
    ack({ ok: true });

    scheduleBotTurnIfNeeded(room);
  });

  // ---- A player makes a move -------------------------------------------
  socket.on('move:make', (payload, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.started) return ack({ ok: false, error: 'game not in progress' });

    const { r, c } = payload || {};
    const myIndex = socket.data.playerIndex;

    if (room.engine.current !== myIndex) return ack({ ok: false, error: 'not your turn' });
    if (!room.engine.isValidMove(r, c)) return ack({ ok: false, error: 'illegal move' });

    const applied = applyMoveAndBroadcast(room, r, c, myIndex);
    ack({ ok: applied });
  });

  // ---- Leave / disconnect ----------------------------------------------
  function handleLeave() {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;

    const idx = room.slotIndexForSocket(socket.id);
    if (idx === -1) return;

    room.slots[idx].connected = false;

    if (!room.started) {
      // Free the seat entirely so someone else can join it.
      room.slots[idx].socketId = null;
      room.slots[idx].token = null;
      room.slots[idx].name = null;
    } else {
      // Mid-game: the seat becomes bot-controlled (Room.isBotControlled)
      // until either the match ends or the same player resumes with
      // their token via room:resume — their `type`/name/token are left
      // untouched so a resume can seamlessly hand control back.
      scheduleBotTurnIfNeeded(room);
    }

    if (room.isEmpty()) {
      rooms.delete(room.code);
      return;
    }

    broadcastRoomUpdate(room);
  }

  socket.on('room:leave', () => {
    handleLeave();
    socket.leave(socket.data.roomCode);
    socket.data.roomCode = null;
    socket.data.playerIndex = null;
  });

  socket.on('disconnect', handleLeave);
});

/*
 * Star Bounce — Online Multiplayer
 * -----------------------------------
 * Unlike Chip Wars' turn-based events, Star Bounce is continuous
 * real-time physics, so the server runs a live tick loop per active
 * room (using the exact same StarBounceSim the browser preview uses)
 * and broadcasts a full snapshot every tick. Clients never simulate —
 * they only send "toggle my paddle" intent and draw whatever snapshot
 * arrives. Broadcasting complete truth every ~33ms is inherently
 * self-synchronizing: a client that missed a packet is simply correct
 * again the moment the next one arrives, with no separate resync
 * endpoint needed the way the turn-based game required one.
 */

const SB_TICK_MS = 33;
// Distinct Socket.IO room-name prefix so a Star Bounce room code can
// never collide with a Chip Wars room broadcasting to the same string.
const SB_ROOM_PREFIX = 'sb-';

const sbRooms = new Map();

function makeSBRoomCode() {
  let code;
  do {
    code = Array.from({ length: 5 }, () => ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)]).join('');
  } while (sbRooms.has(code));
  return code;
}

class SBRoom {
  constructor(code, count, slots, hostSocketId) {
    this.code = code;
    this.count = count;
    this.hostSocketId = hostSocketId;
    this.sideOrder = SB_SIDES_FOR_COUNT[count];
    this.slots = slots.map((s, i) => ({
      side: this.sideOrder[i],
      type: s.type,
      difficulty: s.type === 'bot' ? s.difficulty || 'medium' : undefined,
      socketId: null,
      token: null,
      name: null,
      connected: false,
    }));
    this.started = false;
    this.sim = null;
    this.tickTimer = null;
  }

  isBotControlled(idx) {
    const s = this.slots[idx];
    if (s.type === 'bot') return true;
    return this.started && !s.connected;
  }

  publicState() {
    return {
      roomCode: this.code,
      count: this.count,
      started: this.started,
      hostSocketId: this.hostSocketId,
      slots: this.slots.map((s, i) => ({
        side: s.side,
        type: s.type,
        difficulty: s.difficulty || null,
        name: s.name,
        connected: s.connected,
        botControlled: this.isBotControlled(i),
      })),
      snapshot: this.sim ? this.sim.getSnapshot() : null,
    };
  }

  isEmpty() { return this.slots.every(s => s.type === 'bot' || !s.connected); }
  openHumanSlotIndex() { return this.slots.findIndex(s => s.type === 'human' && !s.socketId); }
  slotIndexForSocket(socketId) { return this.slots.findIndex(s => s.socketId === socketId); }
}

function playersBySideForRoom(room) {
  const bySide = { top: null, right: null, bottom: null, left: null };
  room.slots.forEach(s => { bySide[s.side] = { type: s.type, difficulty: s.difficulty, name: s.name }; });
  return bySide;
}

function broadcastSBUpdate(room) {
  io.to(SB_ROOM_PREFIX + room.code).emit('sb:update', room.publicState());
}

function startSBLoop(room) {
  room.tickTimer = setInterval(() => {
    room.sim.step(SB_TICK_MS / 1000);
    io.to(SB_ROOM_PREFIX + room.code).emit('sb:state', room.sim.getSnapshot());
    if (room.sim.gameOver) {
      clearInterval(room.tickTimer);
      room.tickTimer = null;
    }
  }, SB_TICK_MS);
}

io.on('connection', socket => {
  socket.on('sb:create', (payload, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    const { count, slots, name } = payload || {};

    if (![2, 3, 4].includes(count)) return ack({ ok: false, error: 'invalid player count' });
    if (!Array.isArray(slots) || slots.length !== count) return ack({ ok: false, error: 'seats must match player count' });
    for (const s of slots) {
      if (!s || (s.type !== 'human' && s.type !== 'bot')) return ack({ ok: false, error: 'each seat needs type human or bot' });
      if (s.type === 'bot' && s.difficulty && !VALID_DIFFICULTIES.includes(s.difficulty)) return ack({ ok: false, error: 'invalid bot difficulty' });
    }

    const code = makeSBRoomCode();
    const room = new SBRoom(code, count, slots, socket.id);
    sbRooms.set(code, room);

    const myIndex = room.openHumanSlotIndex();
    if (myIndex === -1) return ack({ ok: false, error: 'no human seat available to join as host' });

    const token = makeToken();
    room.slots[myIndex].socketId = socket.id;
    room.slots[myIndex].token = token;
    room.slots[myIndex].name = (name || 'Player').slice(0, 24);
    room.slots[myIndex].connected = true;

    socket.join(SB_ROOM_PREFIX + code);
    socket.data.sbRoomCode = code;
    socket.data.sbSeatIndex = myIndex;

    ack({ ok: true, roomCode: code, seatIndex: myIndex, token, state: room.publicState() });
    broadcastSBUpdate(room);
  });

  socket.on('sb:join', (payload, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    const { roomCode, name } = payload || {};
    const room = sbRooms.get((roomCode || '').toUpperCase());
    if (!room) return ack({ ok: false, error: 'room not found' });
    if (room.started) return ack({ ok: false, error: 'game already started' });

    const idx = room.openHumanSlotIndex();
    if (idx === -1) return ack({ ok: false, error: 'room is full' });

    const token = makeToken();
    room.slots[idx].socketId = socket.id;
    room.slots[idx].token = token;
    room.slots[idx].name = (name || 'Player').slice(0, 24);
    room.slots[idx].connected = true;

    socket.join(SB_ROOM_PREFIX + room.code);
    socket.data.sbRoomCode = room.code;
    socket.data.sbSeatIndex = idx;

    ack({ ok: true, roomCode: room.code, seatIndex: idx, token, state: room.publicState() });
    broadcastSBUpdate(room);
  });

  socket.on('sb:resume', (payload, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    const { roomCode, seatIndex, token } = payload || {};
    const room = sbRooms.get((roomCode || '').toUpperCase());
    if (!room) return ack({ ok: false, error: 'room not found' });

    const slot = room.slots[seatIndex];
    if (!slot || slot.type !== 'human' || !slot.token || slot.token !== token) {
      return ack({ ok: false, error: 'invalid or expired session' });
    }

    slot.socketId = socket.id;
    slot.connected = true;
    socket.join(SB_ROOM_PREFIX + room.code);
    socket.data.sbRoomCode = room.code;
    socket.data.sbSeatIndex = seatIndex;
    if (room.sim) room.sim.setBotOverride(slot.side, false);

    ack({ ok: true, roomCode: room.code, seatIndex, token, state: room.publicState() });
    broadcastSBUpdate(room);
  });

  socket.on('sb:start', (payload, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    const room = sbRooms.get(socket.data.sbRoomCode);
    if (!room) return ack({ ok: false, error: 'not in a room' });
    if (room.hostSocketId !== socket.id) return ack({ ok: false, error: 'only the host can start the game' });
    if (room.started) return ack({ ok: false, error: 'already started' });

    const unfilled = room.slots.some(s => s.type === 'human' && !s.socketId);
    if (unfilled) return ack({ ok: false, error: 'waiting for all human seats to be filled' });

    room.started = true;
    room.sim = new StarBounceSim(playersBySideForRoom(room));

    io.to(SB_ROOM_PREFIX + room.code).emit('sb:started', room.publicState());
    ack({ ok: true });
    startSBLoop(room);
  });

  socket.on('sb:toggle', (payload, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    const room = sbRooms.get(socket.data.sbRoomCode);
    if (!room || !room.started || !room.sim) return ack({ ok: false, error: 'game not in progress' });
    const idx = socket.data.sbSeatIndex;
    const slot = room.slots[idx];
    if (!slot) return ack({ ok: false, error: 'not seated' });
    room.sim.toggle(slot.side);
    ack({ ok: true });
  });

  function handleSBLeave() {
    const room = sbRooms.get(socket.data.sbRoomCode);
    if (!room) return;

    const idx = room.slotIndexForSocket(socket.id);
    if (idx === -1) return;

    room.slots[idx].connected = false;

    if (!room.started) {
      room.slots[idx].socketId = null;
      room.slots[idx].token = null;
      room.slots[idx].name = null;
    } else if (room.sim) {
      room.sim.setBotOverride(room.slots[idx].side, true);
    }

    if (room.isEmpty()) {
      if (room.tickTimer) clearInterval(room.tickTimer);
      sbRooms.delete(room.code);
      return;
    }

    broadcastSBUpdate(room);
  }

  socket.on('sb:leave', () => {
    handleSBLeave();
    socket.leave(SB_ROOM_PREFIX + socket.data.sbRoomCode);
    socket.data.sbRoomCode = null;
    socket.data.sbSeatIndex = null;
  });

  socket.on('disconnect', handleSBLeave);
});

/*
 * Snowball Siege — Lobby + Gameplay
 * ------------------------------------
 * Turn-based, so unlike Star Bounce this needs no continuous tick loop —
 * the server just holds one SnowballSim per started room and advances it
 * exactly once per `sw:throw`. A throw is sent as intent (angle + power);
 * the server runs the exact same physics used locally and broadcasts the
 * full result to everyone, including the thrower — nobody animates a
 * throw they haven't been told the real outcome of, so there's nothing
 * to reconcile if a client's own guess had been wrong.
 */

const { SnowballSim } = require('./games/snowball-siege/sim.js');

const swRooms = new Map();

function makeSWRoomCode() {
  let code;
  do {
    code = Array.from({ length: 5 }, () => ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)]).join('');
  } while (swRooms.has(code));
  return code;
}

class SWRoom {
  constructor(code, count, mapId, hostSocketId) {
    this.code = code;
    this.count = count;
    this.mapId = mapId;
    this.hostSocketId = hostSocketId;
    this.slots = Array.from({ length: count }, () => ({ socketId: null, token: null, name: null, connected: false }));
    this.started = false;
    this.sim = null;
  }

  publicState() {
    return {
      roomCode: this.code,
      count: this.count,
      mapId: this.mapId,
      started: this.started,
      hostSocketId: this.hostSocketId,
      slots: this.slots.map(s => ({ name: s.name, connected: s.connected })),
      matchState: this.sim ? this.sim.getState() : null,
    };
  }

  isEmpty() { return this.slots.every(s => !s.connected); }
  openSlotIndex() { return this.slots.findIndex(s => !s.socketId); }
  slotIndexForSocket(socketId) { return this.slots.findIndex(s => s.socketId === socketId); }
}

function broadcastSWUpdate(room) {
  io.to('sw-' + room.code).emit('sw:update', room.publicState());
}

io.on('connection', socket => {
  socket.on('sw:create', (payload, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    const { count, mapId, name } = payload || {};
    if (![2, 3, 4].includes(count)) return ack({ ok: false, error: 'invalid player count' });
    if (!SnowballMaps.MAPS.some(m => m.id === mapId)) return ack({ ok: false, error: 'invalid map' });

    const code = makeSWRoomCode();
    const room = new SWRoom(code, count, mapId, socket.id);
    swRooms.set(code, room);

    const token = makeToken();
    room.slots[0].socketId = socket.id;
    room.slots[0].token = token;
    room.slots[0].name = (name || 'Player').slice(0, 24);
    room.slots[0].connected = true;

    socket.join('sw-' + code);
    socket.data.swRoomCode = code;
    socket.data.swSeatIndex = 0;

    ack({ ok: true, roomCode: code, seatIndex: 0, token, state: room.publicState() });
    broadcastSWUpdate(room);
  });

  socket.on('sw:join', (payload, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    const { roomCode, name } = payload || {};
    const room = swRooms.get((roomCode || '').toUpperCase());
    if (!room) return ack({ ok: false, error: 'room not found' });
    if (room.started) return ack({ ok: false, error: 'game already started' });

    const idx = room.openSlotIndex();
    if (idx === -1) return ack({ ok: false, error: 'room is full' });

    const token = makeToken();
    room.slots[idx].socketId = socket.id;
    room.slots[idx].token = token;
    room.slots[idx].name = (name || 'Player').slice(0, 24);
    room.slots[idx].connected = true;

    socket.join('sw-' + room.code);
    socket.data.swRoomCode = room.code;
    socket.data.swSeatIndex = idx;

    ack({ ok: true, roomCode: room.code, seatIndex: idx, token, state: room.publicState() });
    broadcastSWUpdate(room);
  });

  socket.on('sw:resume', (payload, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    const { roomCode, seatIndex, token } = payload || {};
    const room = swRooms.get((roomCode || '').toUpperCase());
    if (!room) return ack({ ok: false, error: 'room not found' });
    const slot = room.slots[seatIndex];
    if (!slot || !slot.token || slot.token !== token) return ack({ ok: false, error: 'invalid or expired session' });

    slot.socketId = socket.id;
    slot.connected = true;
    socket.join('sw-' + room.code);
    socket.data.swRoomCode = room.code;
    socket.data.swSeatIndex = seatIndex;

    ack({ ok: true, roomCode: room.code, seatIndex, token, state: room.publicState() });
    broadcastSWUpdate(room);
  });

  socket.on('sw:start', (payload, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    const room = swRooms.get(socket.data.swRoomCode);
    if (!room) return ack({ ok: false, error: 'not in a room' });
    if (room.hostSocketId !== socket.id) return ack({ ok: false, error: 'only the host can start the game' });
    if (room.started) return ack({ ok: false, error: 'already started' });
    if (room.slots.some(s => !s.connected)) return ack({ ok: false, error: 'waiting for all seats to be filled' });

    room.started = true;
    const map = SnowballMaps.getMap(room.mapId);
    const spawns = SnowballMaps.assignSpawns(map, room.count);
    const players = room.slots.map(s => ({ name: s.name }));
    room.sim = new SnowballSim(map, players, spawns);

    const state = room.sim.getState();
    io.to('sw-' + room.code).emit('sw:started', {
      roomCode: room.code,
      mapId: room.mapId,
      players: state.players,
      turn: state.turn,
    });
    ack({ ok: true });
  });

  socket.on('sw:throw', (payload, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    const room = swRooms.get(socket.data.swRoomCode);
    if (!room || !room.started || !room.sim) return ack({ ok: false, error: 'game not in progress' });

    const idx = socket.data.swSeatIndex;
    if (!room.sim.isValidThrow(idx)) return ack({ ok: false, error: 'not your turn' });

    const { angle, power } = payload || {};
    if (typeof angle !== 'number' || typeof power !== 'number') return ack({ ok: false, error: 'invalid throw' });

    const result = room.sim.throwSnowball(idx, angle, Math.max(0, Math.min(1, power)));
    if (!result) return ack({ ok: false, error: 'throw rejected' });

    io.to('sw-' + room.code).emit('sw:thrown', result);
    ack({ ok: true });
  });

  function handleSWLeave() {
    const room = swRooms.get(socket.data.swRoomCode);
    if (!room) return;
    const idx = room.slotIndexForSocket(socket.id);
    if (idx === -1) return;

    room.slots[idx].connected = false;

    if (!room.started) {
      room.slots[idx].socketId = null;
      room.slots[idx].token = null;
      room.slots[idx].name = null;
    } else if (room.sim) {
      // No bots in this game — a mid-match disconnect just eliminates
      // that player's snowman rather than leaving the match stuck
      // waiting on someone who isn't coming back.
      room.sim.eliminatePlayer(idx);
      io.to('sw-' + room.code).emit('sw:playerLeft', room.sim.getState());
    }

    if (room.isEmpty()) { swRooms.delete(room.code); return; }
    broadcastSWUpdate(room);
  }

  socket.on('sw:leave', () => {
    handleSWLeave();
    socket.leave('sw-' + socket.data.swRoomCode);
    socket.data.swRoomCode = null;
    socket.data.swSeatIndex = null;
  });

  socket.on('disconnect', handleSWLeave);
});

server.listen(PORT, () => {
  console.log(`Chip Wars server listening on http://localhost:${PORT}`);
});
