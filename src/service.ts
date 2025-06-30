import { type Express } from 'express';
import type Redis from 'ioredis';
import os from 'os';

// =================================================================================
// --- Service Discovery Registration ---
// =================================================================================


export const DISCOVERY_SERVER_URL = process.env.DISCOVERY_SERVER_URL || 'https://animochat-service-discovery.onrender.com/';
export const SERVICE_NAME = 'matchmaking-server';
export const SERVICE_VERSION = '1.0.0';

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
                url: process.env.RENDER_EXTERNAL_URL!
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

export function addStatusEndpoint(redis: Redis, subscriber: Redis, isMaintenance: boolean, app: Express) {
    /**
 * Endpoint for comprehensive server status.
 * This endpoint returns a detailed status report including service state,
 * Redis connectivity, and key metrics like queue length and active sessions.
 * @return {Response} - A JSON object with detailed server status.
 */
    app.get('/status', async (req, res) => {
        /**
     * Formats bytes into a human-readable string (KB, MB, GB).
     * @param {number} bytes - The number of bytes.
     * @returns {string} A formatted string.
     */
        const formatBytes = (bytes: number) => {
            if (bytes === 0) return '0 Bytes';
            const k = 1024;
            const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
        };

        /**
         * Formats uptime in seconds into a human-readable string (d h m s).
         * @param {number} seconds - The total seconds of uptime.
         * @returns {string} A formatted string.
         */
        const formatUptime = (seconds: number) => {
            const d = Math.floor(seconds / (3600 * 24));
            const h = Math.floor(seconds % (3600 * 24) / 3600);
            const m = Math.floor(seconds % 3600 / 60);
            const s = Math.floor(seconds % 60);
            return `${d}d ${h}h ${m}m ${s}s`;
        };

        try {
            // 1. Get the number of unique users waiting in the queue.
            // Each user waiting in the queue has a 'user_interests:<userId>' key storing their interests.
            const waitingUserKeys = await redis.keys('user_interests:*');
            const totalUsersInQueue = waitingUserKeys.length;

            // 2. Get the number of active chat sessions.
            // Each active session has a 'chat_session:<chatId>' key.
            const sessionKeys = await redis.keys('chat_session:*');
            const activeSessions = sessionKeys.length;

            // 3. Get the connection status of both Redis clients.
            const redisStatus = {
                commands: redis.status,
                subscriber: subscriber.status,
            };

            // 4. Determine the overall service state.
            const serviceState = isMaintenance ? 'MAINTENANCE' : 'ACTIVE';
            const memoryUsage = process.memoryUsage();

            // 5. Construct the final status response object.
            const statusReport = {
                serviceState,
                timestamp: new Date().toISOString(),
                redis: redisStatus,
                metrics: {
                    activeSessions,
                    usersInQueue: totalUsersInQueue,
                },
                serviceInfo: {
                    serviceName: SERVICE_NAME,
                    version: SERVICE_VERSION
                },

                uptime: formatUptime(process.uptime()),
                processMemory: {
                    rss: `${formatBytes(memoryUsage.rss)} (Resident Set Size)`,
                    heapTotal: `${formatBytes(memoryUsage.heapTotal)} (Total V8 Heap)`,
                    heapUsed: `${formatBytes(memoryUsage.heapUsed)} (Used V8 Heap)`,
                    external: `${formatBytes(memoryUsage.external)} (C++ Objects)`,
                },
                os: {
                    hostname: os.hostname(),
                    platform: os.platform(),
                    totalMemory: formatBytes(os.totalmem()),
                    freeMemory: formatBytes(os.freemem()),
                    cpuCount: os.cpus().length,
                    loadAverage: os.loadavg(),
                },
                cpuUsage: process.cpuUsage(),
            };

            res.status(200).json(statusReport);

        } catch (error) {
            console.error('[API] An error occurred while fetching server status:', error);
            res.status(500).json({ message: 'Internal Server Error while fetching status.' });
        }
    });
}


// start the service registration process including heartbeat
export async function startServiceRegistration() {
    // Register the service immediately
    await registerService();

    // Set up a heartbeat to keep the service registered
    setInterval(async () => {
        await registerService().catch((error => {
            // Log the error but do not crash the service
            console.error('Heartbeat failed:', (error as Error).message);
        }))
    }, 5 * 60 * 1000); // Every 5 minutes

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
        console.log('Received SIGINT. Unregistering service...');
        await unregisterService();
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        console.log('Received SIGTERM. Unregistering service...');
        await unregisterService();
        process.exit(0);
    });
}