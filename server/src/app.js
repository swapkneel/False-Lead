// server/src/app.js
// ─────────────────────────────────────────────────────────────────────────────
//  Application entry point.
//
//  Critical wiring detail:
//    Socket.IO must share the same http.Server as Express.
//    If you call app.listen() it creates its own internal http.Server that
//    Socket.IO never sees — WebSocket upgrades silently fail.
//    The fix: create http.Server explicitly, pass it to both Express and
//    initSocket(), then call httpServer.listen() once at the bottom.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

require('dotenv').config();
require('./config/db');


const http    = require('http');
const express = require('express');
const { initSocket } = require('./socket/index');

const app        = express();
const httpServer = http.createServer(app);  // shared server — Express + Socket.IO

// ─────────────────────────────────────────────
//  Middleware
// ─────────────────────────────────────────────

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ─────────────────────────────────────────────
//  REST routes
// ─────────────────────────────────────────────

const roomsRouter = require('./routes/rooms');

app.use('/api/rooms', roomsRouter);

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

app.use((_req, res) => {
  res.status(404).json({ success: false, error: 'Route not found' });
});

// ─────────────────────────────────────────────
//  Socket.IO
//  Must be initialised after httpServer is created
//  but the order relative to REST routes doesn't matter.
// ─────────────────────────────────────────────

initSocket(httpServer);

// ─────────────────────────────────────────────
//  Start
// ─────────────────────────────────────────────

const PORT = process.env.PORT || 3001;

httpServer.listen(PORT, () => {
  console.log(`False Lead server running on port ${PORT}`);
  console.log(`REST  → http://localhost:${PORT}/api`);
  console.log(`WS    → ws://localhost:${PORT}`);
});

module.exports = { app, httpServer }; // export both for integration tests
