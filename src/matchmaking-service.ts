
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

    private getNextChatServer: () => string;


    constructor(redis: Redis, getNextChatServer: () => string) {
        this.redis = redis;
        this.getNextChatServer = getNextChatServer;
    }

    private getInterestKey(interest: string): string {
        return `interest:${interest.toUpperCase()}`;
    }

    private getPopularityKey(interest: string): string {
        return `popular:${interest.toUpperCase()}`;
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
       * If a match is found, the matched user's ID and the common interest are returned.
       * If not, the current user is added to all relevant queues.
       * This method also records each interest usage for popularity tracking.
       * @param userId The ID of the user searching for a match.
       * @param interests An array of interests to match on.
       * @returns A promise that resolves to an object with the matched user's ID and the matched interest, or null.
       */
    public async findOrQueueUser(userId: string, interests: string[]): Promise<{ matchedUserId: string; interests: string[]; chatId: string; chatServerUrl: string; } | null> {
        // End any previous chat session the user was in ---
        const userSessionKey = this.getUserSessionKey(userId);
        const oldChatId = await this.redis.get(userSessionKey);

        if (oldChatId) {
            const oldChatSessionKey = this.getChatSessionKey(oldChatId);
            const oldSessionDataJSON = await this.redis.get(oldChatSessionKey);
            if (oldSessionDataJSON) {
                // We found the old session details.
                const oldSessionData = JSON.parse(oldSessionDataJSON);
                const participants: string[] = oldSessionData.participants || [];

                // Clean up the old session and all user mappings to it.
                const cleanupPipeline = this.redis.pipeline();
                cleanupPipeline.del(oldChatSessionKey);
                participants.forEach(participantId => {
                    cleanupPipeline.del(this.getUserSessionKey(participantId));
                });
                await cleanupPipeline.exec();
                console.log(`[Service] User '${userId}' started a new search, ending their previous chat session '${oldChatId}'.`);
            }
        }

        const pipeline = this.redis.pipeline();
        const now = Date.now();

        interests.forEach(interest => {
            pipeline.zadd(this.getPopularityKey(interest), now, userId);
        });
        await pipeline.exec();

        const shuffledInterests = interests.sort(() => Math.random() - 0.5);

        for (const interest of shuffledInterests) {
            const interestKey = this.getInterestKey(interest);
            // Atomically pop a potential match from one of the interest queues.
            const potentialMatchId = await this.redis.spop(interestKey);

            if (potentialMatchId && potentialMatchId !== userId) {
                // --- MATCH FOUND ---
                console.log(`[Service] User '${userId}' got an initial match with '${potentialMatchId}' on interest '${interest}'`);

                // 1. Get the matched user's full list of interests from Redis.
                const matchedUserInterestsKey = this.getUserInterestsKey(potentialMatchId);
                const matchedUserInterests = await this.redis.smembers(matchedUserInterestsKey);

                // 2. Find all common interests by calculating the intersection of the two lists.
                const currentUserInterestsSet = new Set(interests);
                const commonInterests = matchedUserInterests.filter(i => currentUserInterestsSet.has(i));

                // This is a safety check. If the data is consistent, this should not be empty.
                if (commonInterests.length === 0) {
                    // If something went wrong and there are no common interests, put the user back and continue searching.
                    await this.redis.sadd(interestKey, potentialMatchId);
                    continue;
                }

                // Create a consistent, unique chatId by sorting the user IDs alphabetically and hashing them.
                // This ensures that for any pair (A, B), the chatId is the same regardless of who initiated the match.
                const ids = [userId, potentialMatchId].sort();
                const chatId = createHash('sha1').update(ids.join('-')).digest('hex');

                const chatServerUrl = this.getNextChatServer();

                await this.storeChatSession(chatId, chatServerUrl, [userId, potentialMatchId]);

                // 3. Since a match is confirmed, clean up all traces of the matched user from the queueing system.
                const cleanupPipeline = this.redis.pipeline();
                matchedUserInterests.forEach(i => {
                    cleanupPipeline.srem(this.getInterestKey(i), potentialMatchId);
                });
                // Also remove their interest list tracking key.
                cleanupPipeline.del(matchedUserInterestsKey);
                await cleanupPipeline.exec();

                console.log(`[Service] Finalized match for '${userId}' with '${potentialMatchId}'. ChatID: ${chatId}. Common interests: [${commonInterests.join(', ')}]`);

                return { matchedUserId: potentialMatchId, interests: commonInterests, chatId, chatServerUrl };

            } else if (potentialMatchId) {
                // We popped our own ID by chance, put it back into the set.
                await this.redis.sadd(interestKey, potentialMatchId);
            }
        }

        // --- NO MATCH FOUND ---
        // Add the user to all their specified interest queues to wait for a match.
        console.log(`[Service] No match for '${userId}'. Adding to queues for interests: [${interests.join(', ')}].`);
        const queueingPipeline = this.redis.pipeline();

        interests.forEach(interest => {
            queueingPipeline.sadd(this.getInterestKey(interest), userId);
        });

        if (interests.length > 0) {
            const userInterestsKey = this.getUserInterestsKey(userId);
            queueingPipeline.sadd(userInterestsKey, ...interests);
        }

        await queueingPipeline.exec();

        return null; // Indicates that the user is now waiting.
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
     * Removes a user from all waiting queues for their specified interests.
     * This is used when a user cancels their search.
     * @param userId The user's ID.
     * @param interests The array of interests the user was waiting in.
     */
    public async removeUserFromQueue(userId: string, interests: string[]): Promise<void> {
        if (!interests || interests.length === 0) return;

        console.log(`[Service] Removing user '${userId}' from queues for interests: [${interests.join(', ')}].`);
        const pipeline = this.redis.pipeline();
        interests.forEach(interest => {
            pipeline.srem(this.getInterestKey(interest), userId);
        });
        pipeline.del(this.getUserInterestsKey(userId));
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
