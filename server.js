require('dotenv').config();
const express = require('express');
const axios = require('axios');
const NodeCache = require('node-cache');
const admin = require('firebase-admin');
const rateLimit = require('express-rate-limit');
const auth = require('basic-auth');
const sgMail = require('@sendgrid/mail');
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
    return forwardedFor ? forwardedFor.split(',')[0].trim() : req.ip;
  },
});

const contactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Too many contact messages from this IP, please try again later.',
  keyGenerator: (req) => {
    const forwardedFor = req.headers['x-forwarded-for'];
    return forwardedFor ? forwardedFor.split(',')[0].trim() : req.ip;
  },
});

// Initialize Firebase Admin SDK
const serviceAccount = require('./clue-analytics-firebase-adminsdk.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://clue-analytics-default-rtdb.firebaseio.com'
});
const db = admin.database();

// Validate API_KEY at startup
const apiKey = process.env.API_KEY;
if (!apiKey) {
  console.error('Error: API_KEY environment variable is not set.');
  process.exit(1);
}

// Configure SendGrid
const sendgridApiKey = process.env.SENDGRID_API_KEY;
if (!sendgridApiKey) {
  console.error('Error: SENDGRID_API_KEY environment variable is not set.');
  process.exit(1);
}
sgMail.setApiKey(sendgridApiKey);

// Admin email for notifications
const adminEmail = process.env.ADMIN_EMAIL;
if (!adminEmail) {
  console.error('Error: ADMIN_EMAIL environment variable is not set.');
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
  if (!url) return res.status(400).json({ error: 'URL parameter is required' });

  const cachedFeed = cache.get(url);
  if (cachedFeed) {
    console.log(`Serving cached feed for ${url}`);
    return res.json(cachedFeed);
  }

  try {
    const response = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ClueAnalyticsBot/1.0)' } });
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
  if (!email || typeof email !== 'string') return res.status(400).json({ error: 'Email is required and must be a string' });

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) return res.status(400).json({ error: 'Invalid email address' });

  try {
    const ref = db.ref('subscribers').push();
    await ref.set({ email, subscribed_at: new Date().toISOString() });
    console.log(`Subscribed email: ${email}`);

    const subscriberMsg = {
      to: email,
      from: 'jinkaproject97@gmail.com', // Replace with your verified sender email
      subject: 'Thank You for Subscribing to Clue Analytics!',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #1d4ed8;">Welcome to Clue Analytics!</h2>
          <p>Thank you for subscribing to our newsletter. We're excited to share the latest insights, updates, and AI/ML solutions with you.</p>
          <p>Stay tuned for expert tips and strategies to transform your business with AI and Machine Learning.</p>
          <p style="margin-top: 20px;"><a href="https://clue-analytics.web.app/" style="background-color: #1d4ed8; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Visit Our Website</a></p>
          <p style="color: #6b7280; font-size: 12px; margin-top: 20px;">If you did not subscribe, please ignore this email or contact us at <a href="mailto:support@clueanalytics.com">support@clueanalytics.com</a>.</p>
        </div>
      `,
    };

    await sgMail.send(subscriberMsg);
    console.log(`Confirmation email sent to ${email}`);
    res.status(200).json({ message: 'Successfully subscribed!' });
  } catch (err) {
    console.error('Error processing subscription:', err.message);
    res.status(500).json({ error: 'Failed to subscribe' });
  }
});

// Endpoint to handle contact form submissions
app.post('/contact', contactLimiter, async (req, res) => {
  const { name, email, message } = req.body;
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'Name is required and must be a string' });
  if (!email || typeof email !== 'string') return res.status(400).json({ error: 'Email is required and must be a string' });
  if (!message || typeof message !== 'string') return res.status(400).json({ error: 'Message is required and must be a string' });

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) return res.status(400).json({ error: 'Invalid email address' });

  try {
    const ref = db.ref('messages').push();
    await ref.set({ name, email, message, sent_at: new Date().toISOString() });
    console.log(`Message sent from ${name} (${email}): ${message}`);

    const adminMsg = {
      to: adminEmail,
      from: 'jinkaproject97@gmail.com', // Replace with your verified sender email
      subject: 'New Contact Message from Clue Analytics',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #1d4ed8;">New Contact Message</h2>
          <p><strong>Name:</strong> ${name}</p>
          <p><strong>Email:</strong> ${email}</p>
          <p><strong>Message:</strong> ${message}</p>
          <p style="margin-top: 20px;"><a href="https://clue-analytics.web.app/#/admin" style="background-color: #1d4ed8; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">View in Admin Dashboard</a></p>
        </div>
      `,
    };

    await sgMail.send(adminMsg);
    console.log(`Notification email sent to admin (${adminEmail}) for message from ${name}`);
    res.status(200).json({ message: 'Message sent successfully!' });
  } catch (err) {
    console.error('Error processing message:', err.message);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Endpoint to retrieve subscribers (secured)
app.get('/subscribers', authenticate, async (req, res) => {
  try {
    const snapshot = await db.ref('subscribers').once('value');
    const subscribers = snapshot.val() ? Object.entries(snapshot.val()).map(([id, data]) => ({ id, ...data })) : [];
    res.json(subscribers);
  } catch (err) {
    console.error('Error retrieving subscribers:', err.message);
    res.status(500).json({ error: 'Failed to retrieve subscribers' });
  }
});

// Endpoint to retrieve messages (secured)
app.get('/messages', authenticate, async (req, res) => {
  try {
    const snapshot = await db.ref('messages').once('value');
    const messages = snapshot.val() ? Object.entries(snapshot.val()).map(([id, data]) => ({ id, ...data })) : [];
    res.json(messages);
  } catch (err) {
    console.error('Error retrieving messages:', err.message);
    res.status(500).json({ error: 'Failed to retrieve messages' });
  }
});

// Start the server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
});
