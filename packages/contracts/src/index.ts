export interface LivenessResponse {
  status: 'ok';
  service: 'scholarproof-api';
}

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
  };
}

export interface SessionResponse {
  token: string;
  tokenType: 'Bearer';
  expiresAt: string;
}

export interface EvidenceReceipt {
  evidenceId: string;
  state: 'available';
  digestSha256: string;
  sizeBytes: number;
}
