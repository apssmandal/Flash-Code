/** Session/UI value types shared by the session layer and host controllers. */

export interface Attachment {
  type: 'file' | 'image';
  name?: string;
  ext?: string;
  content?: string;
  mime?: string;
  data?: string;
}

/** One turn in the UI-facing transcript (distinct from provider ChatMessage). */
export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
  attachments?: Attachment[];
}

/** An entry in the saved-session index shown in the sidebar. */
export interface SessionInfo {
  id: string;
  title: string;
  date: string;
  count: number;
}
