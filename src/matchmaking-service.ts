
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
    public async findOrQueueUser(userId: string, interests: string[]): Promise<{ matchedUserId: string; interests: string[]; } | null> {
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

                // 3. Since a match is confirmed, clean up all traces of the matched user from the queueing system.
                const cleanupPipeline = this.redis.pipeline();
                matchedUserInterests.forEach(i => {
                    cleanupPipeline.srem(this.getInterestKey(i), potentialMatchId);
                });
                // Also remove their interest list tracking key.
                cleanupPipeline.del(matchedUserInterestsKey);
                await cleanupPipeline.exec();

                console.log(`[Service] Finalized match for '${userId}' with '${potentialMatchId}'. Common interests: [${commonInterests.join(', ')}]`);

                // 4. Return the comprehensive match details.
                return { matchedUserId: potentialMatchId, interests: commonInterests };

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
      * Publishes a match notification to a specific user's channel.
      * @param currentUserId The user who initiated the match.
      * @param matchedUserId The user who was waiting in the queue.
      * @param interests The array of common interests they were matched on.
      */
    public async notifyUserOfMatch(currentUserId: string, matchedUserId: string, interests: string[]): Promise<void> {
        console.log(`[Service] Notifying '${matchedUserId}' about match with '${currentUserId}' on interests [${interests.join(', ')}]`);
        const interest = interests.join(",");
        const payload = JSON.stringify({ state: 'MATCHED', matchedUserId: currentUserId, interest: interest });
        const channel = this.getNotificationChannel(matchedUserId);
        await this.redis.publish(channel, payload);
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
