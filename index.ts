import express, { type Request, type Response } from 'express';
import { ExpressPeerServer } from 'peer';
import Redis from 'ioredis';
import http from 'http';
import path from 'path';

const app = express();
const server = http.createServer(app);
const port = process.env.PORT || 9000;

// Initialize Redis client
const redis = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
});
redis.on('error', (err) => console.log('Redis Client Error', err));

// A simple in-memory store for active SSE client connections
const clients: { [key: string]: Response } = {};

// Middleware and Static Files
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));


const peerServer = ExpressPeerServer(server);
// Mount the PeerJS server on '/peerjs'
app.use('/peerjs', peerServer);
// ==========================================


// Server-Sent Events endpoint
app.get('/events/:peerId', (req: Request, res: Response) => {
    const { peerId } = req.params;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    if (!peerId) {
        return res.status(400).send({ message: 'peerId is required' });
    }

    clients[peerId] = res;
    console.log(`Client connected for SSE: ${peerId}`);

    req.on('close', () => {
        console.log(`Client disconnected from SSE: ${peerId}`);
        delete clients[peerId];
        res.end();
    });
});

function sendEventToPeer(peerId: string, data: object) {
    const client = clients[peerId];
    if (client) {
        client.write(`event: matched\n`);
        client.write(`data: ${JSON.stringify(data)}\n\n`);
        console.log(`Sent match event to ${peerId}`);
    }
}

// Matchmaking logic
app.post('/matchmake', async (req: Request, res: Response) => {
    const { peerId, tag } = req.body;
    if (!peerId || !tag) {
        return res.status(400).send({ message: 'peerId and tag are required' });
    }

    const waitingPeerKey = `waiting:${tag}`;
    try {
        const waitingPeer = await redis.spop(waitingPeerKey);

        if (waitingPeer && waitingPeer !== peerId) {
            const roomId = `room:${Date.now()}:${Math.random()}`;
            await redis.sadd(roomId, peerId, waitingPeer);
            console.log(`Matched ${peerId} with ${waitingPeer} in tag #${tag}`);
            sendEventToPeer(waitingPeer, { matchedPeerId: peerId });
            res.status(200).send({ matchedPeerId: waitingPeer });
        } else {
            await redis.sadd(waitingPeerKey, peerId);
            res.status(202).send({ message: 'Waiting for a match...' });
        }
    } catch (error) {
        console.error('Matchmaking error:', error);
        res.status(500).send({ message: 'Internal server error' });
    }
});

peerServer.on('disconnect', async (client) => {
    const peerId = client.getId();
    console.log(`Peer disconnected: ${peerId}. Cleaning up waiting lists...`);
    const stream = redis.scanStream({ match: 'waiting:*' });
    stream.on('data', async (keys: string[]) => {
        if (keys.length) {
            const pipeline = redis.pipeline();
            keys.forEach(key => pipeline.srem(key, peerId));
            await pipeline.exec();
        }
    });
    stream.on('end', () => console.log(`Finished cleanup for ${peerId}`));
});

app.get('/', (req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});