const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET_KEY = process.env.SECRET_KEY || 'a_strong_random_secret_key_change_me';

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ---------- Database (using new built-in module) ----------
const db = new DatabaseSync('./magnar.db');

// Create tables (using exec for multiple statements)
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    email TEXT UNIQUE,
    password TEXT,
    plan TEXT DEFAULT 'free',
    chips INTEGER DEFAULT 0,
    total_winnings INTEGER DEFAULT 0,
    tournaments_played INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS tournaments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    game TEXT,
    prize_pool INTEGER,
    max_players INTEGER,
    current_players INTEGER DEFAULT 1,
    entry_fee INTEGER,
    status TEXT DEFAULT 'open',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS tournament_participants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tournament_id INTEGER,
    user_id INTEGER,
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

console.log('✅ Database initialized');

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

// ---------- Sample tournaments ----------
function addSampleTournaments() {
  const count = db.prepare('SELECT COUNT(*) as count FROM tournaments').get();
  if (count.count === 0) {
    const samples = [
      { name: 'Checkers Championship', game: 'checkers', prize_pool: 2500, max_players: 32, entry_fee: 50 },
      { name: '8‑Ball Pool Masters', game: 'pool', prize_pool: 5000, max_players: 16, entry_fee: 100 },
      { name: 'Racing Grand Prix', game: 'racing', prize_pool: 3000, max_players: 12, entry_fee: 75 }
    ];
    const insert = db.prepare(`INSERT INTO tournaments (name, game, prize_pool, max_players, entry_fee) VALUES (?, ?, ?, ?, ?)`);
    for (const t of samples) {
      insert.run(t.name, t.game, t.prize_pool, t.max_players, t.entry_fee);
    }
    console.log('🏆 Sample tournaments added');
  }
}
addSampleTournaments();

// ---------- Auth routes ----------
app.post('/api/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: 'All fields required' });
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const insert = db.prepare(`INSERT INTO users (username, email, password) VALUES (?, ?, ?)`);
    const info = insert.run(username, email, hashedPassword);
    const token = generateToken({ id: info.lastInsertRowid, username });
    res.json({
      token,
      user: {
        id: info.lastInsertRowid,
        username,
        email,
        chips: 0,
        total_winnings: 0,
        tournaments_played: 0
      }
    });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'Username or email already exists' });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const user = db.prepare(`SELECT * FROM users WHERE email = ?`).get(email);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const validPassword = await bcrypt.compare(password, user.password);
  if (!validPassword) return res.status(401).json({ error: 'Invalid credentials' });
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

app.get('/api/user', verifyToken, (req, res) => {
  const user = db.prepare(`SELECT id, username, email, plan, chips, total_winnings, tournaments_played FROM users WHERE id = ?`).get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

app.get('/api/tournaments', (req, res) => {
  const tournaments = db.prepare(`SELECT * FROM tournaments WHERE status = 'open'`).all();
  res.json(tournaments || []);
});

// ---------- Health check endpoint (for Render) ----------
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// ---------- Main site fallback ----------
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------- Start server ----------
app.listen(PORT, () => {
  console.log(`🚀 Magnar Gaming server running on port ${PORT}`);
});