export type PrProvider = 'github' | 'azure-devops';

export interface PrIdentifier {
  provider: PrProvider;
  owner: string; // GitHub: org/user, DevOps: org
  repo: string; // GitHub: repo name, DevOps: repo name
  prNumber: number;
  project?: string; // Azure DevOps only
}

export type CommentStatus = 'active' | 'resolved' | 'won\'t fix' | 'closed' | 'pending';

export interface PrComment {
  id: string;
  author: string;
  body: string;
  status: CommentStatus;
  filePath?: string;
  lineNumber?: number;
  createdAt: string;
  updatedAt?: string;
  replies?: PrComment[];
}

export interface PrInfo {
  title: string;
  description: string;
  author: string;
  url: string;
  sourceBranch: string;
  targetBranch: string;
  status: string;
  comments: PrComment[];
}
