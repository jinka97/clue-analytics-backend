require('dotenv').config();
const express = require('express');
const axios = require('axios');
const NodeCache = require('node-cache');
const sqlite3 = require('sqlite3').verbose();
const rateLimit = require('express-rate-limit');
const auth = require('basic-auth');
const app = express();
const cache = new NodeCache({ stdTTL: 3600 });

app.set('trust proxy', 1);

app.use(express.json());

// Enable CORS for all routes
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  next();
});

// Rate limiting for /subscribe and /contact endpoints
const subscribeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many subscription attempts from this IP, please try again later.',
  keyGenerator: (req) => {
    const forwardedFor = req.headers['x-forwarded-for'];
    if (forwardedFor) {
      const ips = forwardedFor.split(',').map(ip => ip.trim());
      return ips[0];
    }
    return req.ip;
  },
});

const contactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Too many contact messages from this IP, please try again later.',
  keyGenerator: (req) => {
    const forwardedFor = req.headers['x-forwarded-for'];
    if (forwardedFor) {
      const ips = forwardedFor.split(',').map(ip => ip.trim());
      return ips[0];
    }
    return req.ip;
  },
});

// Initialize SQLite database
const db = new sqlite3.Database('./subscribers.db', (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    console.log('Connected to SQLite database.');
    db.run(`
      CREATE TABLE IF NOT EXISTS subscribers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        subscribed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `, (err) => {
      if (err) {
        console.error('Error creating subscribers table:', err.message);
      } else {
        console.log('Subscribers table ready.');
        // Log current subscribers on startup
        db.all('SELECT * FROM subscribers', [], (err, rows) => {
          if (err) {
            console.error('Error fetching subscribers on startup:', err.message);
          } else {
            console.log('Subscribers on startup:', rows);
          }
        });
      }
    });
    db.run(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        message TEXT NOT NULL,
        sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `, (err) => {
      if (err) {
        console.error('Error creating messages table:', err.message);
      } else {
        console.log('Messages table ready.');
        // Log current messages on startup
        db.all('SELECT * FROM messages', [], (err, rows) => {
          if (err) {
            console.error('Error fetching messages on startup:', err.message);
          } else {
            console.log('Messages on startup:', rows);
          }
        });
      }
    });
  }
});

// Validate API_KEY at startup
const apiKey = process.env.API_KEY;
if (!apiKey) {
  console.error('Error: API_KEY environment variable is not set.');
  process.exit(1);
}

// Basic authentication middleware
const authenticate = (req, res, next) => {
  const user = auth(req);
  if (!user || user.name !== 'admin' || user.pass !== apiKey) {
    res.status(401).set('WWW-Authenticate', 'Basic realm="Clue Analytics Admin"');
    return res.json({ error: 'Unauthorized' });
  }
  next();
};

// Endpoint to fetch RSS feed
app.get('/fetch-feed', async (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'URL parameter is required' });
  }

  const cachedFeed = cache.get(url);
  if (cachedFeed) {
    console.log(`Serving cached feed for ${url}`);
    return res.json(cachedFeed);
  }

  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ClueAnalyticsBot/1.0)',
      },
    });
    const feedData = response.data;

    cache.set(url, feedData);
    console.log(`Fetched and cached feed for ${url}`);

    res.send(feedData);
  } catch (err) {
    console.error(`Error fetching feed from ${url}:`, err.message);
    res.status(500).json({ error: `Failed to fetch feed: ${err.message}` });
  }
});

// Endpoint to handle newsletter subscriptions
app.post('/subscribe', subscribeLimiter, async (req, res) => {
  const { email } = req.body;

  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'Email is required and must be a string' });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  try {
    const stmt = db.prepare('INSERT INTO subscribers (email) VALUES (?)');
    stmt.run(email, (err) => {
      if (err) {
        if (err.message.includes('UNIQUE constraint failed')) {
          return res.status(409).json({ error: 'Email already subscribed' });
        }
        console.error('Error inserting email:', err.message);
        return res.status(500).json({ error: 'Failed to subscribe' });
      }
      stmt.finalize();
      console.log(`Subscribed email: ${email}`);
      // Log all subscribers after insertion
      db.all('SELECT * FROM subscribers', [], (err, rows) => {
        if (err) {
          console.error('Error fetching subscribers after insert:', err.message);
        } else {
          console.log('Current subscribers:', rows);
        }
      });
      res.status(200).json({ message: 'Successfully subscribed!' });
    });
  } catch (err) {
    console.error('Error processing subscription:', err.message);
    res.status(500).json({ error: 'Failed to subscribe' });
  }
});

// Endpoint to handle contact form submissions
app.post('/contact', contactLimiter, async (req, res) => {
  const { name, email, message } = req.body;

  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'Name is required and must be a string' });
  }
  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'Email is required and must be a string' });
  }
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'Message is required and must be a string' });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  try {
    const stmt = db.prepare('INSERT INTO messages (name, email, message) VALUES (?, ?, ?)');
    stmt.run(name, email, message, (err) => {
      if (err) {
        console.error('Error inserting message:', err.message);
        return res.status(500).json({ error: 'Failed to send message' });
      }
      stmt.finalize();
      console.log(`Message sent from ${name} (${email}): ${message}`);
      // Log all messages after insertion
      db.all('SELECT * FROM messages', [], (err, rows) => {
        if (err) {
          console.error('Error fetching messages after insert:', err.message);
        } else {
          console.log('Current messages:', rows);
        }
      });
      res.status(200).json({ message: 'Message sent successfully!' });
    });
  } catch (err) {
    console.error('Error processing message:', err.message);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Endpoint to retrieve subscribers (secured)
app.get('/subscribers', authenticate, (req, res) => {
  db.all('SELECT * FROM subscribers ORDER BY subscribed_at DESC', [], (err, rows) => {
    if (err) {
      console.error('Error retrieving subscribers:', err.message);
      return res.status(500).json({ error: 'Failed to retrieve subscribers' });
    }
    res.json(rows);
  });
});

// Endpoint to retrieve messages (secured)
app.get('/messages', authenticate, (req, res) => {
  db.all('SELECT * FROM messages ORDER BY sent_at DESC', [], (err, rows) => {
    if (err) {
      console.error('Error retrieving messages:', err.message);
      return res.status(500).json({ error: 'Failed to retrieve messages' });
    }
    res.json(rows);
  });
});

// Start the server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
});
