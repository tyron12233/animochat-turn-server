
// =================================================================================
// --- Matchmaking Service ---
// This class encapsulates all business logic for matchmaking.
// It is unaware of HTTP requests or responses, making it reusable and testable.

import type Redis from "ioredis";
import { createHash } from 'crypto';

// =================================================================================
export class MatchmakingService {
    private redis: Redis;

    private popularityWindowMs = 10 * 60 * 1000;

    private getNextChatServer: () => Promise<string>;

    private readonly WILDCARD_INTEREST = 'WILDCARD_ANY';

    constructor(redis: Redis, getNextChatServer: () => Promise<string>) {
        this.redis = redis;
        this.getNextChatServer = getNextChatServer;
    }

    private getInterestKey(interest: string): string {
        return `interest:${interest.toUpperCase()}`;
    }

    private getPopularityKey(interest: string): string {
        return `popular:${interest.toUpperCase()}`;
    }

    private getAllInterestsKey(): string {
        return 'all_interests';
    }

    /**
     * Creates a Redis key for storing chat session information.
     * @param chatId The unique ID of the chat session.
     * @returns The Redis key as a string.
     */
    private getChatSessionKey(chatId: string): string {
        return `chat_session:${chatId}`;
    }

    /**
     * Creates a Redis key to map a user's ID to their current chat session ID.
     * @param userId The user's ID.
     * @returns The Redis key as a string.
     */
    private getUserSessionKey(userId: string): string {
        return `user_session:${userId}`;
    }

    /**
     * (NEW) Creates a Redis key to store a user's full list of interests while they are in the queue.
     * @param userId The user's ID.
     * @returns The Redis key as a string.
     */
    private getUserInterestsKey(userId: string): string {
        return `user_interests:${userId}`;
    }


    private getNotificationChannel(userId: string): string {
        return `match_notification:${userId}`;
    }

