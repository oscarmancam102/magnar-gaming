const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
// Use built‑in node:sqlite (compatible with Node.js 22+)
const { Database, open } = require('node:sqlite').default || require('node:sqlite');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET_KEY = process.env.SECRET_KEY || 'a_strong_random_secret_key_change_me';

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ---------- Global error handler to catch silent crashes ----------
process.on('uncaughtException', (err) => {
  console.error('❌ Unhandled Exception:', err);
  process.exit(1);
});

// ---------- Database ----------
let db;

async function initDB() {
  db = await open({
    filename: './magnar.db',
    driver: Database
  });

  await db.exec(`
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
  await addSampleTournaments();
}

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
async function addSampleTournaments() {
  const count = await db.get(`SELECT COUNT(*) as count FROM tournaments`);
  if (count.count === 0) {
    const samples = [
      { name: 'Checkers Championship', game: 'checkers', prize_pool: 2500, max_players: 32, entry_fee: 50 },
      { name: '8‑Ball Pool Masters', game: 'pool', prize_pool: 5000, max_players: 16, entry_fee: 100 },
      { name: 'Racing Grand Prix', game: 'racing', prize_pool: 3000, max_players: 12, entry_fee: 75 }
    ];
    for (const t of samples) {
      await db.run(
        `INSERT INTO tournaments (name, game, prize_pool, max_players, entry_fee) VALUES (?, ?, ?, ?, ?)`,
        [t.name, t.game, t.prize_pool, t.max_players, t.entry_fee]
      );
    }
    console.log('🏆 Sample tournaments added');
  }
}

// ---------- Auth routes ----------
app.post('/api/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: 'All fields required' });
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await db.run(
      `INSERT INTO users (username, email, password) VALUES (?, ?, ?)`,
      [username, email, hashedPassword]
    );
    const token = generateToken({ id: result.lastID, username });
    res.json({
      token,
      user: {
        id: result.lastID,
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
  const user = await db.get(`SELECT * FROM users WHERE email = ?`, [email]);
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

app.get('/api/user', verifyToken, async (req, res) => {
  const user = await db.get(
    `SELECT id, username, email, plan, chips, total_winnings, tournaments_played FROM users WHERE id = ?`,
    [req.user.id]
  );
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

app.get('/api/tournaments', async (req, res) => {
  const tournaments = await db.all(`SELECT * FROM tournaments WHERE status = 'open'`);
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
async function startServer() {
  await initDB();
  app.listen(PORT, () => {
    console.log(`🚀 Magnar Gaming server running on port ${PORT}`);
  });
}

startServer().catch(err => {
  console.error('❌ Failed to start server:', err);
  process.exit(1);
});