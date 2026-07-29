/**
 * A Container Durable Object name is its stable routing identity, not a release
 * version. Reusing it lets a sleeping instance restart on the newly deployed
 * image without consuming another slot from the one-instance deployment.
 */
export const MODEL_CHAT_INSTANCE_NAME = "model-chat-v1";
