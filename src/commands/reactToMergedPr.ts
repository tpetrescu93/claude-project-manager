import { deleteSlackPost, getSlackPost } from "./slackPostStore";
import { slackAddReaction } from "./slackMcpClient";

export async function reactToMergedPr(rootPath: string): Promise<void> {
    const permalink = getSlackPost(rootPath);
    if (!permalink) { return; }

    try {
        await slackAddReaction(permalink, "merged_purple");
        deleteSlackPost(rootPath);
    } catch {
        // Keep permalink so the merged-PR event can be retried on next poll.
    }
}
