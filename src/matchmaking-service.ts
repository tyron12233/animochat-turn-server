
// =================================================================================
// --- Matchmaking Service ---
// This class encapsulates all business logic for matchmaking.
// It is unaware of HTTP requests or responses, making it reusable and testable.

import type Redis from "ioredis";

// =================================================================================
export class MatchmakingService {
    private redis: Redis;

    private popularityWindowMs = 10 * 60 * 1000;


    constructor(redis: Redis) {
        this.redis = redis;
    }

    private getInterestKey(interest: string): string {
        return `interest:${interest.toUpperCase()}`;
    }

    private getNotificationChannel(userId: string): string {
        return `match_notification:${userId}`;
    }

    /**
        * Attempts to find a match for a user based on a list of interests.
        * It iterates through each interest and tries to pop a user from the queue.
        * If no match is found, the user is added to all of their interest queues.
        * @param userId The ID of the user searching for a match.
        * @param interests An array of interests to match on.
        * @returns An object with the matched user's ID and the interest they matched on, or null.
        */
    public async findOrQueueUser(userId: string, interests: string[]): Promise<{ matchedUserId: string; interest: string; } | null> {
        // Iterate through the user's interests to find a match
        for (const interest of interests) {
            const interestKey = this.getInterestKey(interest);
            // SPOP atomically finds and removes a random member from the set.
            const potentialMatchId = await this.redis.spop(interestKey);

            if (potentialMatchId && potentialMatchId !== userId) {
                // --- MATCH FOUND ---
                console.log(`[Service] User '${userId}' matched with '${potentialMatchId}' on interest '${interest}'`);
                return { matchedUserId: potentialMatchId, interest };
            }

            // If we popped our own ID from a previous session, put it back.
            if (potentialMatchId === userId) {
                await this.redis.sadd(interestKey, potentialMatchId);
            }
        }

        // --- NO MATCH FOUND ---
        console.log(`[Service] No match for '${userId}'. Adding to queues for interests: [${interests.join(', ')}].`);
        // If no match was found in any of the interests, add the user to all of them.
        const pipeline = this.redis.multi();
        interests.forEach(interest => {
            const interestKey = this.getInterestKey(interest);
            pipeline.sadd(interestKey, userId);
        });
        await pipeline.exec();

        return null; // Indicates that the user is now waiting.
    }

    /**
     * Publishes a match notification to a specific user's channel.
     * The payload now includes the interest they matched on.
     * @param currentUserId The user who initiated the match.
     * @param matchedUserId The user who was waiting in the queue.
     * @param interest The interest they matched on.
     */
    public async notifyUserOfMatch(currentUserId: string, matchedUserId: string, interest: string): Promise<void> {
        console.log(`[Service] Notifying '${matchedUserId}' about match with '${currentUserId}' on interest '${interest}'`);
        const payload = JSON.stringify({ state: 'MATCHED', matchedUserId: currentUserId, interest: interest });
        const channel = this.getNotificationChannel(matchedUserId);
        await this.redis.publish(channel, payload);
    }

    /**
     * Removes a user from all the waiting queues for their specified interests.
     * This is used for cleanup when a client disconnects.
     * @param userId The user's ID.
     * @param interests The array of interests to be removed from.
     */
    public async removeUserFromQueue(userId: string, interests: string[]): Promise<void> {
        if (!interests || interests.length === 0) return;
        console.log(`[Service] Removing user '${userId}' from queues for interests: [${interests.join(', ')}].`);
        const pipeline = this.redis.multi();
        interests.forEach(interest => {
            const interestKey = this.getInterestKey(interest);
            pipeline.srem(interestKey, userId);
        });
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
