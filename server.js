const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 3000;
const SECRET_KEY = process.env.SECRET_KEY || 'your-secret-key-change-it';

// PostgreSQL connection (uses Render's DATABASE_URL env var)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ---------- Helper functions ----------
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

// ---------- Database setup ----------
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE,
        email TEXT UNIQUE,
        password TEXT,
        plan TEXT DEFAULT 'free',
        chips INTEGER DEFAULT 0,
        total_winnings INTEGER DEFAULT 0,
        tournaments_played INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS tournaments (
        id SERIAL PRIMARY KEY,
        name TEXT,
        game TEXT,
        prize_pool INTEGER,
        max_players INTEGER,
        current_players INTEGER DEFAULT 1,
        entry_fee INTEGER,
        status TEXT DEFAULT 'open',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS tournament_participants (
        id SERIAL PRIMARY KEY,
        tournament_id INTEGER,
        user_id INTEGER,
        joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ Database ready');
  } finally {
    client.release();
  }
}

async function addSampleTournaments() {
  const result = await pool.query('SELECT COUNT(*) FROM tournaments');
  if (parseInt(result.rows[0].count) === 0) {
    const samples = [
      ['Checkers Championship', 'checkers', 2500, 32, 50],
      ['8-Ball Pool Masters', 'pool', 5000, 16, 100],
      ['Racing Grand Prix', 'racing', 3000, 12, 75]
    ];
    for (const t of samples) {
      await pool.query(
        `INSERT INTO tournaments (name, game, prize_pool, max_players, entry_fee) VALUES ($1, $2, $3, $4, $5)`,
        t
      );
    }
    console.log('🏆 Sample tournaments added');
  }
}

// ---------- API Routes ----------
app.post('/api/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: 'All fields required' });
  try {
    const hashed = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (username, email, password) VALUES ($1, $2, $3) RETURNING id`,
      [username, email, hashed]
    );
    const token = generateToken({ id: result.rows[0].id, username });
    res.json({ token, user: { id: result.rows[0].id, username, email, chips: 0, total_winnings: 0, tournaments_played: 0 } });
  } catch (err) {
    if (err.constraint === 'users_username_key' || err.constraint === 'users_email_key') {
      return res.status(400).json({ error: 'Username or email already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const result = await pool.query(`SELECT * FROM users WHERE email = $1`, [email]);
  const user = result.rows[0];
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
  const token = generateToken(user);
  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      chips: user.chips || 0,
      total_winnings: user.total_winnings || 0,
      tournaments_played: user.tournaments_played || 0
    }
  });
});

app.get('/api/user', verifyToken, async (req, res) => {
  const result = await pool.query(
    `SELECT id, username, email, plan, chips, total_winnings, tournaments_played FROM users WHERE id = $1`,
    [req.user.id]
  );
  const user = result.rows[0];
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

app.get('/api/tournaments', async (req, res) => {
  const result = await pool.query(`SELECT * FROM tournaments WHERE status = 'open'`);
  res.json(result.rows);
});

// Health check
app.get('/health', (req, res) => res.status(200).send('OK'));

// ---------- Socket.IO (multiplayer) ----------
// Keep your existing room/move handlers here (if any)
// If you don't have them yet, that's fine – we'll add later.

// ---------- Catch‑all: serve index.html for any other route ----------
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------- Start server ----------
async function start() {
  await initDB();
  await addSampleTournaments();
  server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});