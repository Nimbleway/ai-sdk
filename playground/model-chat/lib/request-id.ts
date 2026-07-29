export const CHAT_REQUEST_ID_HEADER = 'x-chat-request-id';

export function newChatRequestId(): string {
  return crypto.randomUUID();
}
