import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as util from 'util';
import * as path from 'path';

const execAsync = util.promisify(cp.exec);

export class GitUtils {
    /**
     * Executes a command within the specified working directory.
     */
    private static async runCmd(cmd: string, cwd: string): Promise<string> {
        try {
            const { stdout, stderr } = await execAsync(cmd, { cwd });
            return stdout.trim();
        } catch (error: any) {
            console.error(`Git command failed: ${cmd}`, error);
            throw new Error(error.stderr || error.message || 'Git command failed');
        }
    }

    /**
     * Creates an isolated Git worktree for an agent task.
     * @param cwd The primary workspace root directory.
     * @param taskId The unique ID of the task/agent.
     * @returns The absolute path to the newly created worktree directory.
     */
    public static async createWorktree(cwd: string, taskId: string): Promise<string> {
        const branchName = `flash-agent-${taskId}`;
        const worktreeRelPath = `.flash/worktrees/${taskId}`;
        const worktreeAbsPath = path.join(cwd, '.flash', 'worktrees', taskId);

        // 1. Ensure the current state allows branching off smoothly (create the branch)
        // Check if branch already exists (unlikely given UUID task IDs)
        try {
            await this.runCmd(`git branch ${branchName}`, cwd);
        } catch {
            // Branch might exist or repo has no commits, ignore and let worktree add fail if critical
        }

        // 2. Add the worktree
        await this.runCmd(`git worktree add ${worktreeRelPath} ${branchName}`, cwd);

        return worktreeAbsPath;
    }

    /**
     * Merges the agent's isolated worktree branch back into the main branch.
     * @param cwd The primary workspace root directory.
     * @param taskId The unique ID of the task/agent.
     * @param mainBranch The target branch to merge into (e.g., 'main' or 'master').
     */
    public static async mergeWorktree(cwd: string, taskId: string, mainBranch: string = 'main'): Promise<void> {
        const branchName = `flash-agent-${taskId}`;
        
        try {
            // 1. Merge the agent's branch into the current checked-out branch
            await this.runCmd(`git merge ${branchName}`, cwd);
        } catch (error: any) {
            // If there's a conflict, git merge will fail but leave conflict markers.
            // We surface this to the user to resolve manually.
            vscode.window.showWarningMessage(`Merge conflicts detected from agent task ${taskId}. Please resolve them in your Git panel.`, 'Understood');
            throw error; 
        }
    }

    /**
     * Removes the isolated Git worktree and its associated branch.
     * @param cwd The primary workspace root directory.
     * @param taskId The unique ID of the task/agent.
     */
    public static async removeWorktree(cwd: string, taskId: string): Promise<void> {
        const worktreeRelPath = `.flash/worktrees/${taskId}`;
        const branchName = `flash-agent-${taskId}`;

        // 1. Force remove the worktree
        try {
            await this.runCmd(`git worktree remove ${worktreeRelPath} --force`, cwd);
        } catch (e) {
            console.error(`Failed to remove worktree: ${e}`);
        }

        // 2. Delete the branch
        try {
            await this.runCmd(`git branch -D ${branchName}`, cwd);
        } catch (e) {
            console.error(`Failed to delete branch: ${e}`);
        }
    }
}
