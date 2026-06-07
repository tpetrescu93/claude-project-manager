import { exec } from "child_process";
import { promisify } from "util";
import { l10n } from "vscode";

const execAsync = promisify(exec);

export async function run(cmd: string, cwd: string): Promise<string> {
    const { stdout } = await execAsync(cmd, { cwd });
    return stdout.trim();
}

export function validateBranchName(value: string): string | undefined {
    if (!value || !value.trim()) {
        return l10n.t("Branch name is required");
    }
    if (/[^a-zA-Z0-9\-_./]/.test(value)) {
        return l10n.t("Invalid characters in branch name");
    }
    return undefined;
}