    /**
     * Attempts to find a match for a user based on an array of interests.
     * - If interests are provided, it searches those queues and then the wildcard queue.
     * - If no interests are provided (wildcard user), it searches ALL queues.
     * This method also records each interest usage for popularity tracking.
     * @param userId The ID of the user searching for a match.
     * @param interests An array of interests to match on.
     * @returns A promise that resolves to an object with the matched user's ID and the matched interest, or null.
     */
    public async findOrQueueUser(userId: string, interests: string[]): Promise<{ matchedUserId: string; interests: string[]; chatId: string; chatServerUrl: string; } | null> {
        await this.endChatSession(userId);

        const isWildcard = !interests || interests.length === 0;

        if (isWildcard) {
            console.log(`[Service] User '${userId}' is a wildcard search, checking all active queues.`);

            const wildcardKey = this.getInterestKey(this.WILDCARD_INTEREST);
            const potentialWildcardId = await this.redis.spop(wildcardKey);

            if (potentialWildcardId && potentialWildcardId !== userId) {
                console.log(`[Service] Wildcard user '${userId}' matched with another wildcard user '${potentialWildcardId}'.`);

                // Cleanup for the matched wildcard user is simple.
                await this.redis.del(this.getUserInterestsKey(potentialWildcardId));

                const ids = [userId, potentialWildcardId].sort();
                const chatId = createHash('sha1').update(ids.join('-')).digest('hex');
                const chatServerUrl = await this.getNextChatServer();
                await this.storeChatSession(chatId, chatServerUrl, [userId, potentialWildcardId]);

                // Return the match. The interests array is empty as it was a generic match.
                return { matchedUserId: potentialWildcardId, interests: [], chatId, chatServerUrl };
            } else if (potentialWildcardId) {
                await this.redis.sadd(wildcardKey, potentialWildcardId); // We popped ourself, put it back.
            }

            // 2. No wildcard-wildcard match found, so check all other active queues.
            console.log(`[Service] No wildcard-wildcard match for '${userId}', checking other active interest queues.`);
            const allInterests = await this.redis.smembers(this.getAllInterestsKey());
            for (const interest of allInterests) {
                // We already checked the wildcard queue, so skip it in this loop.
                if (interest === this.WILDCARD_INTEREST) continue;

                const interestKey = this.getInterestKey(interest);
                const potentialMatchId = await this.redis.spop(interestKey);

                if (potentialMatchId && potentialMatchId !== userId) {
                    console.log(`[Service] Wildcard user '${userId}' matched with '${potentialMatchId}' from queue '${interest}'.`);
                    const matchedUserInterests = await this.redis.smembers(this.getUserInterestsKey(potentialMatchId));

                    const cleanupPipeline = this.redis.pipeline();
                    matchedUserInterests.forEach(i => cleanupPipeline.srem(this.getInterestKey(i), potentialMatchId));
                    cleanupPipeline.del(this.getUserInterestsKey(potentialMatchId));
                    await cleanupPipeline.exec();

                    const ids = [userId, potentialMatchId].sort();
                    const chatId = createHash('sha1').update(ids.join('-')).digest('hex');
                    const chatServerUrl = await this.getNextChatServer();
                    await this.storeChatSession(chatId, chatServerUrl, [userId, potentialMatchId]);

                    return { matchedUserId: potentialMatchId, interests: [interest], chatId, chatServerUrl };
                } else if (potentialMatchId) {
                    await this.redis.sadd(interestKey, potentialMatchId); // Put self back
                }
            }

            // 3. No match found in any queue, so add user to the wildcard queue.
            console.log(`[Service] No match for wildcard user '${userId}'. Adding to wildcard queue.`);
            const userInterestsKey = this.getUserInterestsKey(userId);
            const pipeline = this.redis.pipeline();
            pipeline.sadd(wildcardKey, userId);
            pipeline.sadd(userInterestsKey, this.WILDCARD_INTEREST); // For cancellation
            pipeline.sadd(this.getAllInterestsKey(), this.WILDCARD_INTEREST); // Ensure wildcard queue is discoverable
            await pipeline.exec();

            return null; // User is now waiting in the wildcard queue.
        } else {
            // --- STANDARD USER LOGIC ---
            const pipeline = this.redis.pipeline();
            const now = Date.now();
            interests.forEach(interest => {
                pipeline.zadd(this.getPopularityKey(interest), now, userId);
                pipeline.sadd(this.getAllInterestsKey(), interest);
            });
            await pipeline.exec();

            const shuffledInterests = interests.sort(() => Math.random() - 0.5);

            // 1. Check own interest queues first
            for (const interest of shuffledInterests) {
                const interestKey = this.getInterestKey(interest);
                const potentialMatchId = await this.redis.spop(interestKey);
                if (potentialMatchId && potentialMatchId !== userId) {
                    console.log(`[Service] User '${userId}' got a direct match with '${potentialMatchId}' on interest '${interest}'`);
                    const matchedUserInterests = await this.redis.smembers(this.getUserInterestsKey(potentialMatchId));
                    const currentUserInterestsSet = new Set(interests);
                    const commonInterests = matchedUserInterests.filter(i => currentUserInterestsSet.has(i));

                    if (commonInterests.length === 0) {
                        await this.redis.sadd(interestKey, potentialMatchId);
                        continue;
                    }

                    const cleanupPipeline = this.redis.pipeline();
                    matchedUserInterests.forEach(i => cleanupPipeline.srem(this.getInterestKey(i), potentialMatchId));
                    cleanupPipeline.del(this.getUserInterestsKey(potentialMatchId));
                    await cleanupPipeline.exec();

                    const ids = [userId, potentialMatchId].sort();
                    const chatId = createHash('sha1').update(ids.join('-')).digest('hex');
                    const chatServerUrl = await this.getNextChatServer();
                    await this.storeChatSession(chatId, chatServerUrl, [userId, potentialMatchId]);

                    return { matchedUserId: potentialMatchId, interests: commonInterests, chatId, chatServerUrl };
                } else if (potentialMatchId) {
                    await this.redis.sadd(interestKey, potentialMatchId); // Put self back
                }
            }

            // 2. No direct match, check for a wildcard user
            const wildcardKey = this.getInterestKey(this.WILDCARD_INTEREST);
            const potentialWildcardId = await this.redis.spop(wildcardKey);
            if (potentialWildcardId && potentialWildcardId !== userId) {
                console.log(`[Service] User '${userId}' matched with wildcard user '${potentialWildcardId}'.`);
                // Matched a wildcard user, cleanup is simple.
                await this.redis.del(this.getUserInterestsKey(potentialWildcardId));

                const ids = [userId, potentialWildcardId].sort();
                const chatId = createHash('sha1').update(ids.join('-')).digest('hex');
                const chatServerUrl = await this.getNextChatServer();
                await this.storeChatSession(chatId, chatServerUrl, [userId, potentialWildcardId]);

                // The context of the chat will be the current user's interests.
                return { matchedUserId: potentialWildcardId, interests: interests, chatId, chatServerUrl };
            } else if (potentialWildcardId) {
                await this.redis.sadd(wildcardKey, potentialWildcardId); // Put self back
            }

            // 3. No match found, add to own interest queues
            console.log(`[Service] No match for '${userId}'. Adding to queues for interests: [${interests.join(', ')}].`);
            const queueingPipeline = this.redis.pipeline();
            interests.forEach(interest => {
                queueingPipeline.sadd(this.getInterestKey(interest), userId);
            });
            queueingPipeline.sadd(this.getUserInterestsKey(userId), ...interests);
            await queueingPipeline.exec();

            return null;
        }
    }

