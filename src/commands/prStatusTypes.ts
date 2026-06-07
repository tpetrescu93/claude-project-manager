export type PrStatus = "open_passing" | "open_posted" | "open_approved" | "changes_requested" | "open_failing" | "open_pending" | "open_conflicting" | "merged" | "no_pr" | null;

export interface PrMeta {
    number: number;
    title: string;
    author: string;               // GitHub login of the PR author
    updatedAt: string;            // ISO timestamp of the PR's last update
    additions: number;
    deletions: number;
    changedFiles: number;
    unresolvedThreads: number;
    totalThreads: number;
    mergeable: string;            // MERGEABLE | CONFLICTING | UNKNOWN
    reviewDecision: string | null; // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null
}
