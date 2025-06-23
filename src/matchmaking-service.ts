
// =================================================================================
// --- Matchmaking Service ---
// This class encapsulates all business logic for matchmaking.
// It is unaware of HTTP requests or responses, making it reusable and testable.

import type Redis from "ioredis";

// =================================================================================
export class MatchmakingService {
    private redis: Redis;

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
     * Attempts to find an available user in the queue for a given interest.
     * If a match is found, their ID is returned.
     * If not, the current user is added to the queue and null is returned.
     * @param userId The ID of the user searching for a match.
     * @param interest The interest to match on.
     * @returns The matched user's ID, or null if the user was added to the queue.
     */
    public async findOrQueueUser(userId: string, interest: string): Promise<string | null> {
        const interestKey = this.getInterestKey(interest);

        // SPOP atomically finds and removes a random member from the set.
        const potentialMatchId = await this.redis.spop(interestKey);

        if (potentialMatchId && potentialMatchId !== userId) {
            // --- MATCH FOUND ---
            console.log(`[Service] User '${userId}' matched with '${potentialMatchId}'`);
            return potentialMatchId;
        } else {
            // --- NO MATCH FOUND ---
            if (potentialMatchId) {
                // This can happen if we pop our own ID from a previous, unclean shutdown.
                // We add it back to the set so it can be matched with someone else.
                await this.redis.sadd(interestKey, potentialMatchId);
            }

            console.log(`[Service] No match for '${userId}'. Adding to queue for interest "${interest}".`);
            // Add the current user to the waiting pool.
            await this.redis.sadd(interestKey, userId);

            return null; // Indicates that the user is now waiting.
        }
    }

    /**
     * Publishes a match notification to a specific user's channel.
     * @param currentUserId The user who initiated the match.
     * @param matchedUserId The user who was waiting in the queue.
     */
    public async notifyUserOfMatch(currentUserId: string, matchedUserId: string): Promise<void> {
        console.log(`[Service] Notifying '${matchedUserId}' about match with '${currentUserId}'`);
        const payload = JSON.stringify({ state: 'MATCHED', matchedUserId: currentUserId });
        const channel = this.getNotificationChannel(matchedUserId);
        await this.redis.publish(channel, payload);
    }

    /**
     * Removes a user from the waiting queue for a specific interest.
     * This is used for cleanup when a client disconnects.
     * @param userId The user's ID.
     * @param interest The user's interest.
     */
    public async removeUserFromQueue(userId: string, interest: string): Promise<void> {
        console.log(`[Service] Removing user '${userId}' from queue for interest '${interest}'.`);
        const interestKey = this.getInterestKey(interest);
        await this.redis.srem(interestKey, userId);
    }

    /**
    * Finds the most popular interests based on the number of users waiting in each queue.
    * @param topN The number of top interests to return.
    * @returns A promise that resolves to an array of popular interests with their counts.
    */
    public async getPopularInterests(topN: number): Promise<{ interest: string; count: number }[]> {
        console.log(`[Service] Fetching top ${topN} popular interests.`);
        const pattern = 'interest:*';
        const allInterestKeys: string[] = [];
        let cursor = '0';

        // Use SCAN to safely iterate over keys without blocking the database.
        do {
            const [newCursor, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
            allInterestKeys.push(...keys);
            cursor = newCursor;
        } while (cursor !== '0');

        if (allInterestKeys.length === 0) {
            return [];
        }

        // Use a pipeline to get the size (cardinality) of all sets efficiently.
        const pipeline = this.redis.multi();
        allInterestKeys.forEach(key => pipeline.scard(key));
        const results = await pipeline.exec();

        if (!results) {
            return [];
        }

        const interestsWithCounts = allInterestKeys.map((key, index) => {
            const countResult = results[index];
            // Pipeline results are tuples of [error, value]
            if (countResult && countResult[0]) {
                console.error(`[Service] Error getting size for key ${key}:`, countResult[0]);
                return { interest: key.split(':')[1] || 'UNKNOWN', count: 0 };
            }
            return {
                interest: key.split(':')[1] || 'UNKNOWN',
                count: countResult![1] as number,
            };
        });

        // Sort by count descending and return the top N.
        return interestsWithCounts
            .sort((a, b) => b.count - a.count)
            .slice(0, topN);
    }
}
