
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

    private getPopularityKey(interest: string): string {
        return `popular:${interest.toUpperCase()}`;
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
    public async findOrQueueUser(userId: string, interests: string[]): Promise<{ matchedUserId: string; interest: string; } | null> {
        const pipeline = this.redis.pipeline();
        const now = Date.now();

        // Record usage for popularity tracking
        interests.forEach(interest => {
            const popularityKey = this.getPopularityKey(interest);
            // Add a unique member to the sorted set with the current timestamp as the score.
            pipeline.zadd(popularityKey, now, userId);
        });

        await pipeline.exec();

        const shuffledInterests = interests.sort(() => Math.random() - 0.5);
        // Try to find a match in any of the user's interest queues
        for (const interest of shuffledInterests) {
            const interestKey = this.getInterestKey(interest);
            const potentialMatchId = await this.redis.spop(interestKey);

            if (potentialMatchId && potentialMatchId !== userId) {
                console.log(`[Service] User '${userId}' matched with '${potentialMatchId}' on interest '${interest}'`);
                // A match was found, return it immediately.
                return { matchedUserId: potentialMatchId, interest };
            } else if (potentialMatchId) {
                // If we popped our own ID, add it back to the set.
                await this.redis.sadd(interestKey, potentialMatchId);
            }
        }

        // --- NO MATCH FOUND ---
        // Add the user to all their specified interest queues to wait for a match.
        console.log(`[Service] No match for '${userId}'. Adding to queues for interests: [${interests.join(', ')}].`);
        const queueingPipeline = this.redis.pipeline();
        interests.forEach(interest => {
            const interestKey = this.getInterestKey(interest);
            queueingPipeline.sadd(interestKey, userId);
        });
        await queueingPipeline.exec();

        return null; // Indicates that the user is now waiting.
    }

    /**
     * Publishes a match notification to a specific user's channel, including the matched interest.
     * @param currentUserId The user who initiated the match.
     * @param matchedUserId The user who was waiting in the queue.
     * @param interest The common interest they were matched on.
     */
    public async notifyUserOfMatch(currentUserId: string, matchedUserId: string, interest: string): Promise<void> {
        console.log(`[Service] Notifying '${matchedUserId}' about match with '${currentUserId}' on interest '${interest}'`);
        const payload = JSON.stringify({ state: 'MATCHED', matchedUserId: currentUserId, interest: interest });
        const channel = this.getNotificationChannel(matchedUserId);
        await this.redis.publish(channel, payload);
    }

    /**
     * Removes a user from the waiting queues for all their specified interests.
     * @param userId The user's ID.
     * @param interests The array of interests the user was waiting in.
     */
    public async removeUserFromQueue(userId: string, interests: string[]): Promise<void> {
        if (!interests || interests.length === 0) return;

        console.log(`[Service] Removing user '${userId}' from queues for interests: [${interests.join(', ')}].`);
        const pipeline = this.redis.pipeline();
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
