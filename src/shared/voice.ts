export interface VoicePolicy {
  configured: boolean;
  roomCode: string;
  epoch: string;
  canSpeak: boolean;
}

export interface VoiceAccess extends VoicePolicy {
  url: string;
  token: string;
}
