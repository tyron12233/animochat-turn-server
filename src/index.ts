import express, { type Response } from 'express';
import { Redis } from 'ioredis';
import { User } from './user';
import { MatchmakingService } from './matchmaking-service';


const PORT = process.env.PORT || 3000;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const MAINTENANCE_MODE = true;

const app = express();
app.use(express.json());

const redis = new Redis(REDIS_URL);
const subscriber = new Redis(REDIS_URL);

redis.on('connect', () => console.log('Redis client connected for commands.'));
subscriber.on('connect', () => console.log('Redis client connected for subscriptions.'));
redis.on('error', (err) => console.error('Redis command client error', err));
subscriber.on('error', (err) => console.error('Redis subscriber client error', err));

// =================================================================================
const CHAT_SERVER_URLS = [
    "https://animochat-chat-server.onrender.com",
    "https://animochat-chat-server-1.onrender.com"
];
let currentServerIndex = 0;

/**
 * (NEW) Implements a simple round-robin strategy to select the next chat server.
 * This function distributes the load evenly across the available servers.
 * @returns {string} The URL of the next chat server to use.
 */
const getNextChatServer = (): string => {
    const serverUrl = CHAT_SERVER_URLS[currentServerIndex];
    // Move to the next server in the list for the subsequent call.
    currentServerIndex = (currentServerIndex + 1) % CHAT_SERVER_URLS.length;
    return serverUrl!;
};

const matchmakingService = new MatchmakingService(redis, getNextChatServer);



// =================================================================================
// --- Matchmaking API Endpoint ---
// This route handler is now only responsible for managing the HTTP connection.
// =================================================================================
app.get('/matchmaking', async (req, res) => {
    // --- Setup Server-Sent Events (SSE) Headers ---
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*'); // For CORS

    if (MAINTENANCE_MODE) {
        res.status(503).write(`data: ${JSON.stringify({ state: 'MAINTENANCE', message: 'The matchmaking service is currently under maintenance. Please try again later.' })}\n\n`);
        res.end();
        return;
    }

    // --- Validate Input ---
    let { userId, interest } = req.query;
    if (!userId || typeof userId !== 'string') {
        res.status(400).write(`data: ${JSON.stringify({ state: 'ERROR', message: 'userId and interest string query parameters are required' })}\n\n`);
        res.end();
        return;
    }

    const interests = (typeof interest === 'string' && interest.length > 0)
        ? interest.split(',').map(i => i.trim().toUpperCase())
        : ['GLOBAL_CHAT'];

    const notificationChannel = `match_notification:${userId}`;

    // --- SSE Message Handler ---
    // This function will be called when a match notification is published to this user's channel.
    const messageHandler = (channel: string, message: string) => {
        if (channel === notificationChannel) {
            console.log(`[${userId}] Received match notification via Pub/Sub:`, message);
            res.write(`data: ${message}\n\n`);
            cleanup(); // Clean up resources and close connection
            res.end();
        }
    };

    subscriber.subscribe(notificationChannel, (err) => {
        if (err) {
            console.error(`[${userId}] Failed to subscribe to ${notificationChannel}`, err);
            res.status(500).end();
            return;
        }
        console.log(`[${userId}] Subscribed to ${notificationChannel} for match notifications.`);
        subscriber.on('message', messageHandler);
    });


    const cleanup = () => {
        console.log(`[${userId}] Cleaning up SSE resources.`);
        matchmakingService.removeUserFromQueue(userId, interests);
        subscriber.unsubscribe(notificationChannel);
        subscriber.removeListener('message', messageHandler);
    };

    req.on('close', () => {
        console.log(`[${userId}] Connection closed by client.`);
        cleanup();
    });

    // --- Execute Matchmaking Logic using the Service ---
    try {
        const matchResult = await matchmakingService.findOrQueueUser(userId, interests);

        if (matchResult) {
            const { matchedUserId, interests: matchedInterests, chatId, chatServerUrl } = matchResult;

            await matchmakingService.notifyUserOfMatch(userId, matchedUserId, matchedInterests, chatId, chatServerUrl);

            const interestString = matchedInterests.join(',');
            const payload = JSON.stringify({ state: 'MATCHED', matchedUserId, interest: interestString, chatId: chatId, chatServerUrl: chatServerUrl });
            res.write(`data: ${payload}\n\n`);

            cleanup();
            res.end();
        } else {
            res.write(`data: ${JSON.stringify({ state: 'WAITING' })}\n\n`);
        }
    } catch (error) {
        console.error(`[${userId}] An error occurred in the matchmaking route:`, error);
        cleanup();
        res.status(500).end();
    }
});

app.get('/interests/popular', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*'); //

    if (MAINTENANCE_MODE) {
        res.status(503).json({ state: 'MAINTENANCE', message: 'The matchmaking service is currently under maintenance. Please try again later.' });
        return;
    }

    const topN = 8;
    try {
        console.log(`[API] Request received for top ${topN} popular interests.`);
        const popularInterests = await matchmakingService.getPopularInterests(topN);
        res.status(200).json(popularInterests);
    } catch (error) {
        console.error('[API] An error occurred while fetching popular interests:', error);
        res.status(500).json({ message: 'Internal Server Error' });
    }
});


app.listen(PORT, () => {
    console.log(`Matchmaking server is running on http://localhost:${PORT}`);
});
