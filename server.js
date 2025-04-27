const express = require('express');
const axios = require('axios');
const NodeCache = require('node-cache');
const app = express();
const cache = new NodeCache({ stdTTL: 3600 }); // Cache for 1 hour

app.use(express.json());

// Middleware to enable CORS for all routes
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// Endpoint to fetch RSS feed
app.get('/fetch-feed', async (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'URL parameter is required' });
  }

  // Check if the feed is in the cache
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

    // Cache the feed data
    cache.set(url, feedData);
    console.log(`Fetched and cached feed for ${url}`);

    res.send(feedData);
  } catch (err) {
    console.error(`Error fetching feed from ${url}:`, err.message);
    res.status(500).json({ error: `Failed to fetch feed: ${err.message}` });
  }
});

// Start the server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
});