    /**
      * Publishes a match notification, now including the assigned chat server URL.
      * @param chatId The unique identifier for their chat session.
      * @param chatServerUrl The URL of the chat server assigned to this match.
      */
    public async notifyUserOfMatch(currentUserId: string, matchedUserId: string, interests: string[], chatId: string, chatServerUrl: string): Promise<void> {
        console.log(`[Service] Notifying '${matchedUserId}' about match with ChatID '${chatId}' on server '${chatServerUrl}'`);
        const interest = interests.join(",");
        const payload = JSON.stringify({ state: 'MATCHED', matchedUserId: currentUserId, interest, chatId, chatServerUrl });
        await this.redis.publish(this.getNotificationChannel(matchedUserId), payload);
    }

    /**
     * Stores the server URL and participant IDs for a chat session in Redis without an expiration.
     * It also maps each participant's user ID to the chat ID for easy lookup.
     * @param chatId The unique ID of the chat session.
     * @param chatServerUrl The URL of the chat server hosting the session.
     * @param participants An array containing the IDs of the two users in the chat.
     */
    public async storeChatSession(chatId: string, chatServerUrl: string, participants: string[]): Promise<void> {
        const key = this.getChatSessionKey(chatId);
        const sessionData = {
            serverUrl: chatServerUrl,
            participants: participants
        };

        const pipeline = this.redis.pipeline();

        pipeline.set(key, JSON.stringify(sessionData));

        // Map each participant to the chatId so we can find and end the session later.
        participants.forEach(userId => {
            pipeline.set(this.getUserSessionKey(userId), chatId);
        });

        await pipeline.exec();
        console.log(`[Service] Stored persistent chat session '${chatId}' for participants [${participants.join(', ')}].`);
    }

    /**
  * (NEW) Retrieves the active chat session details for a given user ID.
  * @param userId The ID of the user.
  * @returns A promise that resolves to an object containing the chatId, serverUrl, and participants, or null if no active session is found.
  */
    public async getSessionForUser(userId: string): Promise<{ chatId: string; serverUrl: string; participants: string[] } | null> {
        const userSessionKey = this.getUserSessionKey(userId);
        const chatId = await this.redis.get(userSessionKey);

        if (!chatId) {
            return null;

        }
        const chatSessionKey = this.getChatSessionKey(chatId);
        const sessionDataJSON = await this.redis.get(chatSessionKey);

        if (!sessionDataJSON) {
            // Data is inconsistent, the user is mapped to a non-existent session. Clean it up.
            await this.redis.del(userSessionKey);
            return null;
        }

        try {
            const sessionData = JSON.parse(sessionDataJSON);
            return {
                chatId,
                serverUrl: sessionData.serverUrl,
                participants: sessionData.participants
            };
        } catch (error) {
            console.error(`[Service] Error parsing session data for chatId '${chatId}':`, error);
            return null;
        }
    }

    /**
     * Ends a chat session based on a request from one of its participants.
     * It finds the session via the user's ID, then removes the session data
     * and the session mappings for all participants.
     * @param userId The ID of the user initiating the disconnect.
     * @returns A promise that resolves to true if a session was found and deleted, otherwise false.
     */
    public async endChatSession(userId: string): Promise<boolean> {
        const userSessionKey = this.getUserSessionKey(userId);
        const chatId = await this.redis.get(userSessionKey);

        if (!chatId) {
            console.log(`[Service] No active session to disconnect for user '${userId}'.`);
            return false;
        }

        const chatSessionKey = this.getChatSessionKey(chatId);
        const sessionDataJSON = await this.redis.get(chatSessionKey);

        if (!sessionDataJSON) {
            console.log(`[Service] Session data for chat '${chatId}' not found, but user '${userId}' was mapped to it. Cleaning up stale mapping.`);
            await this.redis.del(userSessionKey);
            return false;
        }

        try {
            const sessionData = JSON.parse(sessionDataJSON);
            const participants: string[] = sessionData.participants || [];

            const pipeline = this.redis.pipeline();
            // Delete the main chat session data
            pipeline.del(chatSessionKey);
            // Delete the user-to-session mapping for all participants
            participants.forEach(participantId => {
                pipeline.del(this.getUserSessionKey(participantId));
            });
            await pipeline.exec();

            console.log(`[Service] User '${userId}' ended chat session '${chatId}'. Session and participant mappings removed.`);
            return true;
        } catch (error) {
            console.error(`[Service] Error ending chat session '${chatId}':`, error);
            // Still try to clean up the user's mapping
            await this.redis.del(userSessionKey);
            return false;
        }
    }



