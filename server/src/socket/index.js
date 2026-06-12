// server/src/socket/index.js
// ─────────────────────────────────────────────────────────────────────────────
//  Socket.IO server initialisation.
//  Registers all per-connection handler pipelines.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const { Server } = require('socket.io');
const pool       = require('../config/db');
const { registerLobbyHandlers } = require('./handlers/lobbyHandlers');
const { registerGameHandlers }  = require('./handlers/gameHandlers');
const { registerVoteHandlers }  = require('./handlers/voteHandlers');

/**
 * Attaches a Socket.IO server to an existing Node http.Server.
 *
 * @param {import('http').Server} httpServer
 * @returns {import('socket.io').Server}
 */
function initSocket(httpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
      methods: ['GET', 'POST'],
    },
    pingTimeout:  25000,
    pingInterval: 10000,
  });

  io.on('connection', (socket) => {
    console.log(`[socket] connected — id: ${socket.id}`);

    // Phase: Lobby   — join, leave, disconnect, settings, game:start
    registerLobbyHandlers(socket, io, pool);

    // Phase: Round   — round:start → creation + private role delivery
    registerGameHandlers(socket, io, pool);

    // Phase: Voting  — player:ready, vote:submit → results + scoring
    registerVoteHandlers(socket, io, pool);
  });

  return io;
}

module.exports = { initSocket };
