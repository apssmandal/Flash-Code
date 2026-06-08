
export interface Task {
    id: string;
    role: 'Manager' | 'Researcher' | 'Tester' | 'Refactorer';
    description: string;
    status: 'pending' | 'running' | 'done' | 'failed';
    result?: string;
}

export interface SubagentConfig {
    role: string;
    instructions: string;
}