    /**
     * Retrieves the chat server URL for a given chat session ID from Redis.
     * @param chatId The ID of the chat session.
     * @returns A promise that resolves to the chat server URL string, or null if not found.
     */
    public async getChatServerForSession(chatId: string): Promise<string | null> {
        const key = this.getChatSessionKey(chatId);
        const sessionDataJSON = await this.redis.get(key);
        if (sessionDataJSON) {
            try {
                const sessionData = JSON.parse(sessionDataJSON);
                return sessionData.serverUrl || null;
            } catch (error) {
                console.error(`[Service] Error parsing session data for chatId '${chatId}':`, error);
                return null;
            }
        }
        return null;
    }


    /**
    * Removes a user from all waiting queues they are in.
    * This is used when a user cancels their search or their connection drops.
    * It looks up the user's interests from Redis instead of requiring them as a parameter.
    * @param userId The user's ID.
    */
    public async removeUserFromQueue(userId: string): Promise<void> {
        const userInterestsKey = this.getUserInterestsKey(userId);
        const interests = await this.redis.smembers(userInterestsKey);

        if (!interests || interests.length === 0) {
            // This can happen if the user was already matched and cleaned up, which is not an error.
            console.log(`[Service] No queued interests found for user '${userId}'. No action needed for queue removal.`);
            return;
        }

        console.log(`[Service] Removing user '${userId}' from queues for discovered interests: [${interests.join(', ')}].`);
        const pipeline = this.redis.pipeline();
        interests.forEach(interest => {
            pipeline.srem(this.getInterestKey(interest), userId);
        });
        // Also remove their interest list tracking key.
        pipeline.del(userInterestsKey);
        await pipeline.exec();
    }

    /**
     * Finds the most popular interests based on usage within a specific time window (e.g., last 10 minutes).
     * @param topN The number of top interests to return.
     * @returns A promise that resolves to an array of popular interests with their recent usage counts.
     */
    public async getPopularInterests(topN: number): Promise<{ interest: string; count: number }[]> {
        console.log(`[Service] Fetching top ${topN} popular interests from the last ${this.popularityWindowMs / 60000} minutes.`);

        // Find all keys that track popularity
        const pattern = 'popular:*';
        let cursor = '0';
        const allPopularityKeys: string[] = [];
        do {
            const [newCursor, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
            allPopularityKeys.push(...keys);
            cursor = newCursor;
        } while (cursor !== '0');

        if (allPopularityKeys.length === 0) {
            return [];
        }

        const pipeline = this.redis.pipeline();
        const minTimestamp = Date.now() - this.popularityWindowMs;

        // For each popularity key, remove old entries and then count the remaining ones.
        allPopularityKeys.forEach(key => {
            // 1. Remove members with a score (timestamp) older than our window.
            pipeline.zremrangebyscore(key, 0, minTimestamp);
            // 2. Count the remaining members in the sorted set.
            pipeline.zcard(key);
        });

        const results = await pipeline.exec();
        if (!results) {
            return [];
        }

        const interestsWithCounts = [];
        for (let i = 0; i < allPopularityKeys.length; i++) {
            // The result for ZCARD is at the (i * 2) + 1 index.
            const countResult = results[(i * 2) + 1];
            if (countResult && countResult[0]) { // Check for errors from the pipeline exec
                console.error(`[Service] Error counting popularity for key ${allPopularityKeys[i]}:`, countResult[0]);
                continue;
            }

            const count = countResult![1] as number;
            // Only include interests that have been active recently.
            if (count > 0) {
                let interestName = 'UNKNOWN';
                if (allPopularityKeys && allPopularityKeys[i]) {
                    const current = allPopularityKeys[i];
                    // Extract the interest name from the key, e.g., "popular:interestName".
                    if (current) {
                        interestName = current.split(':')[1] || 'UNKNOWN';
                    }
                }
                interestsWithCounts.push({ interest: interestName, count });
            }
        }

        // Sort by count descending and return the top N.
        return interestsWithCounts
            .sort((a, b) => b.count - a.count)
            .slice(0, topN);
    }
}
