import express, { type Response } from 'express';
import { Redis } from 'ioredis';
import { User } from './user';
import { MatchmakingService } from './matchmaking-service';
import cors from 'cors'


const PORT = process.env.PORT || 3000;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const MAINTENANCE_MODE = false;


const DISCOVERY_SERVER_URL = process.env.DISCOVERY_SERVER_URL || 'https://animochat-service-discovery.onrender.com/';
const SERVICE_NAME = 'matchmaking-server';
const SERVICE_VERSION = '1.0.0';

// =================================================================================
// --- Service Discovery Registration ---
// =================================================================================

/**
 * Registers the service with the discovery server or sends a heartbeat if already registered.
 * This function is called periodically to keep the service's registration alive.
 */
const registerService = async () => {
    try {
        const response = await fetch(`${DISCOVERY_SERVER_URL}/register`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                serviceName: SERVICE_NAME,
                version: SERVICE_VERSION,
                // The PORT variable should be the one your app is listening on
                port: Number(PORT),
            }),
        });

        if (!response.ok) {
            throw new Error(`Failed to register service. Status: ${response.status}`);
        }
        console.log('Service registered/heartbeat sent successfully to discovery server.');
    } catch (error) {
        console.error('Failed to register service:', (error as Error).message);
    }
};

/**
 * Unregisters the service from the discovery server during a graceful shutdown.
 */
const unregisterService = async () => {
    try {
        await fetch(`${DISCOVERY_SERVER_URL}/unregister`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                serviceName: SERVICE_NAME,
                version: SERVICE_VERSION,
            }),
        });
        console.log('Service unregistered successfully from discovery server.');
    } catch (error) {
        console.error('Failed to unregister service:', (error as Error).message);
    }
};

const app = express();
app.use(express.json());
app.use(cors());

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
 * Implements a simple round-robin strategy to select the next chat server.
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


/**
 * Endpoint to check the status of the matchmaking service.
 * This endpoint returns the current state of the matchmaking service, whether it is under maintenance or operational
 * @return {Response} - Returns a JSON response indicating the state of the service
 */
app.get('/maintenance', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-cache');

    if (MAINTENANCE_MODE) {
        res.status(503).json({ state: 'MAINTENANCE', message: 'The matchmaking service is currently under maintenance. Please try again later.' });
    } else {
        res.status(200).json({ state: 'ACTIVE', message: 'The matchmaking service is operational.' });
    }
});

/**
 * Endpoint for matchmaking.
 * This endpoint handles matchmaking requests and uses Server-Sent Events (SSE) to notify users of matches.
 * @param {string} userId - The ID of the user requesting matchmaking
 * @param {string} interest - A comma-separated list of interests for matchmaking
 * @return {Response} - Returns a stream of match notifications or an error message
 */
app.get('/matchmaking', async (req, res) => {
    // --- Setup Server-Sent Events (SSE) Headers ---
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

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


/**
 * Endpoint to disconnect or end a chat session.
 * A user can call this to terminate their current chat, which will
 * remove the session for both participants.
 * @param {string} userId - The ID of the user initiating the disconnect.
 * @return {Response} - Returns a success or error message.
 */
app.post('/session/disconnect', async (req, res) => {
    const { userId } = req.body;

    if (!userId) {
        return res.status(400).json({ message: 'User ID is required in the request body.' });
    }

    try {
        const wasSessionEnded = await matchmakingService.endChatSession(userId);

        if (wasSessionEnded) {
            console.log(`[API] User '${userId}' successfully disconnected from their session.`);
            res.status(200).json({ message: 'Session disconnected successfully.' });
        } else {
            console.log(`[API] User '${userId}' attempted to disconnect, but no active session was found.`);
            res.status(404).json({ message: 'No active session found to disconnect.' });
        }
    } catch (error) {
        console.error(`[API] An error occurred while disconnecting session for user '${userId}':`, error);
        res.status(500).json({ message: 'Internal Server Error' });
    }
});


/**
 * Endpoint to get the list of interests for a user.
 * This endpoint retrieves the interests of a user from Redis.
 * @param {string} userId - The ID of the user whose interests are being requested
 * @return {Response} - Returns a JSON response with the user's interests or an error message
 */
app.get('/interests/popular', async (req, res) => {
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

/**
 * Endpoint to check if a user has an existing chat session.
 * This is the primary endpoint for clients to use on startup to determine if they should
 * reconnect to a previous chat or start a new matchmaking search.
 * @param {string} userId - The ID of the user to check.
 * @return {Response} - Returns session details (chatId, serverUrl, participants) or a message if not found.
 */
app.get('/session/:userId', async (req, res) => {
    const { userId } = req.params;

    if (!userId) {
        return res.status(400).json({ message: 'User ID is required.' });
    }

    try {
        const sessionDetails = await matchmakingService.getSessionForUser(userId);

        if (sessionDetails) {
            console.log(`[API] Active session found for user '${userId}': ChatID ${sessionDetails.chatId}`);
            res.status(200).json(sessionDetails);
        } else {
            console.log(`[API] No active session found for user '${userId}'.`);
            res.status(200).json({ message: 'No active session found for this user.' });
        }
    } catch (error) {
        console.error(`[API] An error occurred while checking session for user '${userId}':`, error);
        res.status(500).json({ message: 'Internal Server Error' });
    }
});


app.listen(PORT, () => {
    console.log(`Matchmaking server is running on http://localhost:${PORT}`);

    registerService();

    // Then, send a heartbeat every 10 seconds to keep the registration alive
    setInterval(registerService, 10000);
});

process.on('SIGINT', async () => {
    await unregisterService();
    // Give a moment for the unregister call to complete before exiting
    setTimeout(() => process.exit(0), 500);
});
