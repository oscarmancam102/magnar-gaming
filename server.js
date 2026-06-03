const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = 3000;
const SECRET_KEY = 'magnar_gaming_secret_key_2025';

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ---------- EXISTING DATABASE & AUTH (unchanged) ----------
const db = new sqlite3.Database('./magnar.db');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    email TEXT UNIQUE,
    password TEXT,
    plan TEXT DEFAULT 'free',
    chips INTEGER DEFAULT 0,
    total_winnings INTEGER DEFAULT 0,
    tournaments_played INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS tournaments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    game TEXT,
    prize_pool INTEGER,
    max_players INTEGER,
    current_players INTEGER DEFAULT 1,
    entry_fee INTEGER,
    status TEXT DEFAULT 'open',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS tournament_participants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tournament_id INTEGER,
    user_id INTEGER,
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

function generateToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, SECRET_KEY, { expiresIn: '7d' });
}

function verifyToken(req, res, next) {
  const token = req.headers['authorization'];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  jwt.verify(token, SECRET_KEY, (err, decoded) => {
    if (err) return res.status(401).json({ error: 'Invalid token' });
    req.user = decoded;
    next();
  });
}

app.post('/api/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: 'All fields required' });
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    db.run(`INSERT INTO users (username, email, password) VALUES (?, ?, ?)`,
      [username, email, hashedPassword],
      function(err) {
        if (err) {
          if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'Username or email already exists' });
          return res.status(500).json({ error: err.message });
        }
        const token = generateToken({ id: this.lastID, username });
        res.json({ token, user: { id: this.lastID, username, email, chips: 0, total_winnings: 0, tournaments_played: 0 } });
      });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  db.get(`SELECT * FROM users WHERE email = ?`, [email], async (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) return res.status(401).json({ error: 'Invalid credentials' });
    const token = generateToken(user);
    res.json({ token, user: { id: user.id, username: user.username, email: user.email, chips: user.chips || 0, total_winnings: user.total_winnings || 0, tournaments_played: user.tournaments_played || 0 } });
  });
});

app.get('/api/user', verifyToken, (req, res) => {
  db.get(`SELECT id, username, email, plan, chips, total_winnings, tournaments_played FROM users WHERE id = ?`, [req.user.id], (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  });
});

app.get('/api/tournaments', (req, res) => {
  db.all(`SELECT * FROM tournaments WHERE status = 'open'`, [], (err, tournaments) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(tournaments || []);
  });
});

function addSampleTournaments() {
  db.get(`SELECT COUNT(*) as count FROM tournaments`, (err, row) => {
    if (row && row.count === 0) {
      const samples = [
        { name: 'Checkers Championship', game: 'checkers', prize_pool: 2500, max_players: 32, entry_fee: 50 },
        { name: '8-Ball Pool Masters', game: 'pool', prize_pool: 5000, max_players: 16, entry_fee: 100 },
        { name: 'Racing Grand Prix', game: 'racing', prize_pool: 3000, max_players: 12, entry_fee: 75 }
      ];
      samples.forEach(t => {
        db.run(`INSERT INTO tournaments (name, game, prize_pool, max_players, entry_fee) VALUES (?, ?, ?, ?, ?)`,
          [t.name, t.game, t.prize_pool, t.max_players, t.entry_fee]);
      });
      console.log('✅ Sample tournaments added');
    }
  });
}
addSampleTournaments();

// ---------- MULTIPLAYER CHECKERS (SOCKET.IO) ----------
// Game rooms storage
const rooms = new Map();

io.on('connection', (socket) => {
  console.log(`Multiplayer user connected: ${socket.id}`);

  socket.on('createRoom', () => {
    const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
    rooms.set(roomId, {
      players: [socket.id],
      gameState: null,
      turn: 'red',
      redPlayer: socket.id,
      blackPlayer: null
    });
    socket.join(roomId);
    socket.emit('roomCreated', roomId);
  });

  socket.on('joinRoom', (roomId) => {
    const room = rooms.get(roomId);
    if (!room) return socket.emit('joinError', 'Room not found');
    if (room.players.length >= 2) return socket.emit('joinError', 'Room is full');
    room.players.push(socket.id);
    room.blackPlayer = socket.id;
    socket.join(roomId);
    socket.emit('joinSuccess', roomId);
    io.to(roomId).emit('gameReady', {
      yourColor: socket.id === room.redPlayer ? 'red' : 'black',
      redPlayerId: room.redPlayer,
      blackPlayerId: room.blackPlayer
    });
    // send initial board
    const initialBoard = Array(8).fill().map(() => Array(8).fill(null));
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 8; c++) {
        if ((r + c) % 2 === 1) initialBoard[r][c] = { color: 'black', king: false };
      }
    }
    for (let r = 5; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        if ((r + c) % 2 === 1) initialBoard[r][c] = { color: 'red', king: false };
      }
    }
    room.gameState = { board: initialBoard, turn: 'red' };
    io.to(roomId).emit('gameState', room.gameState);
  });

  socket.on('makeMove', (data) => {
    const { roomId, fromRow, fromCol, toRow, toCol } = data;
    const room = rooms.get(roomId);
    if (!room) return;
    const isRed = socket.id === room.redPlayer;
    if ((isRed && room.gameState.turn !== 'red') || (!isRed && room.gameState.turn !== 'black')) {
      socket.emit('invalidTurn');
      return;
    }
    // apply move (simple validation)
    const board = room.gameState.board;
    const piece = board[fromRow][fromCol];
    if (!piece) { socket.emit('invalidMove'); return; }
    const rowDiff = toRow - fromRow;
    const colDiff = Math.abs(toCol - fromCol);
    const isJump = Math.abs(rowDiff) === 2;
    if (isJump) {
      const midRow = (fromRow + toRow) / 2;
      const midCol = (fromCol + toCol) / 2;
      const jumped = board[midRow][midCol];
      if (!jumped || jumped.color === piece.color) { socket.emit('invalidMove'); return; }
      board[midRow][midCol] = null;
    }
    board[toRow][toCol] = piece;
    board[fromRow][fromCol] = null;
    if ((piece.color === 'red' && toRow === 0) || (piece.color === 'black' && toRow === 7)) {
      board[toRow][toCol].king = true;
    }
    room.gameState.turn = room.gameState.turn === 'red' ? 'black' : 'red';
    io.to(roomId).emit('gameState', room.gameState);
    io.to(roomId).emit('moveMade', { fromRow, fromCol, toRow, toCol });
  });

  socket.on('disconnect', () => {
    for (let [roomId, room] of rooms.entries()) {
      const idx = room.players.indexOf(socket.id);
      if (idx !== -1) {
        room.players.splice(idx, 1);
        if (room.players.length === 0) {
          rooms.delete(roomId);
        } else {
          io.to(roomId).emit('opponentLeft');
        }
        break;
      }
    }
  });
});

// ---------- SERVE MULTIPLAYER PAGE ----------
app.get('/multiplayer', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'multiplayer.html'));
});

// ---------- SERVE MAIN SITE ----------
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------- START SERVER ----------
server.listen(PORT, () => {
  console.log(`🚀 Magnar Gaming server running at http://localhost:${PORT}`);
  console.log(`🎮 Multiplayer Checkers at http://localhost:${PORT}/multiplayer`);
});