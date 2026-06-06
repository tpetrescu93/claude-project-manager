import { commands, l10n, ProgressLocation, window, workspace } from "vscode";
import { Container } from "../core/container";
import { Providers } from "../sidebar/providers";
import { ProjectNode } from "../sidebar/nodes";
import { getPrUrlForPath, getPrMetaForPath, refreshProjectStatusIcon } from "./projectStatuses";
import { getSlackPost, setSlackPost, deleteSlackPost } from "./slackPostStore";
import { slackPostMessage } from "./slackMcpClient";

function getSlackChannel(): string {
    const id = workspace.getConfiguration("projectManager").get<string>("slackChannelId", "").trim();
    if (!id) { throw new Error("No Slack channel configured. Set projectManager.slackChannelId in VS Code settings."); }
    return id;
}

async function postPrToSlack(node: ProjectNode, providerManager: Providers) {
    const rootPath: string = node?.preview?.path ?? node?.command?.arguments?.[ 0 ];
    if (!rootPath) { return; }

    const url = getPrUrlForPath(rootPath);
    if (!url) {
        window.showWarningMessage(l10n.t("No open PR for this project."));
        return;
    }

    const confirmed = await window.showWarningMessage(
        l10n.t("Post this PR to Slack?\n\n{0}", url),
        { modal: true },
        l10n.t("Post")
    );
    if (!confirmed) { return; }

    await window.withProgress({
        location: ProgressLocation.Notification,
        title: l10n.t("Posting PR to Slack..."),
        cancellable: false,
    }, async () => {
        try {
            const meta = getPrMetaForPath(rootPath);
            if (!meta?.title) {
                throw new Error("PR title not available.");
            }
            const linkText = meta.title;
            const result = await slackPostMessage(getSlackChannel(), `<${url}|${linkText}>`, { unfurlLinks: false });
            setSlackPost(rootPath, result.permalink);
            refreshProjectStatusIcon(rootPath, providerManager);
            window.showInformationMessage(l10n.t("Posted to Slack."));
        } catch (error) {
            window.showErrorMessage(l10n.t("Failed to post to Slack: {0}", error.message));
        }
    });
}

async function attachSlackPost(node: ProjectNode, providerManager: Providers) {
    const rootPath: string = node?.preview?.path ?? node?.command?.arguments?.[ 0 ];
    if (!rootPath) { return; }
    const permalink = await window.showInputBox({
        prompt: l10n.t("Paste the Slack message permalink"),
        placeHolder: "https://wagestream.slack.com/archives/C.../p...",
        validateInput: (v) => (v && /^https?:\/\//.test(v.trim())) ? undefined : l10n.t("Must be a valid URL"),
    });
    if (!permalink || !permalink.trim()) { return; }
    setSlackPost(rootPath, permalink.trim());
    refreshProjectStatusIcon(rootPath, providerManager);
}

async function removeSlackPost(node: ProjectNode, providerManager: Providers) {
    const rootPath: string = node?.preview?.path ?? node?.command?.arguments?.[ 0 ];
    if (!rootPath) { return; }
    if (!getSlackPost(rootPath)) {
        window.showInformationMessage(l10n.t("No Slack link stored for this project."));
        return;
    }
    deleteSlackPost(rootPath);
    refreshProjectStatusIcon(rootPath, providerManager);
}

export function registerPostPrToSlack(providerManager: Providers) {
    Container.context.subscriptions.push(
        commands.registerCommand("_projectManager.postPrToSlack", (node: ProjectNode) => postPrToSlack(node, providerManager)),
        commands.registerCommand("_projectManager.attachSlackPost", (node: ProjectNode) => attachSlackPost(node, providerManager)),
        commands.registerCommand("_projectManager.removeSlackPost", (node: ProjectNode) => removeSlackPost(node, providerManager)),
    );
}
